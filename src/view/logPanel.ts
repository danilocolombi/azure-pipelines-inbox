import * as vscode from 'vscode';
import { TimelineRecordState } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AzureClient } from '../azure/client';
import { getTimeline } from '../azure/builds';
import { getLogLines } from '../azure/logs';
import { copyLog, CopyMode } from '../commands/copyLog';
import { getOrganizationUrl } from '../state/config';
import { TimelineRecordNode } from './treeItems';

interface Current {
  projectName: string;
  buildId: number;
  logId?: number; // undefined until the step starts producing output
  recordId: string;
  title: string;
  url: string;
  nextLine: number; // 1-based next line to fetch
  state: TimelineRecordState | undefined;
  active: boolean; // pending or in progress → keep tailing
  loading: boolean;
  revealError: boolean; // jump to the first error line once the log is loaded
}

/**
 * A single reusable webview panel that shows one step's log and tails it while the
 * step runs. Opening logs for another step retargets the same panel.
 */
export class LogPanel {
  private panel?: vscode.WebviewPanel;
  private current?: Current;

  constructor(private readonly client: AzureClient) {}

  async show(node: TimelineRecordNode, opts?: { revealError?: boolean }): Promise<void> {
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
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === 'copy') void this.copyCurrent(m.mode === 'plain' ? 'plain' : 'ai');
      });
    }

    const state = node.record.state;
    const title = node.record.name ?? 'Log';
    this.panel.title = `Log · ${title}`;
    this.panel.webview.html = renderHtml(this.panel.webview);
    this.current = {
      projectName: node.projectName,
      buildId: node.buildId,
      logId: node.record.log?.id,
      recordId: node.record.id ?? '',
      title,
      url: `${getOrganizationUrl()}/${encodeURIComponent(node.projectName)}/_build/results?buildId=${node.buildId}&view=logs`,
      nextLine: 1,
      state,
      active:
        state === TimelineRecordState.InProgress || state === TimelineRecordState.Pending,
      loading: true,
      revealError: opts?.revealError ?? false
    };
    this.panel.reveal(vscode.ViewColumn.Active, false);
    await this.loadInitial();
  }

  /** Copy the currently shown step's log, triggered by the header buttons. */
  private async copyCurrent(mode: CopyMode): Promise<void> {
    const c = this.current;
    if (!c) return;
    const target =
      typeof c.logId === 'number'
        ? {
            projectName: c.projectName,
            buildId: c.buildId,
            logId: c.logId,
            recordId: c.recordId,
            stepName: c.title
          }
        : undefined;
    const result = await copyLog(this.client, target, mode, { silent: true });
    if (!result) return;
    const label =
      mode === 'ai'
        ? 'Copied for AI'
        : `Copied ${result.totalLines} line${result.totalLines === 1 ? '' : 's'}`;
    this.post({ type: 'copied', mode, label });
  }

  /** True while a step is open and still active, so the poll controller keeps ticking. */
  isTailing(): boolean {
    return !!this.panel && !!this.current && this.current.active;
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private async loadInitial(): Promise<void> {
    const c = this.current;
    if (!c) return;
    // The tree node may be stale (opened while pending, before a log id existed). Resolve
    // the current state + log from a fresh timeline so a finished step loads right away
    // instead of being stuck on a "waiting" message until a poll tick happens to run.
    if (typeof c.logId !== 'number') {
      await this.resolveFromTimeline(c);
      if (this.current !== c) return;
    }
    this.post({
      type: 'reset',
      header: { title: c.title, url: c.url, inProgress: c.active, hasLog: typeof c.logId === 'number' }
    });
    if (typeof c.logId !== 'number') {
      // Still no log: say why instead of leaving the click feeling dead. If the step is
      // still active, pollAppend adopts the log once it appears.
      this.post({ type: 'status', message: noLogMessage(c.state) });
      c.loading = false;
      return;
    }
    try {
      const lines = await getLogLines(this.client, c.projectName, c.buildId, c.logId, c.nextLine);
      if (this.current !== c) return;
      if (lines.length) {
        this.post({ type: 'append', lines });
        c.nextLine += lines.length;
      }
      if (c.revealError) this.post({ type: 'revealError' });
    } catch {
      this.post({ type: 'error', message: 'Could not load log output yet.' });
    } finally {
      c.loading = false;
      if (!c.active) this.post({ type: 'done' });
    }
  }

  /** Refresh state + log id for the open step from a fresh timeline fetch. */
  private async resolveFromTimeline(c: Current): Promise<void> {
    let timeline;
    try {
      timeline = await getTimeline(this.client, c.projectName, c.buildId);
    } catch {
      return; // Fetch failed; keep the current snapshot and let the next tick retry.
    }
    if (this.current !== c) return;
    const rec = timeline?.records?.find((r) => r.id === c.recordId);
    c.state = rec?.state;
    c.active =
      rec?.state === TimelineRecordState.InProgress ||
      rec?.state === TimelineRecordState.Pending;
    if (typeof rec?.log?.id === 'number') c.logId = rec.log.id;
  }

  /** Called each poll tick. Returns whether the step is still active. */
  async pollAppend(): Promise<boolean> {
    const c = this.current;
    if (!this.panel || !c || c.loading || !c.active) return false;
    try {
      const hadLog = typeof c.logId === 'number';
      await this.resolveFromTimeline(c);
      if (this.current !== c) return false;

      // The log id only shows up once the step starts producing output — when it does,
      // reveal the copy buttons that were hidden while there was nothing to copy.
      if (!hadLog && typeof c.logId === 'number') this.post({ type: 'logAvailable' });

      if (typeof c.logId === 'number') {
        const lines = await getLogLines(this.client, c.projectName, c.buildId, c.logId, c.nextLine);
        if (this.current !== c) return false;
        if (lines.length) {
          this.post({ type: 'append', lines });
          c.nextLine += lines.length;
        }
      }

      if (!c.active) {
        if (typeof c.logId !== 'number') {
          this.post({ type: 'status', message: 'This step finished without producing a log.' });
        }
        this.post({ type: 'done' });
      }
      return c.active;
    } catch {
      return c.active;
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/** Message shown when a step has no log to display, keyed to where it is in its lifecycle. */
function noLogMessage(state: TimelineRecordState | undefined): string {
  switch (state) {
    case TimelineRecordState.InProgress:
      return 'Waiting for log output…';
    case TimelineRecordState.Pending:
      return 'This step hasn’t started yet.';
    default:
      return 'No log is available for this step.';
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
  /* Use the editor background (not editorGroupHeader-tabsBackground): the tabs strip sitting
     directly above uses that token, so matching it fuses the two into one block and the header
     content reads as pushed off-center. The editor color is distinct from the tabs above. */
  .header { display: flex; flex: none; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); background: var(--vscode-editor-background, transparent); }
  .header .title { font-weight: 600; font-size: 0.95em; line-height: 26px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .header .actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex: none; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; box-sizing: border-box; font-family: inherit; font-size: 0.85em; line-height: 1; padding: 0 10px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; white-space: nowrap; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn svg { display: block; flex: none; }
  .btn.copied svg { color: var(--vscode-charts-green, #89d185); }
  /* "Open in Azure DevOps" reads as a button so it sits at the same visual weight as the others. */
  .btn.ghost { background: transparent; border-color: var(--vscode-button-border, rgba(128,128,128,0.35)); color: var(--vscode-foreground); text-decoration: none; }
  .btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); }
  .badge { display: inline-flex; align-items: center; gap: 5px; height: 26px; box-sizing: border-box; font-size: 0.78em; font-weight: 600; letter-spacing: 0.02em; padding: 0 9px; border-radius: 13px; text-transform: uppercase; flex: none; }
  .badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .badge.live { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 18%, transparent); color: var(--vscode-charts-blue, #3794ff); }
  .badge.live .dot { animation: pulse 1.4s ease-in-out infinite; }
  .badge.done { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  /* Error nav: one bordered pill grouping the count with the prev/next steppers. */
  .errnav { display: inline-flex; align-items: center; gap: 2px; height: 26px; box-sizing: border-box; padding: 0 3px 0 9px; border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 45%, transparent); border-radius: 13px; flex: none; }
  .errcount { font-size: 0.8em; font-weight: 600; color: var(--vscode-errorForeground); white-space: nowrap; }
  .btn.mini { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border-radius: 6px; background: transparent; color: var(--vscode-errorForeground); }
  .btn.mini:hover { background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 22%, transparent); }
  #log { flex: 1; overflow: auto; padding: 8px 14px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .line { display: block; }
  .line.error { color: var(--vscode-errorForeground); }
  .line.warning { color: var(--vscode-editorWarning-foreground, #cca700); }
  .line.section { color: var(--vscode-charts-blue, #3794ff); font-weight: 600; }
  .line.command { color: var(--vscode-charts-purple, #b180d7); }
  .line.group { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .line.debug { color: var(--vscode-descriptionForeground); }
  .line.flash { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.25)); }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="header">
  <span class="title" id="title">Log</span>
  <span class="badge" id="badge" hidden><span class="dot"></span><span id="badgeText"></span></span>
  <span class="errnav" id="errnav" hidden>
    <span class="errcount" id="errCount"></span>
    <button class="btn mini" id="errPrev" title="Jump to previous error"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button>
    <button class="btn mini" id="errNext" title="Jump to next error"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
  </span>
  <span class="actions">
    <button class="btn primary" id="copyAi" title="Copy this log with run context, trimmed to errors + context, ready to paste into an AI chat" hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 2L9.3 6.7L14 8L9.3 9.3L8 14L6.7 9.3L2 8L6.7 6.7Z"/></svg><span>Copy for AI</span></button>
    <button class="btn" id="copyRaw" title="Copy the full raw log text" hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="8.5" rx="1"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"/></svg><span>Copy log</span></button>
    <a class="btn ghost" id="openLink" href="#" title="Open this run in Azure DevOps" hidden><span>Open in Azure DevOps</span><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9.5 2.5H13.5V6.5M13 3L7 9"/></svg></a>
  </span>
</div>
<div id="log"><span class="empty">Select a step to view its log.</span></div>
<script nonce="${n}">
  const vscodeApi = acquireVsCodeApi();
  const logEl = document.getElementById('log');
  const titleEl = document.getElementById('title');
  const badgeEl = document.getElementById('badge');
  const badgeTextEl = document.getElementById('badgeText');
  const linkEl = document.getElementById('openLink');
  const copyAiBtn = document.getElementById('copyAi');
  const copyRawBtn = document.getElementById('copyRaw');
  const errnavEl = document.getElementById('errnav');
  const errCountEl = document.getElementById('errCount');
  let started = false;
  let errorLines = [];
  let curError = -1;

  copyAiBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'copy', mode: 'ai' }));
  copyRawBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'copy', mode: 'plain' }));
  document.getElementById('errPrev').addEventListener('click', () => step(-1));
  document.getElementById('errNext').addEventListener('click', () => step(1));
  function setCopyVisible(v) { copyAiBtn.hidden = !v; copyRawBtn.hidden = !v; }

  const CHECK_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>';
  function flashCopied(mode, label) {
    const btn = mode === 'ai' ? copyAiBtn : copyRawBtn;
    if (btn._t) clearTimeout(btn._t);
    if (!btn._orig) btn._orig = btn.innerHTML;
    btn.innerHTML = CHECK_SVG + '<span>' + label + '</span>';
    btn.classList.add('copied');
    btn._t = setTimeout(() => { btn.innerHTML = btn._orig; btn.classList.remove('copied'); btn._t = null; }, 1500);
  }

  function updateErrNav() {
    const n = errorLines.length;
    errnavEl.hidden = n === 0;
    errCountEl.textContent = n + (n === 1 ? ' error' : ' errors');
  }
  function gotoError(i) {
    if (errorLines.length === 0) return;
    curError = (i + errorLines.length) % errorLines.length;
    const el = errorLines[curError];
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }
  function step(dir) { gotoError(curError < 0 ? 0 : curError + dir); }

  const ANSI = /\\x1b\\[[0-9;]*m/g;

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }
  // Azure prefixes each line with an ISO timestamp; strip it before matching ##[...] markers,
  // then keep it in the displayed text.
  const TS = /^(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\s)/;
  function classify(raw) {
    const m = raw.match(TS);
    const prefix = m ? m[1] : '';
    const line = m ? raw.slice(m[1].length) : raw;
    if (line.startsWith('##[error]')) return { cls: 'error', text: prefix + line.slice(9) };
    if (line.startsWith('##[warning]')) return { cls: 'warning', text: prefix + line.slice(11) };
    if (line.startsWith('##[section]')) return { cls: 'section', text: prefix + line.slice(11) };
    if (line.startsWith('##[command]')) return { cls: 'command', text: prefix + line.slice(11) };
    if (line.startsWith('##[group]')) return { cls: 'group', text: prefix + line.slice(9) };
    if (line.startsWith('##[endgroup]')) return { cls: 'group', text: prefix + line.slice(12) };
    if (line.startsWith('##[debug]')) return { cls: 'debug', text: prefix + line.slice(9) };
    return { cls: '', text: prefix + line };
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
      if (cls === 'error') errorLines.push(div);
      frag.appendChild(div);
    }
    logEl.appendChild(frag);
    if (stick) logEl.scrollTop = logEl.scrollHeight;
    updateErrNav();
  }
  function setBadge(text, cls) {
    badgeEl.hidden = false;
    badgeTextEl.textContent = text;
    badgeEl.className = 'badge ' + cls;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'reset') {
      started = false;
      errorLines = [];
      curError = -1;
      updateErrNav();
      logEl.innerHTML = '<span class="empty">Loading…</span>';
      titleEl.textContent = m.header.title || 'Log';
      if (m.header.url) { linkEl.href = m.header.url; linkEl.hidden = false; }
      setCopyVisible(!!m.header.hasLog);
      setBadge(m.header.inProgress ? 'live' : 'done', m.header.inProgress ? 'live' : 'done');
    } else if (m.type === 'append') {
      append(m.lines || []);
    } else if (m.type === 'revealError') {
      gotoError(0);
    } else if (m.type === 'logAvailable') {
      setCopyVisible(true);
    } else if (m.type === 'copied') {
      flashCopied(m.mode, m.label || 'Copied');
    } else if (m.type === 'done') {
      setBadge('done', 'done');
    } else if (m.type === 'status') {
      started = false;
      logEl.innerHTML = '<span class="empty">' + (m.message || '') + '</span>';
    } else if (m.type === 'error') {
      logEl.innerHTML = '<span class="empty">' + (m.message || 'Error') + '</span>';
    }
  });
</script>
</body>
</html>`;
}
