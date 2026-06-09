import { TimelineRecord } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient } from '../azure/client';
import { getTimeline, isActiveStatus } from '../azure/builds';
import { childRecords, MessageNode, Node, RunNode, TimelineRecordNode } from './treeItems';

/**
 * Run → step expansion shared by both tree views. Each provider passes its own `timelines`
 * cache so the run/step/log behavior is identical whether a run is reached from the Runs
 * inbox or the Pipelines catalog.
 */

/** Load (and cache) a run's timeline and return its root step nodes. */
export async function loadRunChildren(
  client: AzureClient,
  timelines: Map<number, TimelineRecord[]>,
  runNode: RunNode
): Promise<Node[]> {
  let records = timelines.get(runNode.buildId);
  if (!records) {
    try {
      const timeline = await getTimeline(client, runNode.projectName, runNode.buildId);
      records = timeline?.records ?? [];
      timelines.set(runNode.buildId, records);
    } catch {
      return [new MessageNode('Could not load timeline', 'error')];
    }
  }
  const roots = childRecords(records, undefined);
  if (roots.length === 0) {
    return [
      new MessageNode(
        isActiveStatus(runNode.build.status) ? 'Starting…' : '(no steps)',
        'loading~spin'
      )
    ];
  }
  return roots.map(
    (r) =>
      new TimelineRecordNode(
        runNode.projectName,
        runNode.buildId,
        r,
        childRecords(records, r.id).length > 0
      )
  );
}

/** Child step nodes of a timeline record, from the already-cached timeline. */
export function recordChildren(
  timelines: Map<number, TimelineRecord[]>,
  node: TimelineRecordNode
): Node[] {
  const records = timelines.get(node.buildId);
  if (!records) return [];
  return childRecords(records, node.record.id).map(
    (r) =>
      new TimelineRecordNode(
        node.projectName,
        node.buildId,
        r,
        childRecords(records, r.id).length > 0
      )
  );
}
