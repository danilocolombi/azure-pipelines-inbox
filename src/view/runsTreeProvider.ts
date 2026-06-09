import * as vscode from 'vscode';
import { TimelineRecord } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient, isUnauthorized } from '../azure/client';
import { getRun, getTimeline, isActiveStatus, listRuns } from '../azure/builds';
import { getOrganizationUrl, getSubscriptions, Subscription } from '../state/config';
import { MessageNode, Node, ProjectNode, RunNode, TimelineRecordNode } from './treeItems';
import { loadRunChildren, recordChildren } from './timeline';

interface ProjectEntry {
  loading: boolean;
  error?: string;
  runs?: RunNode[];
  loadPromise?: Promise<void>;
}

export class RunsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Fires when the set/status of runs changes (status bar + poll lifecycle). */
  private readonly _onDidChangeRuns = new vscode.EventEmitter<void>();
  readonly onDidChangeRuns = this._onDidChangeRuns.event;

  /** Fires once per run the moment it transitions from active to finished (drives notifications). */
  private readonly _onDidCompleteRun = new vscode.EventEmitter<RunNode>();
  readonly onDidCompleteRun = this._onDidCompleteRun.event;

  private projectRuns = new Map<string, ProjectEntry>();
  private timelines = new Map<number, TimelineRecord[]>();
  private signedIn = false;

  constructor(private readonly client: AzureClient) {}

  setSignedIn(value: boolean): void {
    if (this.signedIn === value) return;
    this.signedIn = value;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this.projectRuns.clear();
    this.timelines.clear();
    this._onDidChangeTreeData.fire();
    this._onDidChangeRuns.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  // Required for `TreeView.reveal` (Expand All). We only reveal root-level project
  // nodes, so returning undefined (root) for every element is sufficient.
  getParent(): Node | undefined {
    return undefined;
  }

  getProjectNodes(): ProjectNode[] {
    return getSubscriptions().map((s) => new ProjectNode(s));
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      if (!this.signedIn) return [];
      const subs = getSubscriptions();
      if (subs.length === 0) return [];
      return subs.map((s) => new ProjectNode(s));
    }
    if (element instanceof ProjectNode) {
      return this.getProjectRuns(element.subscription);
    }
    if (element instanceof RunNode) {
      return loadRunChildren(this.client, this.timelines, element);
    }
    if (element instanceof TimelineRecordNode) {
      return recordChildren(this.timelines, element);
    }
    return [];
  }

  private getProjectRuns(sub: Subscription): Node[] {
    const entry = this.projectRuns.get(sub.projectId);
    if (entry?.runs) {
      return entry.runs.length > 0 ? entry.runs : [new MessageNode('(no runs)', 'inbox')];
    }
    if (entry?.error) return [new MessageNode(entry.error, 'error')];
    void this.loadProject(sub);
    return [new MessageNode('Loading…', 'loading~spin')];
  }

  private loadProject(sub: Subscription): Promise<void> {
    const existing = this.projectRuns.get(sub.projectId);
    if (existing?.loadPromise) return existing.loadPromise;
    const promise = this.doLoadProject(sub);
    this.projectRuns.set(sub.projectId, { loading: true, loadPromise: promise });
    return promise;
  }

  private async doLoadProject(sub: Subscription): Promise<void> {
    try {
      const builds = await listRuns(this.client, sub.projectName);
      const orgUrl = getOrganizationUrl();
      const runs = builds
        .filter((b) => typeof b.id === 'number')
        .map((b) => new RunNode(sub.projectName, b, orgUrl));
      this.projectRuns.set(sub.projectId, { loading: false, runs });
      this._onDidChangeRuns.fire();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
      this.projectRuns.set(sub.projectId, { loading: false, error: `Error: ${message}` });
      if (isUnauthorized(err)) {
        const choice = await vscode.window.showErrorMessage(
          'Azure Pipelines: authentication failed. Sign in again?',
          'Sign In'
        );
        if (choice === 'Sign In') {
          await vscode.commands.executeCommand('azurePipelines.signIn');
        }
      }
    } finally {
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Re-list runs for every already-loaded project and reconcile the result: keep existing
   * run nodes (preserving their cached timeline + expansion state) by build id, add ones
   * that appeared, and drop ones that fell off. This is what surfaces runs started outside
   * the editor; the poll controller calls it each tick while the view is visible.
   */
  async refreshRunList(): Promise<void> {
    if (!this.signedIn) return;
    const orgUrl = getOrganizationUrl();
    let changed = false;
    for (const sub of getSubscriptions()) {
      const entry = this.projectRuns.get(sub.projectId);
      if (!entry?.runs) continue; // not loaded yet — the initial load will populate it
      try {
        const builds = await listRuns(this.client, sub.projectName);
        const existing = new Map(entry.runs.map((r) => [r.buildId, r]));
        const next: RunNode[] = [];
        for (const b of builds) {
          if (typeof b.id !== 'number') continue;
          const node = existing.get(b.id);
          if (node) {
            next.push(node);
          } else {
            next.push(new RunNode(sub.projectName, b, orgUrl));
            changed = true;
          }
        }
        if (next.length !== entry.runs.length) changed = true; // a run dropped off the top N
        entry.runs = next;
      } catch {
        // transient; keep the current list and try again next tick
      }
    }
    if (changed) {
      this._onDidChangeTreeData.fire();
      this._onDidChangeRuns.fire();
    }
  }

  /**
   * Refetch every in-progress run (and its timeline, if it's been expanded), update the
   * nodes in place, and return whether anything is still active — the poll controller
   * uses this to decide whether to keep ticking.
   */
  async pollActiveRuns(): Promise<boolean> {
    let active = false;
    const subsById = new Map(getSubscriptions().map((s) => [s.projectId, s]));
    for (const [projectId, entry] of this.projectRuns) {
      const sub = subsById.get(projectId);
      if (!sub || !entry.runs) continue;
      for (const runNode of entry.runs) {
        if (!isActiveStatus(runNode.build.status)) continue;
        try {
          const fresh = await getRun(this.client, sub.projectName, runNode.buildId);
          runNode.update(fresh);
          if (this.timelines.has(runNode.buildId)) {
            const timeline = await getTimeline(this.client, sub.projectName, runNode.buildId);
            this.timelines.set(runNode.buildId, timeline?.records ?? []);
          }
          this._onDidChangeTreeData.fire(runNode);
          // The loop only reaches active runs, so a now-inactive status is a fresh
          // transition — fire exactly once (next tick the guard above skips it).
          if (isActiveStatus(fresh.status)) active = true;
          else this._onDidCompleteRun.fire(runNode);
        } catch {
          // transient; try again next tick
        }
      }
    }
    this._onDidChangeRuns.fire();
    return active;
  }

  hasActiveRuns(): boolean {
    for (const entry of this.projectRuns.values()) {
      if (entry.runs?.some((r) => isActiveStatus(r.build.status))) return true;
    }
    return false;
  }

  getRunningCount(): number {
    let n = 0;
    for (const entry of this.projectRuns.values()) {
      if (!entry.runs) continue;
      for (const r of entry.runs) if (isActiveStatus(r.build.status)) n++;
    }
    return n;
  }
}
