import * as vscode from 'vscode';
import { AuthService } from './auth/authService';
import { resetUserCache } from './azure/builds';
import { AzureClient } from './azure/client';
import { enableActions } from './commands/actions';
import {
  cancelRunCommand,
  copyRunUrl,
  openRunInBrowser,
  reRunCommand
} from './commands/runActions';
import { manageSubscriptions } from './commands/subscriptions';
import { PollController } from './poll/pollController';
import {
  getActionsEnabled,
  getOnlyMyRuns,
  getStatusFilter,
  getSubscriptions,
  setOnlyMyRuns,
  setStatusFilter,
  StatusFilter
} from './state/config';
import { LogPanel } from './view/logPanel';
import { RunsTreeProvider } from './view/runsTreeProvider';
import { TimelineRecordNode } from './view/treeItems';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = new AuthService(context.secrets);
  const client = new AzureClient(auth);
  const provider = new RunsTreeProvider(client);
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
    if (running > 0) {
      statusBar.text = `$(sync~spin) ${running} running`;
      statusBar.tooltip = `${running} pipeline run${running > 1 ? 's' : ''} in progress`;
      statusBar.show();
      view.badge = { value: running, tooltip: `${running} running` };
    } else {
      statusBar.hide();
      view.badge = undefined;
    }
  };

  context.subscriptions.push(
    provider.onDidChangeRuns(() => {
      void updateStatusBar();
      if (provider.hasActiveRuns()) poll.ensureRunning();
    })
  );

  const refreshContext = async () => {
    const signedIn = await auth.isSignedIn();
    provider.setSignedIn(signedIn);
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

  context.subscriptions.push(
    vscode.commands.registerCommand('azurePipelines.signIn', async () => {
      const ok = await auth.promptSignIn();
      if (ok) {
        client.invalidate();
        resetUserCache();
        await refreshContext();
        provider.refresh();
        vscode.window.showInformationMessage('Azure Pipelines: signed in.');
      }
    }),

    vscode.commands.registerCommand('azurePipelines.signOut', async () => {
      await auth.clearPat();
      client.invalidate();
      resetUserCache();
      await refreshContext();
      provider.refresh();
      vscode.window.showInformationMessage('Azure Pipelines: signed out.');
    }),

    vscode.commands.registerCommand('azurePipelines.refresh', async () => {
      await refreshContext();
      provider.refresh();
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
      provider.refresh();
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
        { label: 'In progress', value: 'inProgress' },
        { label: 'Completed', value: 'completed' }
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

    vscode.commands.registerCommand('azurePipelines.openInBrowser', openRunInBrowser),
    vscode.commands.registerCommand('azurePipelines.copyRunUrl', copyRunUrl),

    vscode.commands.registerCommand('azurePipelines.cancelRun', async (node) => {
      if (await cancelRunCommand(client, node)) {
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('azurePipelines.reRun', async (node) => {
      if (await reRunCommand(client, node)) {
        provider.refresh();
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
    })
  );

  await refreshContext();
}

export function deactivate(): void {
  // PollController + LogPanel are disposed via context.subscriptions.
}
