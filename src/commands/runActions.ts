import * as vscode from 'vscode';
import { Build } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { cancelRun, reRun } from '../azure/builds';
import { AzureClient, isUnauthorized } from '../azure/client';
import { RunNode } from '../view/treeItems';

export async function openRunInBrowser(node: unknown): Promise<void> {
  if (node instanceof RunNode && node.url) {
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
