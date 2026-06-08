import * as vscode from 'vscode';
import { getOrganizationUrl, setOrganizationUrl } from '../state/config';

const PAT_KEY = 'azurePipelines.pat';

export class AuthService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getPat(): Promise<string | undefined> {
    return this.secrets.get(PAT_KEY);
  }

  async setPat(pat: string): Promise<void> {
    await this.secrets.store(PAT_KEY, pat);
  }

  async clearPat(): Promise<void> {
    await this.secrets.delete(PAT_KEY);
  }

  async isSignedIn(): Promise<boolean> {
    const pat = await this.getPat();
    return !!pat && !!getOrganizationUrl();
  }

  async promptSignIn(): Promise<boolean> {
    const currentOrg = getOrganizationUrl();
    const orgUrl = await vscode.window.showInputBox({
      title: 'Azure DevOps Organization URL',
      prompt: 'e.g. https://dev.azure.com/contoso',
      value: currentOrg,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v) return 'Required';
        try {
          const u = new URL(v);
          if (!/^https?:$/.test(u.protocol)) return 'Must be http(s)';
        } catch {
          return 'Not a valid URL';
        }
        return null;
      }
    });
    if (!orgUrl) return false;

    const pat = await vscode.window.showInputBox({
      title: 'Azure DevOps Personal Access Token',
      prompt: 'Needs Build (Read) and Project and Team (Read) scopes',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? null : 'Required')
    });
    if (!pat) return false;

    await setOrganizationUrl(orgUrl.trim());
    await this.setPat(pat.trim());
    return true;
  }

  /**
   * Replace the stored PAT with a write-scoped one. A Build (Read & Execute) PAT is a
   * superset of a read PAT, so it keeps every read feature working — we just overwrite
   * in place. Used by the opt-in "Enable Run Actions" flow; sign-in stays read-only.
   */
  async promptWritePat(): Promise<boolean> {
    if (!getOrganizationUrl()) return this.promptSignIn();
    const pat = await vscode.window.showInputBox({
      title: 'Azure DevOps Personal Access Token (Build Read & Execute)',
      prompt: 'Cancelling and re-running pipelines needs a PAT with Build (Read & Execute) scope',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? null : 'Required')
    });
    if (!pat) return false;
    await this.setPat(pat.trim());
    return true;
  }
}
