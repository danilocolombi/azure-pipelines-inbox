import * as vscode from 'vscode';
import { Build } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { cancelRun, failedStages, getTimeline, queuePipeline, reRun, retryStage } from '../azure/builds';
import { AzureClient, isUnauthorized } from '../azure/client';
import { PipelineNode, RunNode } from '../view/treeItems';

export async function openRunInBrowser(node: unknown): Promise<void> {
  if (node instanceof RunNode && node.url) {
    await vscode.env.openExternal(vscode.Uri.parse(node.url));
  }
}

export async function openPipelineInBrowser(node: unknown): Promise<void> {
  if (node instanceof PipelineNode && node.url) {
    await vscode.env.openExternal(vscode.Uri.parse(node.url));
  }
}

export async function copyRunUrl(node: unknown): Promise<void> {
  if (node instanceof RunNode && node.url) {
    await vscode.env.clipboard.writeText(node.url);
    void vscode.window.showInformationMessage('Run URL copied to clipboard.');
  }
}

export async function cancelRunCommand(client: AzureClient, node: unknown): Promise<boolean> {
  if (!(node instanceof RunNode)) return false;
  const label = `${node.build.definition?.name ?? 'this run'} #${node.build.buildNumber ?? node.buildId}`;
  const choice = await vscode.window.showWarningMessage(
    `Cancel ${label}?`,
    { modal: true },
    'Cancel Run'
  );
  if (choice !== 'Cancel Run') return false;
  try {
    await cancelRun(client, node.projectName, node.buildId);
    void vscode.window.showInformationMessage('Cancellation requested.');
    return true;
  } catch (err) {
    reportError(err, 'cancel the run');
    return false;
  }
}

export async function reRunCommand(client: AzureClient, node: unknown): Promise<Build | undefined> {
  if (!(node instanceof RunNode)) return undefined;
  try {
    const queued = await reRun(client, node.projectName, node.build);
    void vscode.window.showInformationMessage(
      `Re-run queued: ${queued.definition?.name ?? ''} #${queued.buildNumber ?? queued.id}`.trim()
    );
    return queued;
  } catch (err) {
    reportError(err, 're-run the pipeline');
    return undefined;
  }
}

/** Queue a pipeline from the catalog, prompting for a branch (empty = the pipeline default). */
export async function runPipelineCommand(
  client: AzureClient,
  node: unknown
): Promise<Build | undefined> {
  if (!(node instanceof PipelineNode)) return undefined;
  const name = node.definition.name ?? 'pipeline';
  const branch = await vscode.window.showInputBox({
    title: `Run ${name}`,
    prompt: 'Branch to run — leave empty for the pipeline default',
    placeHolder: 'e.g. main or refs/heads/feature/x'
  });
  if (branch === undefined) return undefined; // dismissed
  try {
    const queued = await queuePipeline(client, node.projectName, node.definitionId, branch);
    void vscode.window.showInformationMessage(
      `Queued ${queued.definition?.name ?? name} #${queued.buildNumber ?? queued.id}`.trim()
    );
    return queued;
  } catch (err) {
    reportError(err, 'run the pipeline');
    return undefined;
  }
}

/**
 * Re-run only the failed stages of a run, in place (the web UI's "Rerun failed jobs"). Falls
 * back to a message when there are no failed stages to retry (e.g. a classic single-stage build).
 */
export async function reRunFailedCommand(client: AzureClient, node: unknown): Promise<boolean> {
  if (!(node instanceof RunNode)) return false;
  let stages: { refName: string; name: string }[];
  try {
    const timeline = await getTimeline(client, node.projectName, node.buildId);
    stages = failedStages(timeline?.records ?? []);
  } catch (err) {
    reportError(err, 're-run the failed jobs');
    return false;
  }
  if (stages.length === 0) {
    void vscode.window.showInformationMessage(
      'No failed stages to retry — use Re-run to run the whole pipeline again.'
    );
    return false;
  }
  try {
    for (const s of stages) {
      await retryStage(client, node.projectName, node.buildId, s.refName);
    }
    const what =
      stages.length === 1 ? `the "${stages[0].name}" stage` : `${stages.length} failed stages`;
    void vscode.window.showInformationMessage(`Re-running failed jobs in ${what}.`);
    return true;
  } catch (err) {
    reportError(err, 're-run the failed jobs');
    return false;
  }
}

function reportError(err: unknown, action: string): void {
  if (isUnauthorized(err)) {
    void vscode.window.showErrorMessage(
      `Could not ${action}: your token lacks Build (Read & Execute). Run "Azure Pipelines: Enable Run Actions" to update it.`
    );
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`Could not ${action}: ${msg}`);
}
