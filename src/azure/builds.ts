import {
  Build,
  BuildQueryOrder,
  BuildStatus,
  Timeline
} from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient } from './client';
import {
  getBranchFilter,
  getOnlyMyRuns,
  getOrganizationUrl,
  getRunsTop,
  getStatusFilter,
  StatusFilter
} from '../state/config';

function mapStatusFilter(f: StatusFilter): BuildStatus | undefined {
  if (f === 'inProgress') return BuildStatus.InProgress;
  if (f === 'completed') return BuildStatus.Completed;
  return undefined;
}

/** A run worth polling: started/queued but not yet finished. */
export function isActiveStatus(status: BuildStatus | undefined): boolean {
  return (
    status === BuildStatus.InProgress ||
    status === BuildStatus.NotStarted ||
    status === BuildStatus.Postponed ||
    status === BuildStatus.Cancelling
  );
}

let cachedUser: { org: string; id?: string } | undefined;

/** The signed-in user's identity id, used to filter "only my runs". Memoized per org. */
async function getMyId(client: AzureClient): Promise<string | undefined> {
  const org = getOrganizationUrl();
  if (cachedUser && cachedUser.org === org) return cachedUser.id;
  const conn = await client.get();
  const data = await conn.connect();
  cachedUser = { org, id: data.authenticatedUser?.id };
  return cachedUser.id;
}

/** Clear the memoized authenticated-user id (call on sign-in/out or PAT change). */
export function resetUserCache(): void {
  cachedUser = undefined;
}

function normalizeBranch(b: string): string {
  return b.startsWith('refs/') ? b : `refs/heads/${b}`;
}

export async function listRuns(client: AzureClient, projectName: string): Promise<Build[]> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  const status = mapStatusFilter(getStatusFilter());
  const branch = getBranchFilter();
  const requestedFor = getOnlyMyRuns() ? await getMyId(client) : undefined;
  const builds = await buildApi.getBuilds(
    projectName,
    undefined, // definitions
    undefined, // queues
    undefined, // buildNumber
    undefined, // minTime
    undefined, // maxTime
    requestedFor, // requestedFor
    undefined, // reasonFilter
    status, // statusFilter
    undefined, // resultFilter
    undefined, // tagFilters
    undefined, // properties
    getRunsTop(), // top
    undefined, // continuationToken
    undefined, // maxBuildsPerDefinition
    undefined, // deletedFilter
    BuildQueryOrder.QueueTimeDescending, // queryOrder
    branch ? normalizeBranch(branch) : undefined // branchName
  );
  return builds ?? [];
}

export async function getRun(
  client: AzureClient,
  projectName: string,
  buildId: number
): Promise<Build> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  return buildApi.getBuild(projectName, buildId);
}

export async function getTimeline(
  client: AzureClient,
  projectName: string,
  buildId: number
): Promise<Timeline | undefined> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  return (await buildApi.getBuildTimeline(projectName, buildId)) ?? undefined;
}

export async function cancelRun(
  client: AzureClient,
  projectName: string,
  buildId: number
): Promise<void> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  await buildApi.updateBuild({ status: BuildStatus.Cancelling }, projectName, buildId);
}

export async function reRun(
  client: AzureClient,
  projectName: string,
  build: Build
): Promise<Build> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  return buildApi.queueBuild(
    { definition: { id: build.definition?.id }, sourceBranch: build.sourceBranch },
    projectName
  );
}
