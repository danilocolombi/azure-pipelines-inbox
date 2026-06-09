import {
  Build,
  TaskResult,
  TimelineRecord,
  TimelineRecordState
} from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { getOrganizationUrl } from '../state/config';
import { shortenBranch } from '../view/treeItems';
import { getRun, getTimeline } from './builds';
import { AzureClient } from './client';
import { getLogLines } from './logs';

/** Identifies one step's log, enough to fetch it and label it. */
export interface LogTarget {
  projectName: string;
  buildId: number;
  logId: number;
  recordId: string;
  stepName: string;
}

export interface CopyResult {
  text: string;
  /** Lines actually included in the copied text. */
  includedLines: number;
  /** Lines in the full log. */
  totalLines: number;
  trimmed: boolean;
}

/** SGR colour codes — same set the webview strips when rendering. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Above this many lines, the AI copy switches to error-focused extraction. */
const AI_MAX_LINES = 2000;
const CONTEXT_BEFORE = 20;
const CONTEXT_AFTER = 5;
const TAIL_LINES = 60;

function stripAnsi(line: string): string {
  return line.replace(ANSI, '');
}

/** Plain copy: the whole log as raw text, ANSI stripped. */
export async function buildPlainCopy(client: AzureClient, t: LogTarget): Promise<CopyResult> {
  const lines = (await getLogLines(client, t.projectName, t.buildId, t.logId, 1)).map(stripAnsi);
  return { text: lines.join('\n'), includedLines: lines.length, totalLines: lines.length, trimmed: false };
}

/** AI copy: a metadata header plus an error-focused, size-bounded slice of the log. */
export async function buildAiCopy(client: AzureClient, t: LogTarget): Promise<CopyResult> {
  const [rawLines, build, timeline] = await Promise.all([
    getLogLines(client, t.projectName, t.buildId, t.logId, 1),
    getRun(client, t.projectName, t.buildId).catch(() => undefined),
    getTimeline(client, t.projectName, t.buildId).catch(() => undefined)
  ]);
  const lines = rawLines.map(stripAnsi);
  const record = timeline?.records?.find((r) => r.id === t.recordId);
  const { kept, trimmed } = trimForAI(lines);

  const header = metadataHeader(t, build, record);
  const intro = trimmed
    ? `Log (errors + surrounding context, trimmed from ${lines.length} lines):`
    : `Log (${lines.length} lines):`;
  const text = `${header}\n\n${intro}\n${fence(kept.join('\n'))}\n`;
  return { text, includedLines: kept.length, totalLines: lines.length, trimmed };
}

/**
 * Keep the whole log when it's small. When it's over budget, extract a window around
 * every `##[error]`/`##[warning]` line plus the tail (where failures usually surface),
 * merge overlapping windows, and mark the gaps. With no structured errors, fall back to
 * head + tail.
 */
// Azure prefixes each log line with an ISO timestamp (e.g. "2026-06-08T19:42:43.110Z ");
// strip it before looking for ##[error]/##[warning] markers.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;
function hasMark(line: string, kind: 'error' | 'warning'): boolean {
  return line.replace(TIMESTAMP, '').startsWith(`##[${kind}]`);
}

function trimForAI(lines: string[]): { kept: string[]; trimmed: boolean } {
  if (lines.length <= AI_MAX_LINES) return { kept: lines, trimmed: false };

  const marks: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (hasMark(lines[i], 'error') || hasMark(lines[i], 'warning')) marks.push(i);
  }

  let ranges: Array<[number, number]>;
  if (marks.length === 0) {
    ranges = [
      [0, 30],
      [Math.max(0, lines.length - (AI_MAX_LINES - 30)), lines.length - 1]
    ];
  } else {
    ranges = marks.map(
      (m) => [Math.max(0, m - CONTEXT_BEFORE), Math.min(lines.length - 1, m + CONTEXT_AFTER)] as [number, number]
    );
    ranges.push([Math.max(0, lines.length - TAIL_LINES), lines.length - 1]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const kept: string[] = [];
  let prevEnd = -1;
  for (const [start, end] of merged) {
    const gap = prevEnd < 0 ? start : start - prevEnd - 1;
    if (gap > 0) kept.push(`[… ${gap} lines omitted …]`);
    for (let i = start; i <= end; i++) kept.push(lines[i]);
    prevEnd = end;
  }
  const trailing = lines.length - 1 - prevEnd;
  if (trailing > 0) kept.push(`[… ${trailing} lines omitted …]`);

  return { kept, trimmed: true };
}

function metadataHeader(t: LogTarget, build: Build | undefined, record: TimelineRecord | undefined): string {
  const out = ['Analyze this Azure DevOps pipeline step log and help me identify the cause of any failures.', ''];
  const defName = build?.definition?.name ?? 'Pipeline';
  const number = build?.buildNumber ?? `${t.buildId}`;
  out.push(`Pipeline: ${defName} #${number}`);
  out.push(`Step: ${record?.name ?? t.stepName}`);
  out.push(`Status: ${stepStatusText(record)}`);
  const branch = shortenBranch(build?.sourceBranch);
  if (branch) out.push(`Branch: ${branch}`);
  out.push(
    `Run: ${getOrganizationUrl()}/${encodeURIComponent(t.projectName)}/_build/results?buildId=${t.buildId}&view=logs`
  );
  return out.join('\n');
}

function stepStatusText(r: TimelineRecord | undefined): string {
  if (!r) return 'Unknown';
  if (r.state === TimelineRecordState.InProgress) return 'In progress';
  if (r.state === TimelineRecordState.Pending) return 'Pending';
  if (r.state !== TimelineRecordState.Completed) return 'Unknown';
  const counts: string[] = [];
  if (r.errorCount) counts.push(`${r.errorCount} error${r.errorCount > 1 ? 's' : ''}`);
  if (r.warningCount) counts.push(`${r.warningCount} warning${r.warningCount > 1 ? 's' : ''}`);
  const base = taskResultText(r.result);
  return counts.length ? `${base} · ${counts.join(', ')}` : base;
}

function taskResultText(result: TaskResult | undefined): string {
  switch (result) {
    case TaskResult.Succeeded:
      return 'Succeeded';
    case TaskResult.SucceededWithIssues:
      return 'Succeeded with issues';
    case TaskResult.Failed:
      return 'Failed';
    case TaskResult.Canceled:
      return 'Canceled';
    case TaskResult.Skipped:
      return 'Skipped';
    case TaskResult.Abandoned:
      return 'Abandoned';
    default:
      return 'Completed';
  }
}

/** Wrap in a fence longer than any backtick run inside the body, so logs can't break out. */
function fence(body: string): string {
  let max = 0;
  let run = 0;
  for (const ch of body) {
    if (ch === '`') max = Math.max(max, ++run);
    else run = 0;
  }
  const ticks = '`'.repeat(Math.max(3, max + 1));
  return `${ticks}log\n${body}\n${ticks}`;
}
