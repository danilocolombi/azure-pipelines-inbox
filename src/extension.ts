import * as vscode from 'vscode';
import { BuildResult } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { AuthService } from './auth/authService';
import { firstFailedLeaf, getMyId, getTimeline, resetUserCache } from './azure/builds';
import { AzureClient } from './azure/client';
import { enableActions } from './commands/actions';
import { copyLog } from './commands/copyLog';
import {
  cancelRunCommand,
  copyRunUrl,
  openPipelineInBrowser,
  openRunInBrowser,
  reRunCommand,
  reRunFailedCommand,
  runPipelineCommand
} from './commands/runActions';
import { manageSubscriptions } from './commands/subscriptions';
import { PollController } from './poll/pollController';
import {
  getActionsEnabled,
  getNotifyMode,
  getOnlyMyRuns,
  getStatusFilter,
  getSubscriptions,
  setOnlyMyRuns,
  setStatusFilter,
  StatusFilter
} from './state/config';
import { LogPanel } from './view/logPanel';
import { PipelinesTreeProvider } from './view/pipelinesTreeProvider';
import { RunsTreeProvider } from './view/runsTreeProvider';
import { RunNode, TimelineRecordNode } from './view/treeItems';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new AuthService(context.secrets);
  const client = new AzureClient(auth);
  const provider = new RunsTreeProvider(client);
  const pipelinesProvider = new PipelinesTreeProvider(client);
  const logPanel = new LogPanel(client);
  const poll = new PollController(provider, logPanel);
  context.subscriptions.push({
    dispose: () => {
      poll.dispose();
      logPanel.dispose();
    }
  });

  const view = vscode.window.createTreeView('azurePipelines.runs', {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false
  });
  context.subscriptions.push(view);

  // Runs that finished as failed since the inbox was last looked at — the "unread" count on
  // the status bar. Cleared when the user opens the Runs view (classic inbox semantics).
  const unreadFailures = new Set<number>();

  // While the Runs view is visible, keep polling so runs started elsewhere appear on their own.
  poll.setVisible(view.visible);
  context.subscriptions.push(
    view.onDidChangeVisibility((e) => {
      poll.setVisible(e.visible);
      if (e.visible && unreadFailures.size > 0) {
        unreadFailures.clear();
        void updateStatusBar();
      }
    })
  );

  const pipelinesView = vscode.window.createTreeView('azurePipelines.pipelines', {
    treeDataProvider: pipelinesProvider,
    showCollapseAll: true,
    canSelectMany: false
  });
  context.subscriptions.push(pipelinesView);

  const setExpandedContext = (expanded: boolean) =>
    vscode.commands.executeCommand('setContext', 'azurePipelines.treeExpanded', expanded);
  void setExpandedContext(true);
  context.subscriptions.push(
    view.onDidExpandElement(() => {
      void setExpandedContext(true);
      if (provider.hasActiveRuns()) poll.ensureRunning();
    }),
    view.onDidCollapseElement(() => void setExpandedContext(false))
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'azurePipelines.runs.focus';
  context.subscriptions.push(statusBar);

  const updateStatusBar = async () => {
    if (!(await auth.isSignedIn()) || getSubscriptions().length === 0) {
      statusBar.hide();
      view.badge = undefined;
      return;
    }
    const running = provider.getRunningCount();
    const failed = unreadFailures.size;
    if (running === 0 && failed === 0) {
      statusBar.hide();
      view.badge = undefined;
      return;
    }
    const text: string[] = [];
    const tip: string[] = [];
    if (running > 0) {
      text.push(`$(sync~spin) ${running} running`);
      tip.push(`${running} pipeline run${running > 1 ? 's' : ''} in progress`);
    }
    if (failed > 0) {
      text.push(`$(error) ${failed} failed`);
      tip.push(`${failed} run${failed > 1 ? 's' : ''} failed since you last opened the inbox`);
    }
    statusBar.text = text.join(' · ');
    statusBar.tooltip = tip.join('\n');
    statusBar.backgroundColor =
      failed > 0 ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    statusBar.show();
    // Surface the thing that needs attention: failures take the badge over a running count.
    view.badge =
      failed > 0
        ? { value: failed, tooltip: `${failed} failed` }
        : { value: running, tooltip: `${running} running` };
  };

  context.subscriptions.push(
    provider.onDidChangeRuns(() => {
      void updateStatusBar();
      if (provider.hasActiveRuns()) poll.ensureRunning();
    })
  );

  const refreshAllTrees = () => {
    provider.refresh();
    pipelinesProvider.refresh();
  };

  const refreshContext = async () => {
    const signedIn = await auth.isSignedIn();
    provider.setSignedIn(signedIn);
    pipelinesProvider.setSignedIn(signedIn);
    await vscode.commands.executeCommand('setContext', 'azurePipelines.signedIn', signedIn);
    await vscode.commands.executeCommand(
      'setContext',
      'azurePipelines.noSubscriptions',
      getSubscriptions().length === 0
    );
    await vscode.commands.executeCommand('setContext', 'azurePipelines.onlyMyRuns', getOnlyMyRuns());
    await vscode.commands.executeCommand(
      'setContext',
      'azurePipelines.actionsEnabled',
      getActionsEnabled()
    );
    await updateStatusBar();
  };

  // Open the first failed step of a run and jump straight to the error in its log.
  const openFirstError = async (node: RunNode): Promise<void> => {
    try {
      const timeline = await getTimeline(client, node.projectName, node.buildId);
      const failed = firstFailedLeaf(timeline?.records ?? []);
      if (!failed) {
        void vscode.window.showInformationMessage(
          'Azure Pipelines: no failed step found for this run.'
        );
        return;
      }
      await logPanel.show(new TimelineRecordNode(node.projectName, node.buildId, failed, false), {
        revealError: true
      });
      poll.ensureRunning();
    } catch {
      void vscode.window.showErrorMessage('Azure Pipelines: could not open the failed step.');
    }
  };

  // Toast when a tracked run finishes. `mine` (default) filters to runs you triggered.
  const notifyRunComplete = async (node: RunNode): Promise<void> => {
    const mode = getNotifyMode();
    if (mode === 'off') return;
    if (mode === 'mine') {
      const myId = await getMyId(client);
      if (!myId || node.build.requestedFor?.id !== myId) return;
    }
    const b = node.build;
    const name = `${b.definition?.name ?? 'Pipeline'} #${b.buildNumber ?? b.id}`;
    if (b.result === BuildResult.Failed) {
      const choice = await vscode.window.showErrorMessage(
        `${name} failed`,
        'View Errors',
        'Open in Azure DevOps'
      );
      if (choice === 'View Errors') await openFirstError(node);
      else if (choice === 'Open in Azure DevOps') await openRunInBrowser(node);
      return;
    }
    const verb =
      b.result === BuildResult.Succeeded
        ? 'succeeded'
        : b.result === BuildResult.PartiallySucceeded
          ? 'partially succeeded'
          : b.result === BuildResult.Canceled
            ? 'was canceled'
            : 'finished';
    const choice = await vscode.window.showInformationMessage(
      `${name} ${verb}`,
      'Open in Azure DevOps'
    );
    if (choice === 'Open in Azure DevOps') await openRunInBrowser(node);
  };

  context.subscriptions.push(
    provider.onDidCompleteRun((node) => {
      // Count a fresh failure on the status bar unless the inbox is already in view.
      if (node.build.result === BuildResult.Failed && !view.visible) {
        unreadFailures.add(node.buildId);
        void updateStatusBar();
      }
      void notifyRunComplete(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('azurePipelines.signIn', async () => {
      const ok = await auth.promptSignIn();
      if (ok) {
        client.invalidate();
        resetUserCache();
        await refreshContext();
        refreshAllTrees();
        vscode.window.showInformationMessage('Azure Pipelines: signed in.');
      }
    }),

    vscode.commands.registerCommand('azurePipelines.signOut', async () => {
      await auth.clearPat();
      client.invalidate();
      resetUserCache();
      await refreshContext();
      refreshAllTrees();
      vscode.window.showInformationMessage('Azure Pipelines: signed out.');
    }),

    vscode.commands.registerCommand('azurePipelines.refresh', async () => {
      await refreshContext();
      refreshAllTrees();
    }),

    vscode.commands.registerCommand('azurePipelines.expandAll', async () => {
      for (const node of provider.getProjectNodes()) {
        try {
          await view.reveal(node, { expand: true, select: false, focus: false });
        } catch {
          // ignore nodes that can't be revealed
        }
      }
      await setExpandedContext(true);
    }),
    vscode.commands.registerCommand('azurePipelines.collapseAll', async () => {
      await vscode.commands.executeCommand('workbench.actions.treeView.azurePipelines.runs.collapseAll');
      await setExpandedContext(false);
    }),

    vscode.commands.registerCommand('azurePipelines.manageSubscriptions', async () => {
      if (!(await auth.isSignedIn())) {
        const choice = await vscode.window.showWarningMessage(
          'Sign in to Azure DevOps first.',
          'Sign In'
        );
        if (choice === 'Sign In') await vscode.commands.executeCommand('azurePipelines.signIn');
        return;
      }
      await manageSubscriptions(client);
      await refreshContext();
      refreshAllTrees();
    }),

    vscode.commands.registerCommand('azurePipelines.toggleOnlyMine', async () => {
      await setOnlyMyRuns(false);
      await refreshContext();
      provider.refresh();
    }),
    vscode.commands.registerCommand('azurePipelines.toggleOnlyMineOff', async () => {
      await setOnlyMyRuns(true);
      await refreshContext();
      provider.refresh();
    }),

    vscode.commands.registerCommand('azurePipelines.setStatusFilter', async () => {
      const current = getStatusFilter();
      const options: { label: string; value: StatusFilter }[] = [
        { label: 'All', value: 'all' },
        { label: 'Succeeded', value: 'succeeded' },
        { label: 'Failed', value: 'failed' }
      ];
      const picked = await vscode.window.showQuickPick(
        options.map((o) => ({ label: o.label, description: o.value === current ? '(current)' : '', value: o.value })),
        { title: 'Filter runs by status', placeHolder: 'Pick a status filter' }
      );
      if (!picked) return;
      await setStatusFilter(picked.value);
      await refreshContext();
      provider.refresh();
    }),

    vscode.commands.registerCommand('azurePipelines.viewLogs', async (node) => {
      if (node instanceof TimelineRecordNode) {
        await logPanel.show(node);
        poll.ensureRunning();
      }
    }),

    vscode.commands.registerCommand('azurePipelines.viewFirstError', async (node) => {
      if (node instanceof RunNode) await openFirstError(node);
    }),

    vscode.commands.registerCommand('azurePipelines.openInBrowser', openRunInBrowser),
    vscode.commands.registerCommand('azurePipelines.openPipelineInBrowser', openPipelineInBrowser),
    vscode.commands.registerCommand('azurePipelines.copyRunUrl', copyRunUrl),

    vscode.commands.registerCommand('azurePipelines.copyLogForAI', (node) =>
      copyLog(client, node, 'ai')
    ),
    vscode.commands.registerCommand('azurePipelines.copyLog', (node) =>
      copyLog(client, node, 'plain')
    ),

    // Write actions are optimistic — tried with the current token, prompting for a
    // write-scoped PAT only if Azure refuses (see runWriteAction in commands/actions.ts).
    vscode.commands.registerCommand('azurePipelines.cancelRun', async (node) => {
      if (await cancelRunCommand(auth, client, node)) {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('azurePipelines.reRun', async (node) => {
      if (await reRunCommand(auth, client, node)) {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('azurePipelines.reRunFailed', async (node) => {
      if (await reRunFailedCommand(auth, client, node)) {
        refreshAllTrees();
        poll.ensureRunning();
      }
    }),
    vscode.commands.registerCommand('azurePipelines.runPipeline', async (node) => {
      if (await runPipelineCommand(auth, client, node)) {
        refreshAllTrees();
        poll.ensureRunning();
      }
    }),

    vscode.commands.registerCommand('azurePipelines.enableActions', async () => {
      if (await enableActions(auth, client)) await refreshContext();
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('azurePipelines')) return;
      await refreshContext();
      if (e.affectsConfiguration('azurePipelines.pollSeconds')) poll.restart();
      if (
        e.affectsConfiguration('azurePipelines.subscriptions') ||
        e.affectsConfiguration('azurePipelines.onlyMyRuns') ||
        e.affectsConfiguration('azurePipelines.statusFilter') ||
        e.affectsConfiguration('azurePipelines.branchFilter') ||
        e.affectsConfiguration('azurePipelines.runsTop')
      ) {
        provider.refresh();
      }
      // The catalog ignores the inbox filters; only subscriptions and history depth matter.
      if (
        e.affectsConfiguration('azurePipelines.subscriptions') ||
        e.affectsConfiguration('azurePipelines.runsTop')
      ) {
        pipelinesProvider.refresh();
      }
    })
  );

  await refreshContext();
}

export function deactivate(): void {
  // PollController + LogPanel are disposed via context.subscriptions.
}
