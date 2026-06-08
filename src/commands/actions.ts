import * as vscode from 'vscode';
import { AuthService } from '../auth/authService';
import { resetUserCache } from '../azure/builds';
import { AzureClient } from '../azure/client';
import { setActionsEnabled } from '../state/config';

/**
 * Opt-in flow for cancel/re-run. Keeps the default token read-only: we only ask for a
 * Build (Read & Execute) PAT when the user deliberately enables run actions. The write
 * PAT is a superset of a read PAT, so it replaces the stored one with no loss of reads.
 */
export async function enableActions(auth: AuthService, client: AzureClient): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    'Cancelling and re-running pipelines requires a Personal Access Token with Build (Read & Execute). ' +
      'Your sign-in token is read-only by default. Update it now to enable run actions?',
    { modal: true },
    'Update Token'
  );
  if (choice !== 'Update Token') return false;

  if (!(await auth.promptWritePat())) return false;
  client.invalidate();
  resetUserCache();
  await setActionsEnabled(true);
  void vscode.window.showInformationMessage('Azure Pipelines: run actions enabled.');
  return true;
}
