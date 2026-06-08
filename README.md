# Azure Pipelines Inbox

Watch your Azure DevOps **pipeline runs live** from VS Code's sidebar — the timeline (stages →
jobs → tasks) and logs update as the run executes. A companion to
[Azure Boards Inbox](https://marketplace.visualstudio.com/items?itemName=danilocolombi.azure-boards-inbox).

## Features

- **Runs inbox** — a tree of recent runs per subscribed project, with status icons that update in place.
- **Live timeline** — expand a run to see its Stage → Job → Task tree; in-progress steps spin and flip to
  pass/fail as they finish.
- **Live log tail** — open the logs for any step in a rich panel that appends new lines while the step runs,
  with `##[error]` / `##[warning]` / `##[section]` highlighting.
- **Filters** — only my runs, status (all / in progress / completed), and branch.
- **Run actions** *(opt-in)* — cancel and re-run pipelines once you enable a write-scoped token.

It polls only while something is in progress, then goes idle.

## Getting started

1. Run **Azure Pipelines: Sign In** and enter your organization URL (e.g. `https://dev.azure.com/contoso`)
   and a Personal Access Token with **Build (Read)** and **Project and Team (Read)** scopes.
2. Run **Azure Pipelines: Manage Subscriptions** and pick the projects whose pipelines you want to see.
3. Expand a run to watch its timeline; click a step (or use **View Logs**) to tail its log.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `azurePipelines.organizationUrl` | `""` | Azure DevOps organization URL. |
| `azurePipelines.subscriptions` | `[]` | Subscribed projects (managed via Manage Subscriptions). |
| `azurePipelines.onlyMyRuns` | `false` | Only show runs you triggered. |
| `azurePipelines.statusFilter` | `all` | `all` / `inProgress` / `completed`. |
| `azurePipelines.branchFilter` | `""` | Only show runs for this branch. |
| `azurePipelines.runsTop` | `25` | Max runs listed per project. |
| `azurePipelines.pollSeconds` | `4` | Poll interval (seconds) for in-progress runs and tailing logs. |
| `azurePipelines.enableActions` | `false` | Enable Cancel / Re-run (prompts for a Build Read & Execute PAT). |

## Run actions (cancel / re-run)

These are off by default so the extension only needs a read-only token. Run
**Azure Pipelines: Enable Run Actions** to provide a PAT with **Build (Read & Execute)**; the
context-menu actions then appear on each run.

## How "live" works

Azure DevOps has no public push API; its own web UI builds the live view by polling. This extension
does the same via `azure-devops-node-api`: it polls the **build timeline** to update the step tree and
re-reads the active step's **log lines** from an advancing offset to append output. Polling runs only
while a run is in progress.

## Development

```sh
npm install
npm run build      # esbuild bundle → dist/extension.js
npm run watch      # rebuild on change (for F5)
npm run compile    # tsc --noEmit type-check
npm run lint
```

Press **F5** to launch the Extension Development Host.

> Note: add a 128×128 `media/icon.png` and reference it via the `icon` field in `package.json` before
> publishing to the Marketplace.
