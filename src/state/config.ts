import * as vscode from 'vscode';

const SECTION = 'azurePipelines';

export interface Subscription {
  projectId: string;
  projectName: string;
  order: number;
}

export type StatusFilter = 'all' | 'inProgress' | 'completed';

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

export function getOrganizationUrl(): string {
  return (cfg().get<string>('organizationUrl') ?? '').replace(/\/+$/, '');
}

export async function setOrganizationUrl(url: string): Promise<void> {
  await cfg().update('organizationUrl', url.replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
}

export function getSubscriptions(): Subscription[] {
  const raw = cfg().get<Subscription[]>('subscriptions') ?? [];
  return [...raw].sort((a, b) => a.order - b.order);
}

export async function setSubscriptions(subs: Subscription[]): Promise<void> {
  const normalized = subs.map((s, i) => ({ ...s, order: i }));
  await cfg().update('subscriptions', normalized, vscode.ConfigurationTarget.Global);
}

export function getOnlyMyRuns(): boolean {
  return cfg().get<boolean>('onlyMyRuns') ?? false;
}

export async function setOnlyMyRuns(v: boolean): Promise<void> {
  await cfg().update('onlyMyRuns', v, vscode.ConfigurationTarget.Global);
}

export function getStatusFilter(): StatusFilter {
  const v = cfg().get<string>('statusFilter') ?? 'all';
  return v === 'inProgress' || v === 'completed' ? v : 'all';
}

export async function setStatusFilter(v: StatusFilter): Promise<void> {
  await cfg().update('statusFilter', v, vscode.ConfigurationTarget.Global);
}

export function getBranchFilter(): string {
  return (cfg().get<string>('branchFilter') ?? '').trim();
}

export function getRunsTop(): number {
  const n = cfg().get<number>('runsTop') ?? 25;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}

export function getPollSeconds(): number {
  const n = cfg().get<number>('pollSeconds') ?? 4;
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 4;
}

export function getActionsEnabled(): boolean {
  return cfg().get<boolean>('enableActions') ?? false;
}

export async function setActionsEnabled(v: boolean): Promise<void> {
  await cfg().update('enableActions', v, vscode.ConfigurationTarget.Global);
}
