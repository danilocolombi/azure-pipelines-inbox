import { Build, BuildResult, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient } from './client';
import { listDefinitionRuns } from './builds';

/**
 * Run-history stats for one pipeline definition, computed client-side from the same
 * top-N builds the Pipelines view already lists. Purely decorative data: every consumer
 * must degrade gracefully when a field (or the whole object) is missing.
 */
export interface PipelineStats {
  /** Median duration of runs that ran to completion (succeeded / partially succeeded). */
  typicalMs?: number;
  /** Succeeded / completed, canceled runs excluded. 0..1. */
  passRate?: number;
  /** Completed (non-canceled) runs the stats were computed over. */
  sampleSize: number;
  /** Finish time of the most recent failed run, if any. */
  lastFailure?: Date;
}

/** Below this many data points a stat is noise, not signal — show nothing instead. */
const MIN_SAMPLE = 3;

const STATS_TTL_MS = 5 * 60_000;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute stats from a newest-first build list. The duration baseline uses only runs that
 * ran to the end (failed/canceled runs stop early and would skew ETAs optimistic); the
 * median resists outliers like hung agents or cold caches.
 */
export function computeStats(builds: Build[]): PipelineStats | undefined {
  const completed = builds.filter(
    (b) =>
      b.status === BuildStatus.Completed &&
      b.result !== undefined &&
      b.result !== BuildResult.Canceled
  );
  if (completed.length === 0) return undefined;

  const durations = completed
    .filter(
      (b) =>
        (b.result === BuildResult.Succeeded || b.result === BuildResult.PartiallySucceeded) &&
        b.startTime &&
        b.finishTime
    )
    .map((b) => new Date(b.finishTime as Date).getTime() - new Date(b.startTime as Date).getTime())
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);

  const stats: PipelineStats = { sampleSize: completed.length };
  if (durations.length >= MIN_SAMPLE) stats.typicalMs = median(durations);
  if (completed.length >= MIN_SAMPLE) {
    const succeeded = completed.filter((b) => b.result === BuildResult.Succeeded).length;
    stats.passRate = succeeded / completed.length;
  }
  const lastFailed = completed.find((b) => b.result === BuildResult.Failed);
  if (lastFailed?.finishTime) stats.lastFailure = new Date(lastFailed.finishTime);
  return stats;
}

interface Entry {
  stats?: PipelineStats;
  fetchedAt: number;
}

/**
 * Per-definition stats cache shared by both tree views. Entries are filled two ways:
 * `seed()` from build lists a view already fetched (free), or `fetch()` on demand (one
 * `listDefinitionRuns` request, deduped while in flight, refreshed after a 5-minute TTL).
 * `fetch()` never throws — stats are decorative, so failures just mean "no stats".
 */
export class StatsCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<PipelineStats | undefined>>();

  private key(projectName: string, definitionId: number): string {
    return `${projectName}:${definitionId}`;
  }

  /** Whatever is cached, however old — for synchronous node construction. */
  peek(projectName: string, definitionId: number): PipelineStats | undefined {
    return this.entries.get(this.key(projectName, definitionId))?.stats;
  }

  /** Compute and store stats from builds the caller already has. */
  seed(projectName: string, definitionId: number, builds: Build[]): PipelineStats | undefined {
    const stats = computeStats(builds);
    this.entries.set(this.key(projectName, definitionId), { stats, fetchedAt: Date.now() });
    return stats;
  }

  async fetch(
    client: AzureClient,
    projectName: string,
    definitionId: number
  ): Promise<PipelineStats | undefined> {
    const key = this.key(projectName, definitionId);
    const entry = this.entries.get(key);
    if (entry && Date.now() - entry.fetchedAt < STATS_TTL_MS) return entry.stats;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const builds = await listDefinitionRuns(client, projectName, definitionId);
        return this.seed(projectName, definitionId, builds);
      } catch {
        return entry?.stats; // keep stale stats over none; retry after next call
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
