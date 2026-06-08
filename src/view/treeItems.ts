import * as vscode from 'vscode';
import {
  Build,
  BuildResult,
  BuildStatus,
  TaskResult,
  TimelineRecord,
  TimelineRecordState
} from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { isActiveStatus } from '../azure/builds';
import { Subscription } from '../state/config';

export type Node = ProjectNode | RunNode | TimelineRecordNode | MessageNode;

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

export class RunNode extends vscode.TreeItem {
  readonly kind = 'run' as const;
  url = '';

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

  private apply(): void {
    const b = this.build;
    const defName = b.definition?.name ?? 'Pipeline';
    const number = b.buildNumber ?? `${b.id}`;
    this.label = `${defName} #${number}`;
    const branch = shortenBranch(b.sourceBranch);
    this.description = branch ? `${runStatusLabel(b)} · ${branch}` : runStatusLabel(b);
    this.iconPath = runIcon(b);
    this.contextValue = isActiveStatus(b.status) ? 'run.active' : 'run';
    this.url = `${this.orgUrl}/${encodeURIComponent(this.projectName)}/_build/results?buildId=${b.id}`;

    const tip: string[] = [`${defName} #${number}`, runStatusLabel(b)];
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

    const logId = record.log?.id;
    if (typeof logId === 'number') {
      this.contextValue = 'timelineRecord.log';
      this.command = {
        command: 'azurePipelines.viewLogs',
        title: 'View Logs',
        arguments: [this]
      };
    } else {
      this.contextValue = 'timelineRecord';
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

function runStatusLabel(b: Build): string {
  switch (b.status) {
    case BuildStatus.InProgress:
      return b.startTime ? `running ${elapsed(b.startTime)}` : 'running';
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

function shortenBranch(ref: string | undefined): string {
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
