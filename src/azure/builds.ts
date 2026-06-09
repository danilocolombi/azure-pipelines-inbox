import {
  Build,
  BuildDefinitionReference,
  BuildQueryOrder,
  BuildResult,
  BuildStatus,
  DefinitionQueryOrder,
  StageUpdateType,
  TaskResult,
  Timeline,
  TimelineRecord
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

/** Translate the single run filter into Azure's status + result query params. */
function mapRunFilter(f: StatusFilter): { status?: BuildStatus; result?: BuildResult } {
  switch (f) {
    case 'succeeded':
      return { status: BuildStatus.Completed, result: BuildResult.Succeeded };
    case 'failed':
      return { status: BuildStatus.Completed, result: BuildResult.Failed };
    default:
      return {};
  }
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

/**
 * The first failed leaf step of a run's timeline (earliest by start time), used to jump
 * straight to what broke. Only leaf records (actual tasks) are considered — a failed stage
 * or job is just an aggregate of its children.
 */
export function firstFailedLeaf(records: TimelineRecord[]): TimelineRecord | undefined {
  const parents = new Set<string>();
  for (const r of records) if (r.parentId) parents.add(r.parentId);
  const failed = records.filter(
    (r) => !parents.has(r.id ?? '') && r.result === TaskResult.Failed
  );
  if (failed.length === 0) return undefined;
  return failed.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : Infinity;
    const tb = b.startTime ? new Date(b.startTime).getTime() : Infinity;
    return ta !== tb ? ta - tb : (a.order ?? 0) - (b.order ?? 0);
  })[0];
}

/**
 * The failed stages of a run's timeline, in run order. `identifier` is the stage ref name —
 * the handle `updateStage`/retry needs, and it's stable across attempts. Classic (single-stage)
 * pipelines surface no `Stage` records, so this returns empty and callers fall back to a full
 * re-run.
 */
export function failedStages(records: TimelineRecord[]): { refName: string; name: string }[] {
  return records
    .filter((r) => r.type === 'Stage' && r.result === TaskResult.Failed && r.identifier)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({ refName: r.identifier as string, name: r.name ?? (r.identifier as string) }));
}

let cachedUser: { org: string; id?: string } | undefined;

/** The signed-in user's identity id, used to filter "only my runs". Memoized per org. */
export async function getMyId(client: AzureClient): Promise<string | undefined> {
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
  const { status, result } = mapRunFilter(getStatusFilter());
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
    result, // resultFilter
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

/**
 * List a project's pipeline definitions for the Pipelines catalog view, ordered by name.
 * `includeLatestBuilds` populates each ref's `latestBuild` in the same call, which drives
 * the per-pipeline status decoration — no extra request per definition.
 */
export async function listDefinitions(
  client: AzureClient,
  projectName: string
): Promise<BuildDefinitionReference[]> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  const defs = await buildApi.getDefinitions(
    projectName,
    undefined, // name
    undefined, // repositoryId
    undefined, // repositoryType
    DefinitionQueryOrder.DefinitionNameAscending, // queryOrder
    undefined, // top
    undefined, // continuationToken
    undefined, // minMetricsTime
    undefined, // definitionIds
    undefined, // path
    undefined, // builtAfter
    undefined, // notBuiltAfter
    undefined, // includeAllProperties
    true // includeLatestBuilds
  );
  return defs ?? [];
}

/**
 * The recent run history of a single pipeline, newest first. Unlike `listRuns`, this
 * ignores the inbox filters (only-mine / status / branch) — a pipeline's history is its
 * history.
 */
export async function listDefinitionRuns(
  client: AzureClient,
  projectName: string,
  definitionId: number
): Promise<Build[]> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  const builds = await buildApi.getBuilds(
    projectName,
    [definitionId], // definitions
    undefined, // queues
    undefined, // buildNumber
    undefined, // minTime
    undefined, // maxTime
    undefined, // requestedFor
    undefined, // reasonFilter
    undefined, // statusFilter
    undefined, // resultFilter
    undefined, // tagFilters
    undefined, // properties
    getRunsTop(), // top
    undefined, // continuationToken
    undefined, // maxBuildsPerDefinition
    undefined, // deletedFilter
    BuildQueryOrder.QueueTimeDescending // queryOrder
  );
  return builds ?? [];
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

/**
 * Queue a fresh run of a pipeline definition. An empty `branch` runs the pipeline's default
 * branch; otherwise it's normalized to a full ref (`main` → `refs/heads/main`).
 */
export async function queuePipeline(
  client: AzureClient,
  projectName: string,
  definitionId: number,
  branch?: string
): Promise<Build> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  const trimmed = branch?.trim();
  return buildApi.queueBuild(
    {
      definition: { id: definitionId },
      sourceBranch: trimmed ? normalizeBranch(trimmed) : undefined
    },
    projectName
  );
}

/**
 * Retry a single failed stage in place, re-running only its failed jobs (the run returns to
 * in-progress). `forceRetryAllJobs: false` mirrors the web UI's "Rerun failed jobs".
 */
export async function retryStage(
  client: AzureClient,
  projectName: string,
  buildId: number,
  stageRefName: string
): Promise<void> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  await buildApi.updateStage(
    { state: StageUpdateType.Retry, forceRetryAllJobs: false },
    buildId,
    stageRefName,
    projectName
  );
}
