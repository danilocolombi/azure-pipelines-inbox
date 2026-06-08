import { AzureClient } from './client';

/**
 * Fetch log lines for a build log, optionally from a starting 1-based line number.
 * Tailing: pass the next unread line as `startLine` and append whatever comes back.
 */
export async function getLogLines(
  client: AzureClient,
  projectName: string,
  buildId: number,
  logId: number,
  startLine?: number
): Promise<string[]> {
  const conn = await client.get();
  const buildApi = await conn.getBuildApi();
  return (await buildApi.getBuildLogLines(projectName, buildId, logId, startLine)) ?? [];
}
