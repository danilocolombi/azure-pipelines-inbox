import * as vscode from 'vscode';
import { TimelineRecordState } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient } from '../azure/client';
import { getTimeline } from '../azure/builds';
import { getLogLines } from '../azure/logs';
import { getOrganizationUrl } from '../state/config';
import { TimelineRecordNode } from './treeItems';

interface Current {
  projectName: string;
  buildId: number;
  logId: number;
  recordId: string;
  title: string;
  url: string;
  nextLine: number; // 1-based next line to fetch
  inProgress: boolean;
  loading: boolean;
}

/**
 * A single reusable webview panel that shows one step's log and tails it while the
 * step runs. Opening logs for another step retargets the same panel.
 */
export class LogPanel {
  private panel?: vscode.WebviewPanel;
  private current?: Current;

  constructor(private readonly client: AzureClient) {}

  async show(node: TimelineRecordNode): Promise<void> {
    const logId = node.record.log?.id;
    if (typeof logId !== 'number') {
      void vscode.window.showInformationMessage('No log available for this step yet.');
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'azurePipelines.log',
        'Pipeline Log',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
      });
    }

    const title = node.record.name ?? 'Log';
    this.panel.title = `Log · ${title}`;
    this.panel.webview.html = renderHtml(this.panel.webview);
    this.current = {
      projectName: node.projectName,
      buildId: node.buildId,
      logId,
      recordId: node.record.id ?? '',
      title,
      url: `${getOrganizationUrl()}/${encodeURIComponent(node.projectName)}/_build/results?buildId=${node.buildId}&view=logs`,
      nextLine: 1,
      inProgress: node.record.state === TimelineRecordState.InProgress,
      loading: true
    };
    this.panel.reveal(vscode.ViewColumn.Active, false);
    await this.loadInitial();
  }

  /** True while a step is open and still running, so the poll controller keeps ticking. */
  isTailing(): boolean {
    return !!this.panel && !!this.current && this.current.inProgress;
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private async loadInitial(): Promise<void> {
    const c = this.current;
    if (!c) return;
    this.post({ type: 'reset', header: { title: c.title, url: c.url, inProgress: c.inProgress } });
    try {
      const lines = await getLogLines(this.client, c.projectName, c.buildId, c.logId, c.nextLine);
      if (this.current !== c) return;
      if (lines.length) {
        this.post({ type: 'append', lines });
        c.nextLine += lines.length;
      }
    } catch {
      this.post({ type: 'error', message: 'Could not load log output yet.' });
    } finally {
      c.loading = false;
      if (!c.inProgress) this.post({ type: 'done' });
    }
  }

  /** Called each poll tick. Returns whether the step is still in progress. */
  async pollAppend(): Promise<boolean> {
    const c = this.current;
    if (!this.panel || !c || c.loading || !c.inProgress) return false;
    try {
      const lines = await getLogLines(this.client, c.projectName, c.buildId, c.logId, c.nextLine);
      if (this.current !== c) return false;
      if (lines.length) {
        this.post({ type: 'append', lines });
        c.nextLine += lines.length;
      }
      const timeline = await getTimeline(this.client, c.projectName, c.buildId);
      const rec = timeline?.records?.find((r) => r.id === c.recordId);
      const stillInProgress = rec ? rec.state === TimelineRecordState.InProgress : false;
      if (!stillInProgress) {
        // One final read in case output landed after the last fetch.
        const tail = await getLogLines(this.client, c.projectName, c.buildId, c.logId, c.nextLine);
        if (this.current === c && tail.length) {
          this.post({ type: 'append', lines: tail });
          c.nextLine += tail.length;
        }
        c.inProgress = false;
        this.post({ type: 'done' });
      }
      return c.inProgress;
    } catch {
      return c.inProgress;
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function renderHtml(webview: vscode.Webview): string {
  const n = nonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .header { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  .header .title { font-weight: 600; }
  .header a { color: var(--vscode-textLink-foreground); text-decoration: none; margin-left: auto; }
  .header a:hover { text-decoration: underline; }
  .badge { font-size: 0.8em; padding: 1px 7px; border-radius: 9px; }
  .badge.live { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
  .badge.done { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  #log { flex: 1; overflow: auto; padding: 8px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .line { display: block; }
  .line.error { color: var(--vscode-errorForeground); }
  .line.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
  .line.section { color: var(--vscode-charts-blue, #3794ff); font-weight: 600; }
  .line.command { color: var(--vscode-charts-purple, #b180d7); }
  .line.group { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .line.debug { color: var(--vscode-descriptionForeground); }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="header">
  <span class="title" id="title">Log</span>
  <span class="badge" id="badge" hidden></span>
  <a id="openLink" href="#" hidden>Open in Azure DevOps</a>
</div>
<div id="log"><span class="empty">Select a step to view its log.</span></div>
<script nonce="${n}">
  const logEl = document.getElementById('log');
  const titleEl = document.getElementById('title');
  const badgeEl = document.getElementById('badge');
  const linkEl = document.getElementById('openLink');
  let started = false;

  const ANSI = /\\x1b\\[[0-9;]*m/g;

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }
  function classify(line) {
    if (line.startsWith('##[error]')) return { cls: 'error', text: line.slice(9) };
    if (line.startsWith('##[warning]')) return { cls: 'warning', text: line.slice(11) };
    if (line.startsWith('##[section]')) return { cls: 'section', text: line.slice(11) };
    if (line.startsWith('##[command]')) return { cls: 'command', text: line.slice(11) };
    if (line.startsWith('##[group]')) return { cls: 'group', text: line.slice(9) };
    if (line.startsWith('##[endgroup]')) return { cls: 'group', text: line.slice(12) };
    if (line.startsWith('##[debug]')) return { cls: 'debug', text: line.slice(9) };
    return { cls: '', text: line };
  }
  function append(lines) {
    if (!started) { logEl.innerHTML = ''; started = true; }
    const stick = atBottom();
    const frag = document.createDocumentFragment();
    for (const raw of lines) {
      const { cls, text } = classify(raw.replace(ANSI, ''));
      const div = document.createElement('div');
      div.className = 'line' + (cls ? ' ' + cls : '');
      div.textContent = text.length ? text : ' ';
      frag.appendChild(div);
    }
    logEl.appendChild(frag);
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  function setBadge(text, cls) {
    badgeEl.hidden = false;
    badgeEl.textContent = text;
    badgeEl.className = 'badge ' + cls;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'reset') {
      started = false;
      logEl.innerHTML = '<span class="empty">Loading…</span>';
      titleEl.textContent = m.header.title || 'Log';
      if (m.header.url) { linkEl.href = m.header.url; linkEl.hidden = false; }
      setBadge(m.header.inProgress ? 'live' : 'done', m.header.inProgress ? 'live' : 'done');
    } else if (m.type === 'append') {
      append(m.lines || []);
    } else if (m.type === 'done') {
      setBadge('done', 'done');
    } else if (m.type === 'error') {
      logEl.innerHTML = '<span class="empty">' + (m.message || 'Error') + '</span>';
    }
  });
</script>
</body>
</html>`;
}
