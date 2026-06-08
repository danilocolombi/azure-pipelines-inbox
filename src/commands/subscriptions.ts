import * as vscode from 'vscode';
import { AzureClient } from '../azure/client';
import { listProjects } from '../azure/projects';
import { getSubscriptions, setSubscriptions, Subscription } from '../state/config';

export async function manageSubscriptions(client: AzureClient): Promise<void> {
  let projects;
  try {
    projects = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading projects…' },
      () => listProjects(client)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Could not load projects: ${msg}`);
    return;
  }

  if (projects.length === 0) {
    vscode.window.showWarningMessage('No projects found in this organization.');
    return;
  }

  const subscribedIds = new Set(getSubscriptions().map((s) => s.projectId));
  const items: (vscode.QuickPickItem & { id: string; name: string })[] = projects.map((p) => ({
    label: p.name,
    id: p.id,
    name: p.name,
    picked: subscribedIds.has(p.id)
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Subscribe to Azure DevOps projects',
    placeHolder: 'Toggle the projects whose pipeline runs you want to see',
    matchOnDescription: true
  });
  if (!picked) return;

  const existingOrder = new Map(getSubscriptions().map((s) => [s.projectId, s.order]));
  const next: Subscription[] = picked
    .map((p) => ({
      projectId: p.id,
      projectName: p.name,
      order: existingOrder.get(p.id) ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((a, b) => a.order - b.order);
  await setSubscriptions(next);
}
