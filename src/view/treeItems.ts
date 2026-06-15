import * as vscode from 'vscode';
import {
  Build,
  BuildDefinitionReference,
  BuildResult,
  BuildStatus,
  TaskResult,
  TimelineRecord,
  TimelineRecordState
} from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { isActiveStatus } from '../azure/builds';
import { PipelineStats } from '../azure/stats';
import { Subscription } from '../state/config';

export type Node = ProjectNode | PipelineNode | RunNode | TimelineRecordNode | MessageNode;

export class ProjectNode extends vscode.TreeItem {
  readonly kind = 'project' as const;
  constructor(
    public readonly subscription: Subscription,
    count?: number
  ) {
    super(subscription.projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'project';
    this.iconPath = new vscode.ThemeIcon('project');
    this.id = `project:${subscription.projectId}`;
    if (typeof count === 'number') this.description = `${count}`;
  }
}

export class PipelineNode extends vscode.TreeItem {
  readonly kind = 'pipeline' as const;
  readonly definitionId: number;
  readonly url: string;

  constructor(
    public readonly projectName: string,
    public readonly definition: BuildDefinitionReference,
    orgUrl: string,
    stats?: PipelineStats
  ) {
    super(definition.name ?? 'Pipeline', vscode.TreeItemCollapsibleState.Collapsed);
    this.definitionId = definition.id ?? 0;
    this.id = `pipeline:${projectName}:${this.definitionId}`;
    this.contextValue = 'pipeline';
    this.url = `${orgUrl}/${encodeURIComponent(projectName)}/_build?definitionId=${this.definitionId}`;

    // `latestBuild` comes back inline from getDefinitions(includeLatestBuilds), so the
    // last-run status is shown without an extra request per pipeline.
    const latest = definition.latestBuild;
    this.iconPath = latest
      ? runIcon(latest)
      : new vscode.ThemeIcon('circle-outline', color('disabledForeground'));
    this.description = latest ? runStatusLabel(latest) : 'no runs yet';
    // No stats yet → leave tooltip undefined so the provider's resolveTreeItem (which is
    // only invoked for undefined tooltips) can fetch them lazily on hover.
    if (stats !== undefined) this.applyStats(stats);
  }

  /** Fill in run-history stats (description suffix + full tooltip) once they're known. */
  applyStats(stats: PipelineStats | undefined): void {
    const latest = this.definition.latestBuild;
    const parts = [latest ? runStatusLabel(latest) : 'no runs yet'];
    if (stats?.typicalMs !== undefined) parts.push(`~${formatDuration(stats.typicalMs)}`);
    if (stats?.passRate !== undefined) parts.push(`${Math.round(stats.passRate * 100)}%`);
    this.description = parts.join(' · ');

    const tip = [this.definition.name ?? 'Pipeline'];
    if (latest) tip.push(`Last run: ${runStatusLabel(latest)}`);
    if (stats?.typicalMs !== undefined) {
      tip.push(`Typical duration: ~${formatDuration(stats.typicalMs)}`);
    }
    if (stats?.passRate !== undefined) {
      tip.push(
        `Pass rate: ${Math.round(stats.passRate * 100)}% over the last ${stats.sampleSize} completed runs`
      );
    }
    if (stats?.lastFailure) tip.push(`Last failure: ${ago(stats.lastFailure)}`);
    this.tooltip = new vscode.MarkdownString(tip.join('\n\n'));
  }
}

export class RunNode extends vscode.TreeItem {
  readonly kind = 'run' as const;
  url = '';
  /** Typical (median) duration of this run's pipeline — shows "running 7m / ~12m" while active. */
  private typicalMs?: number;

  constructor(
    public readonly projectName: string,
    public build: Build,
    private readonly orgUrl: string
  ) {
    super('', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `run:${projectName}:${build.id}`;
    this.apply();
  }

  get buildId(): number {
    return this.build.id ?? 0;
  }

  /** Re-read fields from the current `build` (used after a poll updates status/result). */
  update(build: Build): void {
    this.build = build;
    this.apply();
  }

  /** Set the ETA baseline; returns whether it changed (so callers know to redraw). */
  setTypicalMs(ms: number | undefined): boolean {
    if (this.typicalMs === ms) return false;
    this.typicalMs = ms;
    this.apply();
    return true;
  }

  private apply(): void {
    const b = this.build;
    const defName = b.definition?.name ?? 'Pipeline';
    const number = b.buildNumber ?? `${b.id}`;
    this.label = `${defName} #${number}`;
    const branch = shortenBranch(b.sourceBranch);
    const status = runStatusLabel(b, this.typicalMs);
    this.description = branch ? `${status} · ${branch}` : status;
    this.iconPath = runIcon(b);
    this.contextValue = isActiveStatus(b.status)
      ? 'run.active'
      : b.result === BuildResult.Failed
        ? 'run.failed'
        : 'run';
    this.url = `${this.orgUrl}/${encodeURIComponent(this.projectName)}/_build/results?buildId=${b.id}`;

    const tip: string[] = [`${defName} #${number}`, runStatusLabel(b)];
    if (isActiveStatus(b.status) && this.typicalMs !== undefined) {
      tip.push(`Typical duration: ~${formatDuration(this.typicalMs)}`);
    }
    if (b.sourceBranch) tip.push(`Branch: ${shortenBranch(b.sourceBranch)}`);
    if (b.requestedFor?.displayName) tip.push(`Triggered by: ${b.requestedFor.displayName}`);
    this.tooltip = new vscode.MarkdownString(tip.join('\n\n'));
  }
}

export class TimelineRecordNode extends vscode.TreeItem {
  readonly kind = 'timelineRecord' as const;

  constructor(
    public readonly projectName: string,
    public readonly buildId: number,
    public readonly record: TimelineRecord,
    hasChildren: boolean
  ) {
    super(
      record.name ?? '(step)',
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.id = `tr:${buildId}:${record.id}`;
    this.iconPath = recordIcon(record);
    this.description = recordDescription(record);

    const hasLog = typeof record.log?.id === 'number';
    this.contextValue = hasLog ? 'timelineRecord.log' : 'timelineRecord';
    // Leaf steps open the log view on click even before a log exists, so the panel
    // can explain why (pending / waiting for output) instead of the click doing nothing.
    if (hasLog || !hasChildren) {
      this.command = {
        command: 'azurePipelines.viewLogs',
        title: 'View Logs',
        arguments: [this]
      };
    }
  }
}

export class MessageNode extends vscode.TreeItem {
  readonly kind = 'message' as const;
  constructor(label: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Records whose parent is `parentId` (pass undefined for roots), sorted by `order`. */
export function childRecords(
  all: TimelineRecord[],
  parentId: string | undefined
): TimelineRecord[] {
  const pid = parentId ?? '';
  return all
    .filter((r) => (r.parentId ?? '') === pid)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ---------- formatting helpers ----------

function color(id: string): vscode.ThemeColor {
  return new vscode.ThemeColor(id);
}

function runIcon(build: Build): vscode.ThemeIcon {
  switch (build.status) {
    case BuildStatus.InProgress:
      return new vscode.ThemeIcon('sync~spin', color('charts.blue'));
    case BuildStatus.Cancelling:
      return new vscode.ThemeIcon('sync~spin', color('charts.orange'));
    case BuildStatus.NotStarted:
    case BuildStatus.Postponed:
      return new vscode.ThemeIcon('clock', color('charts.yellow'));
    case BuildStatus.Completed:
      return buildResultIcon(build.result);
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function buildResultIcon(result: BuildResult | undefined): vscode.ThemeIcon {
  switch (result) {
    case BuildResult.Succeeded:
      return new vscode.ThemeIcon('pass-filled', color('testing.iconPassed'));
    case BuildResult.PartiallySucceeded:
      return new vscode.ThemeIcon('warning', color('charts.yellow'));
    case BuildResult.Failed:
      return new vscode.ThemeIcon('error', color('testing.iconFailed'));
    case BuildResult.Canceled:
      return new vscode.ThemeIcon('circle-slash', color('disabledForeground'));
    default:
      return new vscode.ThemeIcon('question', color('disabledForeground'));
  }
}

function recordIcon(record: TimelineRecord): vscode.ThemeIcon {
  switch (record.state) {
    case TimelineRecordState.InProgress:
      return new vscode.ThemeIcon('sync~spin', color('charts.blue'));
    case TimelineRecordState.Pending:
      return new vscode.ThemeIcon('circle-outline', color('disabledForeground'));
    case TimelineRecordState.Completed:
      return taskResultIcon(record.result);
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function taskResultIcon(result: TaskResult | undefined): vscode.ThemeIcon {
  switch (result) {
    case TaskResult.Succeeded:
      return new vscode.ThemeIcon('pass-filled', color('testing.iconPassed'));
    case TaskResult.SucceededWithIssues:
      return new vscode.ThemeIcon('warning', color('charts.yellow'));
    case TaskResult.Failed:
      return new vscode.ThemeIcon('error', color('testing.iconFailed'));
    case TaskResult.Canceled:
      return new vscode.ThemeIcon('circle-slash', color('disabledForeground'));
    case TaskResult.Skipped:
      return new vscode.ThemeIcon('debug-step-over', color('disabledForeground'));
    case TaskResult.Abandoned:
      return new vscode.ThemeIcon('circle-slash', color('disabledForeground'));
    default:
      return new vscode.ThemeIcon('pass', color('testing.iconPassed'));
  }
}

function runStatusLabel(b: Build, typicalMs?: number): string {
  switch (b.status) {
    case BuildStatus.InProgress: {
      if (!b.startTime) return 'running';
      const el = elapsed(b.startTime);
      // Elapsed vs. typical reads naturally even when the run overshoots ("14m / ~12m").
      return typicalMs !== undefined ? `running ${el} / ~${formatDuration(typicalMs)}` : `running ${el}`;
    }
    case BuildStatus.Cancelling:
      return 'cancelling';
    case BuildStatus.NotStarted:
      return 'queued';
    case BuildStatus.Postponed:
      return 'postponed';
    case BuildStatus.Completed: {
      const dur = b.startTime && b.finishTime ? ` · ${span(b.startTime, b.finishTime)}` : '';
      return `${buildResultLabel(b.result)}${dur}`;
    }
    default:
      return '';
  }
}

function buildResultLabel(result: BuildResult | undefined): string {
  switch (result) {
    case BuildResult.Succeeded:
      return 'succeeded';
    case BuildResult.PartiallySucceeded:
      return 'partially succeeded';
    case BuildResult.Failed:
      return 'failed';
    case BuildResult.Canceled:
      return 'canceled';
    default:
      return 'done';
  }
}

function recordDescription(r: TimelineRecord): string {
  const parts: string[] = [];
  if (r.state === TimelineRecordState.InProgress && r.startTime) {
    parts.push(elapsed(r.startTime));
  } else if (r.state === TimelineRecordState.Completed && r.startTime && r.finishTime) {
    parts.push(span(r.startTime, r.finishTime));
  }
  if (r.errorCount && r.errorCount > 0) parts.push(`${r.errorCount} error${r.errorCount > 1 ? 's' : ''}`);
  else if (r.warningCount && r.warningCount > 0)
    parts.push(`${r.warningCount} warning${r.warningCount > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

export function shortenBranch(ref: string | undefined): string {
  if (!ref) return '';
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return `tag:${ref.slice('refs/tags/'.length)}`;
  const pr = ref.match(/^refs\/pull\/(\d+)\//);
  if (pr) return `PR ${pr[1]}`;
  return ref;
}

function elapsed(start: Date): string {
  return formatDuration(Date.now() - new Date(start).getTime());
}

function ago(d: Date): string {
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}h ago`;
  const m = Math.floor(ms / 60_000);
  return m >= 1 ? `${m}m ago` : 'just now';
}

function span(start: Date, end: Date): string {
  return formatDuration(new Date(end).getTime() - new Date(start).getTime());
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
