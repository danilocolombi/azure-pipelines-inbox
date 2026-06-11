# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code / Cursor extension ("Azure Pipelines Inbox", id `azure-pipelines-inbox`,
command/config namespace `azurePipelines.*`) that shows Azure DevOps pipeline runs in an
activity-bar tree, with a live Stage → Job → Task timeline and a tailing log webview. It is a
companion to the author's published `azure-boards-inbox` extension and mirrors its stack and
conventions.

## Commands

```sh
npm install
npm run build      # esbuild production bundle → dist/extension.js (minified, no sourcemap)
npm run watch      # esbuild watch; required for F5 Extension Development Host debugging
npm run compile    # tsc --noEmit — the type-check; esbuild does NOT type-check
npm run lint       # eslint src --ext ts
```

Press **F5** in VS Code to launch the Extension Development Host. There is no test suite.
`npm run compile` + `npm run lint` are the full local verification.

`esbuild.js` bundles `src/extension.ts` to CommonJS with `vscode` marked external. Because
esbuild strips types without checking them, **always run `npm run compile` to catch type
errors** — a build passing does not mean the types are sound.

## Architecture

`activate()` in [src/extension.ts](src/extension.ts) wires everything: it constructs the
service graph, creates the single tree view + status bar, and registers every command and the
config-change listener. Trace command flow from there.

**Service graph (constructed once in `activate`):**
- `AuthService` ([src/auth/authService.ts](src/auth/authService.ts)) — PAT stored in
  `context.secrets` (SecretStorage); org URL lives in settings. "Signed in" = PAT present AND
  org URL set. `promptWritePat()` overwrites the PAT with a write-scoped one for the opt-in
  actions; a Build (Read & Execute) PAT is a superset of read, so it keeps read features working.
- `AzureClient` ([src/azure/client.ts](src/azure/client.ts)) — wraps `azure-devops-node-api`,
  caching one `WebApi` connection keyed by org URL + PAT fingerprint. Call `invalidate()` after
  any sign-in/out or PAT change. `isUnauthorized(err)` classifies 401/403 + Azure TF error codes.
- `RunsTreeProvider` ([src/view/runsTreeProvider.ts](src/view/runsTreeProvider.ts)) — the
  `TreeDataProvider`. Holds all run state in two maps (`projectRuns` per project, `timelines`
  per buildId). Exposes two events: `onDidChangeTreeData` (redraw) and `onDidChangeRuns` (the
  set/status of runs changed — drives the status bar and re-arms polling).
- `LogPanel` ([src/view/logPanel.ts](src/view/logPanel.ts)) — one reusable webview that tails a
  single step's log; opening another step retargets the same panel. Tailing appends from a
  1-based `nextLine` cursor. The webview HTML/JS is inline in this file (CSP + nonce); it
  classifies `##[error|warning|section|command|group|debug]` prefixes for styling.
- `PollController` ([src/poll/pollController.ts](src/poll/pollController.ts)) — see below.

**The "live" model is polling, not push.** Azure DevOps has no public push API. A single
`PollController` timer ticks every `pollSeconds`, calling `provider.pollActiveRuns()` and
`logPanel.pollAppend()`. It runs **only while something is active** (an in-progress run in the
tree, or an open tailing log) and **stops itself** when both return false. Re-arm it with
`ensureRunning()` whenever new activity might appear — after a refresh, on tree expansion, or
when a log opens. `pollActiveRuns()` re-fetches each active run (and its timeline, only if
already expanded/cached) and updates nodes in place via `runNode.update()`. SignalR was
deliberately rejected as undocumented/unsupported for a marketplace extension.

**Tree node types** ([src/view/treeItems.ts](src/view/treeItems.ts)): `ProjectNode` →
`RunNode` → `TimelineRecordNode` (self-nesting via `childRecords()` parent/order linking) plus
`MessageNode` for loading/empty/error rows. This file also owns all status→icon/label/duration
formatting. `contextValue`s (`run`, `run.active`, `timelineRecord.log`, …) drive the
`when` clauses for menu/context contributions in `package.json`.

**Azure API calls** live in [src/azure/builds.ts](src/azure/builds.ts) (list/get builds,
timeline, cancel via `updateBuild` status=Cancelling, re-run via `queueBuild`) and
[src/azure/logs.ts](src/azure/logs.ts) (`getBuildLogLines` with an advancing `startLine` for
tailing). `isActiveStatus()` here is the single source of truth for "is this run still
running" — used by the provider, poll controller, and tree icons.

**Config** is centralized in [src/state/config.ts](src/state/config.ts) — every setting has a
typed getter (with validation/clamping) and, where writable, a setter. All settings use
`ConfigurationTarget.Global` / `application` scope (the extension is org-wide, not per-workspace).
Do not call `vscode.workspace.getConfiguration` directly elsewhere; add a getter here instead.

**State synchronization gotcha:** several pieces of UI state are exposed both as a setting and a
VS Code context key (`setContext`) so `package.json` `when` clauses can react. `refreshContext()`
in `extension.ts` is the one place that re-pushes all context keys + the status bar; call it after
anything that changes sign-in, subscriptions, filters, or `enableActions`. Memoized state (the
`AzureClient` connection and the `cachedUser` in `builds.ts`) must be invalidated on sign-in/out —
`resetUserCache()` + `client.invalidate()`.

## Run actions are read-only-first

The extension only needs a read-only PAT by default. Write actions (run/cancel/re-run) are
always visible but go through `runWriteAction()` in
[src/commands/actions.ts](src/commands/actions.ts): the call is tried optimistically with the
current token; success silently flips `azurePipelines.enableActions` (default false), and only an
unauthorized rejection prompts for a write-scoped PAT (then retries once). Mirror this philosophy
(read-only by default, prompt only when Azure refuses) for any new write operation.

## Publishing

Push a `v*.*.*` git tag (matching `version` in `package.json`) to trigger
[.github/workflows/publish.yml](.github/workflows/publish.yml), which type-checks, builds,
packages the `.vsix`, and dual-publishes to the **VS Code Marketplace** (`VSCE_PAT` secret) and
**Open VSX** (`OVSX_PAT` secret — this is what Cursor/VSCodium/Windsurf install from), then
attaches the `.vsix` to a GitHub Release. The workflow fails if the tag version ≠ package.json
version.

> The Marketplace icon is `media/icon.png` (128×128), referenced via the `icon` field in
> `package.json`. It is generated by `scripts/gen-icon.js` (pure Node, no deps) — run
> `node scripts/gen-icon.js` to regenerate after editing the design.
