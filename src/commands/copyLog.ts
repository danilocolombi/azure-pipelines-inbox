import * as vscode from 'vscode';
import { AzureClient } from '../azure/client';
import { buildAiCopy, buildPlainCopy, CopyResult, LogTarget } from '../azure/logExport';
import { TimelineRecordNode } from '../view/treeItems';

export type CopyMode = 'plain' | 'ai';

/**
 * Copy a step's log to the clipboard. `target` is either a tree node (from the context
 * menu) or a resolved `LogTarget` (from the log panel's header buttons).
 */
export async function copyLog(
  client: AzureClient,
  target: TimelineRecordNode | LogTarget | undefined,
  mode: CopyMode,
  opts?: { silent?: boolean }
): Promise<CopyResult | undefined> {
  const t = toTarget(target);
  if (!t) {
    if (!opts?.silent) void vscode.window.showInformationMessage('No log is available for this step yet.');
    return undefined;
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Azure Pipelines: copying log…' },
      () => (mode === 'ai' ? buildAiCopy(client, t) : buildPlainCopy(client, t))
    );
    if (!result.text.trim()) {
      if (!opts?.silent) void vscode.window.showInformationMessage('This step has no log output yet.');
      return undefined;
    }
    await vscode.env.clipboard.writeText(result.text);
    // The webview shows its own inline confirmation, so it opts out of the toast.
    if (!opts?.silent) void vscode.window.showInformationMessage(copyMessage(result, mode));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
    void vscode.window.showErrorMessage(`Azure Pipelines: could not copy log — ${message}`);
    return undefined;
  }
}

function toTarget(target: TimelineRecordNode | LogTarget | undefined): LogTarget | undefined {
  if (!target) return undefined;
  if (target instanceof TimelineRecordNode) {
    const logId = target.record.log?.id;
    if (typeof logId !== 'number') return undefined;
    return {
      projectName: target.projectName,
      buildId: target.buildId,
      logId,
      recordId: target.record.id ?? '',
      stepName: target.record.name ?? '(step)'
    };
  }
  return target;
}

function copyMessage(r: CopyResult, mode: CopyMode): string {
  if (mode !== 'ai') return `Copied ${r.totalLines} log line${r.totalLines === 1 ? '' : 's'} to the clipboard.`;
  const size = formatTokens(r.text.length);
  return r.trimmed
    ? `Copied for AI: ${r.includedLines} of ${r.totalLines} lines (errors + context), ~${size}.`
    : `Copied for AI: ${r.totalLines} lines, ~${size}.`;
}

/** Rough token estimate (~4 chars/token) just to set expectations against context limits. */
function formatTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
}
