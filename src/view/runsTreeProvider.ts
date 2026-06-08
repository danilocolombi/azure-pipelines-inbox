import * as vscode from 'vscode';
import { TimelineRecord } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient, isUnauthorized } from '../azure/client';
import { getRun, getTimeline, isActiveStatus, listRuns } from '../azure/builds';
import { getOrganizationUrl, getSubscriptions, Subscription } from '../state/config';
import {
  childRecords,
  MessageNode,
  Node,
  ProjectNode,
  RunNode,
  TimelineRecordNode
} from './treeItems';

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
      return this.getRunChildren(element);
    }
    if (element instanceof TimelineRecordNode) {
      const records = this.timelines.get(element.buildId);
      if (!records) return [];
      return childRecords(records, element.record.id).map(
        (r) =>
          new TimelineRecordNode(
            element.projectName,
            element.buildId,
            r,
            childRecords(records, r.id).length > 0
          )
      );
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

  private async getRunChildren(runNode: RunNode): Promise<Node[]> {
    let records = this.timelines.get(runNode.buildId);
    if (!records) {
      try {
        const timeline = await getTimeline(this.client, runNode.projectName, runNode.buildId);
        records = timeline?.records ?? [];
        this.timelines.set(runNode.buildId, records);
      } catch {
        return [new MessageNode('Could not load timeline', 'error')];
      }
    }
    const roots = childRecords(records, undefined);
    if (roots.length === 0) {
      return [new MessageNode(isActiveStatus(runNode.build.status) ? 'Starting…' : '(no steps)', 'loading~spin')];
    }
    const all = records;
    return roots.map(
      (r) =>
        new TimelineRecordNode(
          runNode.projectName,
          runNode.buildId,
          r,
          childRecords(all, r.id).length > 0
        )
    );
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
          if (isActiveStatus(fresh.status)) active = true;
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
