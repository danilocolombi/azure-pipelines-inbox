import * as vscode from 'vscode';
import { TimelineRecord } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient, isUnauthorized } from '../azure/client';
import { listDefinitionRuns, listDefinitions } from '../azure/builds';
import { getOrganizationUrl, getSubscriptions, Subscription } from '../state/config';
import { MessageNode, Node, PipelineNode, ProjectNode, RunNode, TimelineRecordNode } from './treeItems';
import { loadRunChildren, recordChildren } from './timeline';

interface ProjectEntry {
  error?: string;
  pipelines?: PipelineNode[];
  loadPromise?: Promise<void>;
}

/**
 * The "Pipelines" catalog view: project → pipeline definition (with last-run status) →
 * recent run history → steps. A companion to the Runs inbox; the run/step/log machinery is
 * shared via `timeline.ts`, so opening a log here behaves identically. Read-only and
 * refresh-on-demand — it is not wired into the poll controller.
 */
export class PipelinesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private projectDefs = new Map<string, ProjectEntry>();
  private defRuns = new Map<number, RunNode[]>();
  private timelines = new Map<number, TimelineRecord[]>();
  private signedIn = false;

  constructor(private readonly client: AzureClient) {}

  setSignedIn(value: boolean): void {
    if (this.signedIn === value) return;
    this.signedIn = value;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this.projectDefs.clear();
    this.defRuns.clear();
    this.timelines.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      if (!this.signedIn) return [];
      return getSubscriptions().map((s) => new ProjectNode(s));
    }
    if (element instanceof ProjectNode) {
      return this.getProjectPipelines(element.subscription);
    }
    if (element instanceof PipelineNode) {
      return this.getPipelineRuns(element);
    }
    if (element instanceof RunNode) {
      return loadRunChildren(this.client, this.timelines, element);
    }
    if (element instanceof TimelineRecordNode) {
      return recordChildren(this.timelines, element);
    }
    return [];
  }

  private getProjectPipelines(sub: Subscription): Node[] {
    const entry = this.projectDefs.get(sub.projectId);
    if (entry?.pipelines) {
      return entry.pipelines.length > 0
        ? entry.pipelines
        : [new MessageNode('(no pipelines)', 'inbox')];
    }
    if (entry?.error) return [new MessageNode(entry.error, 'error')];
    void this.loadProject(sub);
    return [new MessageNode('Loading…', 'loading~spin')];
  }

  private loadProject(sub: Subscription): Promise<void> {
    const existing = this.projectDefs.get(sub.projectId);
    if (existing?.loadPromise) return existing.loadPromise;
    const promise = this.doLoadProject(sub);
    this.projectDefs.set(sub.projectId, { loadPromise: promise });
    return promise;
  }

  private async doLoadProject(sub: Subscription): Promise<void> {
    try {
      const defs = await listDefinitions(this.client, sub.projectName);
      const orgUrl = getOrganizationUrl();
      const pipelines = defs
        .filter((d) => typeof d.id === 'number')
        .map((d) => new PipelineNode(sub.projectName, d, orgUrl));
      this.projectDefs.set(sub.projectId, { pipelines });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
      this.projectDefs.set(sub.projectId, { error: `Error: ${message}` });
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

  private async getPipelineRuns(node: PipelineNode): Promise<Node[]> {
    const cached = this.defRuns.get(node.definitionId);
    if (cached) return cached.length > 0 ? cached : [new MessageNode('(no runs)', 'inbox')];
    try {
      const builds = await listDefinitionRuns(this.client, node.projectName, node.definitionId);
      const orgUrl = getOrganizationUrl();
      const runs = builds
        .filter((b) => typeof b.id === 'number')
        .map((b) => new RunNode(node.projectName, b, orgUrl));
      this.defRuns.set(node.definitionId, runs);
      return runs.length > 0 ? runs : [new MessageNode('(no runs)', 'inbox')];
    } catch {
      return [new MessageNode('Could not load runs', 'error')];
    }
  }
}
