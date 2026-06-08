import * as azdev from 'azure-devops-node-api';
import { AuthService } from '../auth/authService';
import { getOrganizationUrl } from '../state/config';

export class AzureClient {
  private connection: azdev.WebApi | undefined;
  private cachedKey = '';

  constructor(private readonly auth: AuthService) {}

  invalidate(): void {
    this.connection = undefined;
    this.cachedKey = '';
  }

  async get(): Promise<azdev.WebApi> {
    const orgUrl = getOrganizationUrl();
    const pat = await this.auth.getPat();
    if (!orgUrl) throw new Error('Azure DevOps organization URL is not set.');
    if (!pat) throw new Error('Not signed in. Run "Azure Pipelines: Sign In".');

    const key = `${orgUrl}::${pat.length}::${pat.slice(-4)}`;
    if (this.connection && key === this.cachedKey) return this.connection;

    const handler = azdev.getPersonalAccessTokenHandler(pat);
    this.connection = new azdev.WebApi(orgUrl, handler);
    this.cachedKey = key;
    return this.connection;
  }
}

export function isUnauthorized(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string };
  if (e?.statusCode === 401 || e?.statusCode === 403) return true;
  const msg = (e?.message ?? '').toLowerCase();
  return msg.includes('unauthorized') || msg.includes('tf400813') || msg.includes('tf30063');
}
