# Changelog

## 0.1.7

- **README**: link to the new companion extension
  **[Azure Pull Requests Inbox](https://marketplace.visualstudio.com/items?itemName=danilocolombi.azure-pull-requests-inbox)**
  — your team's pull requests in the sidebar, with the ones that need your review pinned on top.
- Dev-dependency update (esbuild 0.28). No functional changes.

## 0.1.4

- Run actions no longer show an upfront token-setup dialog. An action is tried with your current
  token first — if it already has **Build (Read & Execute)** it just works, and run actions are
  enabled automatically. Only when Azure refuses are you walked through the one-time token upgrade,
  after which the action is retried. An expired write token now also leads straight into the update
  prompt instead of a dead-end error.

## 0.1.3

- **Re-run Pipeline** and **Re-run Failed Jobs** moved from hover buttons to the run's right-click
  menu. They queue a build immediately with no confirmation, so they no longer sit where a stray
  click can land; failed rows keep just the read-only **View First Error** and **Open in Browser**
  hover buttons.

## 0.1.2

- Docs: benefit-led README intro.

## 0.1.1

- Docs: README overhaul — document run-completion notifications and the jump-to-first-error action,
  introduce the Pipelines view, add an Install section (Marketplace + Open VSX), and place screenshots
  inline instead of in a standalone gallery.

## 0.1.0

Initial release.

- **Runs inbox** — a tree of recent runs across subscribed projects, with live status icons that update
  in place.
- **Live timeline** — expand a run to watch its Stage → Job → Task tree update while it runs.
- **Live log tail** — open any step's log in a webview that appends new lines as the step runs, with
  `##[error]`/`##[warning]`/`##[section]` highlighting.
- **Copy for AI** / **Copy log** on any log-bearing step. "Copy for AI" prepends run context (pipeline,
  step, result, branch, link) and, for logs over ~2,000 lines, extracts the windows around each
  `##[error]`/`##[warning]` plus the tail so the relevant part fits an AI chat's context window.
  "Copy log" copies the full raw text (ANSI stripped).
- **Run actions** — Run a pipeline (▶ on each pipeline in the Pipelines view, with a branch prompt),
  cancel an in-progress run, re-run a whole pipeline, or re-run only the failed jobs of a failed run.
  Always visible but read-only by default: the first use walks you through a one-time write-token setup.
- **Re-run Failed Jobs** retries only the failed stages in place (the same run returns to in-progress),
  mirroring the web UI's "Rerun failed jobs"; classic (stage-less) pipelines fall back to a full re-run.
- **Filters** — only my runs, status (all / succeeded / failed), and branch.
- **Status bar** — a `▶ N running` / `✖ N failed` summary while the sidebar is closed; the failed count
  tracks runs that failed since you last opened the inbox and clears when you open the Runs view.
- **Notifications** when a tracked run finishes (configurable: off / mine / all), with a shortcut to the
  first error on failure.
