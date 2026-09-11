import * as vscode from 'vscode';

import { BridgeProcess, LOG_FILE } from './bridgeProcess';
import { SwitchboardPanel } from './panel';
import { wireCopilot } from './copilotConfig';
import { isClaudeWired, unwireClaudeCode, wireClaudeCode } from './claudeConfig';
import {
  DIRECT_KEY,
  PROVIDER_IDS,
  ProviderId,
  getDirectKey,
  getPats,
  missingForProvider,
  patKey,
  promptForSecret,
  readSettings,
  updateSetting,
} from './settings';

/** Anything baked into the child process needs a restart to take effect. */
const RESTART_ON = [
  'switchboard.listenHost',
  'switchboard.listenPort',
  'switchboard.genai',
  'switchboard.bedrock',
  'switchboard.direct',
  'switchboard.includeUsage',
  'switchboard.forceNonStreaming',
  'switchboard.verbose',
];

const LABELS: Record<ProviderId, string> = {
  genai: 'GenAI platform',
  bedrock: 'AWS Bedrock',
  direct: 'Direct',
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Switchboard');
  const bridge = new BridgeProcess(context, output);
  context.subscriptions.push(output, bridge);

  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  // Give it text before any async work: an item with empty text renders as
  // nothing, which looks identical to the extension having failed to load.
  statusItem.text = '$(debug-disconnect) Switchboard: off';
  statusItem.tooltip = 'Switchboard is starting up.';
  statusItem.command = 'switchboard.start';
  statusItem.show();
  context.subscriptions.push(statusItem);

  /* ---------------- shared operations ---------------- */

  async function credentials() {
    return { pats: await getPats(context), directKey: await getDirectKey(context) };
  }

  async function activeProvider(): Promise<ProviderId> {
    const live = await bridge.status();
    const id = live.running ? live.active : readSettings().activeProvider;
    return (PROVIDER_IDS as readonly string[]).includes(id) ? (id as ProviderId) : 'genai';
  }

  async function updateStatusBar(): Promise<void> {
    const status = await bridge.status();
    if (!status.running) {
      statusItem.text = '$(debug-disconnect) Switchboard: off';
      statusItem.tooltip = 'Switchboard is not running. Click to start.';
      statusItem.backgroundColor = undefined;
      statusItem.command = 'switchboard.start';
      return;
    }

    const id = status.active as ProviderId;
    const provider = status.providers[id];
    const label = provider?.label ?? LABELS[id] ?? id;

    statusItem.text =
      id === 'direct' ? `$(globe) Switchboard: ${label}` : `$(arrow-swap) Switchboard: ${label}`;
    statusItem.tooltip =
      id === 'direct'
        ? 'Routing straight to Anthropic. Click to choose another upstream.'
        : `Routing through ${provider?.url || label}. Click to choose another upstream.`;
    statusItem.backgroundColor =
      id === 'direct'
        ? undefined
        : new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.command = 'switchboard.selectProvider';
  }

  async function start(silent = false): Promise<void> {
    const settings = readSettings();
    const { pats, directKey } = await credentials();

    const chosen = settings.activeProvider;
    const anyUsable =
      Boolean(settings.providers.genai.url) ||
      Boolean(settings.providers.bedrock.url) ||
      Boolean(directKey);

    if (!anyUsable) {
      const missing =
        chosen === 'direct'
          ? ['an Anthropic API key']
          : missingForProvider(
              settings.providers[chosen === 'bedrock' ? 'bedrock' : 'genai'],
              Boolean(pats[chosen]),
            );
      output.appendLine(`[extension] not starting; still needs ${missing.join(', ')}`);
      await updateStatusBar();
      if (!silent) {
        const SETTINGS = 'Open settings';
        const choice = await vscode.window.showWarningMessage(
          `Switchboard needs ${missing.join(', ')} before it can start.`,
          SETTINGS,
        );
        if (choice === SETTINGS) {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'switchboard',
          );
        }
      }
      return;
    }

    try {
      const how = await bridge.ensureRunning(settings, pats, directKey, chosen);
      output.appendLine(
        `[extension] bridge ${how} on ${settings.listenHost}:${settings.listenPort} ` +
          `(log: ${LOG_FILE})`,
      );
      if (!silent && how === 'started') {
        void vscode.window.showInformationMessage(
          `Switchboard is running on ${settings.listenHost}:${settings.listenPort}.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`[extension] start failed: ${message}`);
      void vscode.window.showErrorMessage(`Switchboard: ${message}`);
    }
    await updateStatusBar();
  }

  async function restart(): Promise<void> {
    const settings = readSettings();
    const { pats, directKey } = await credentials();
    const previous = await activeProvider();
    try {
      await bridge.restart(settings, pats, directKey, previous);
      output.appendLine('[extension] bridge restarted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Switchboard: restart failed. ${message}`);
    }
    await updateStatusBar();
  }

  /** Switch upstream. With no argument, step to the next configured one. */
  async function select(provider?: ProviderId): Promise<void> {
    const status = await bridge.status();
    if (!status.running) {
      void vscode.window.showWarningMessage('Switchboard: the bridge is not running.');
      return;
    }
    try {
      const active = await bridge.select(provider);
      // Remember the choice, so a restart lands on the same upstream.
      await updateSetting('activeProvider', active);
      await updateStatusBar();
      const label = status.providers[active]?.label ?? active;
      void vscode.window.setStatusBarMessage(`$(arrow-swap) Switchboard: now on ${label}`, 3000);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Switchboard: could not switch upstream. ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Offer the configured upstreams and switch to the chosen one. */
  async function selectProvider(): Promise<void> {
    const status = await bridge.status();
    if (!status.running) {
      void vscode.window.showWarningMessage('Switchboard: the bridge is not running.');
      return;
    }

    const items = PROVIDER_IDS.map((id) => {
      const p = status.providers[id];
      const configured = p?.configured ?? id === 'direct';
      return {
        label: `${status.active === id ? '$(check) ' : ''}${p?.label ?? LABELS[id]}`,
        description: p?.url || (id === 'direct' ? 'api.anthropic.com' : 'not configured'),
        detail: configured ? undefined : 'No URL set for this platform yet',
        id,
        configured,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Which upstream should requests go to?',
      placeHolder: 'The conversation carries over, whichever you choose',
    });
    if (!picked) return;
    if (!picked.configured) {
      void vscode.window.showWarningMessage(
        `Switchboard: ${picked.id} has no URL configured yet.`,
      );
      return;
    }
    await select(picked.id as ProviderId);
  }

  async function requireRunning(what: string): Promise<boolean> {
    if ((await bridge.status()).running) return true;
    const START = 'Start it';
    const choice = await vscode.window.showWarningMessage(
      `Switchboard: the bridge must be running to ${what}.`,
      START,
    );
    if (choice === START) await start();
    return (await bridge.status()).running;
  }

  async function test(): Promise<void> {
    if (!(await requireRunning('test the connection'))) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Switchboard: testing upstream…' },
      async () => {
        const id = await activeProvider();
        const settings = readSettings();
        const map = id === 'direct' ? {} : settings.providers[id].modelMap;
        const result = await bridge.testConnection(Object.keys(map)[0], id);

        if (result.ok) {
          output.appendLine(
            `[extension] test ok: ${result.label} ${result.status} in ${result.ms}ms`,
          );
          void vscode.window.showInformationMessage(
            `Switchboard: ${result.label} answered ${result.status} in ${result.ms}ms.`,
          );
        } else {
          const detail = result.error ?? `${result.status} ${result.body ?? ''}`;
          output.appendLine(`[extension] test failed: ${detail}`);
          const SHOW = 'Show log';
          const choice = await vscode.window.showErrorMessage(
            `Switchboard: upstream test failed. ${String(detail).slice(0, 200)}`,
            SHOW,
          );
          if (choice === SHOW) output.show(true);
        }
      },
    );
  }

  async function refreshToken(): Promise<void> {
    if (!(await requireRunning('exchange a token'))) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Switchboard: exchanging token…' },
      async () => {
        const result = await bridge.refreshToken(await activeProvider());
        if (result.ok && result.token) {
          const mins = Math.round(result.token.expiresInSeconds / 60);
          void vscode.window.showInformationMessage(
            `Switchboard: token exchanged, good for about ${mins || 1} minutes.`,
          );
        } else if (result.ok) {
          void vscode.window.showInformationMessage(`Switchboard: ${result.skipped}`);
        } else {
          output.appendLine(`[extension] token exchange failed: ${result.error}`);
          const SHOW = 'Show log';
          const choice = await vscode.window.showErrorMessage(
            `Switchboard: token exchange failed. ${String(result.error).slice(0, 200)}`,
            SHOW,
          );
          if (choice === SHOW) output.show(true);
        }
        await panel.refresh();
      },
    );
  }

  /** List what a platform serves and offer to seed its model map from that. */
  async function fetchModels(id: ProviderId): Promise<void> {
    if (!(await requireRunning('list models'))) return;

    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Switchboard: asking the platform…' },
      () => bridge.upstreamModels(id),
    );

    if (!models.length) {
      const SHOW = 'Show log';
      const choice = await vscode.window.showWarningMessage(
        `Switchboard: ${LABELS[id]} returned no models. It may not expose a model list.`,
        SHOW,
      );
      if (choice === SHOW) output.show(true);
      return;
    }

    output.appendLine(`[extension] ${LABELS[id]} models: ${models.join(', ')}`);

    const picked = await vscode.window.showQuickPick(models, {
      title: `Which ${LABELS[id]} model should Claude requests map onto?`,
      placeHolder: 'Pick one, or press Escape to just see the list in the log',
    });
    if (!picked || id === 'direct') return;

    const existing = readSettings().providers[id].modelMap;
    await updateSetting(`${id}.modelMap`, {
      ...existing,
      'claude-opus-4-6': picked,
      'claude-sonnet-4-6': picked,
      'claude-*': picked,
    });
    void vscode.window.showInformationMessage(
      `Switchboard: Claude model ids now map onto ${picked} for ${LABELS[id]}.`,
    );
  }

  async function setPat(id: ProviderId): Promise<void> {
    if (id === 'direct') {
      const saved = await promptForSecret(
        context,
        DIRECT_KEY,
        'Anthropic API key for direct mode',
      );
      if (saved && (await bridge.status()).running) await restart();
      return;
    }
    const saved = await promptForSecret(
      context,
      patKey(id),
      `${LABELS[id]}: personal access token`,
    );
    if (!saved) return;
    // Tokens are read at spawn time, so the running bridge needs replacing.
    if ((await bridge.status()).running) await restart();
    await panel.refresh();
  }

  /** Ask which platform's token to act on, when the user did not say. */
  async function pickProvider(title: string): Promise<ProviderId | undefined> {
    const picked = await vscode.window.showQuickPick(
      (['genai', 'bedrock', 'direct'] as const).map((id) => ({ label: LABELS[id], id })),
      { title },
    );
    return picked?.id;
  }

  async function wireClaude(): Promise<void> {
    let status = await bridge.status();

    // Wiring the CLI at a port nothing is serving breaks it outright, so never
    // do that quietly.
    if (!status.running) {
      const START = 'Start the bridge first';
      const ANYWAY = 'Connect anyway';
      const choice = await vscode.window.showWarningMessage(
        'Switchboard: the bridge is not running. Pointing Claude Code at it now will stop ' +
          'the CLI working until the bridge is up.',
        START,
        ANYWAY,
      );
      if (choice === START) {
        await start();
        status = await bridge.status();
        if (!status.running) return;
      } else if (choice !== ANYWAY) {
        return;
      }
    }

    try {
      const result = await wireClaudeCode(context, status.port);
      output.appendLine(
        `[extension] wired Claude Code -> ${result.baseUrl} (${result.file})` +
          (result.backup ? `, backup at ${result.backup}` : ''),
      );

      if (status.running) {
        void vscode.window.showInformationMessage(
          `Switchboard: Claude Code now points at ${result.baseUrl}. ` +
            'Open a new terminal and run "claude", then /status to confirm.',
        );
      } else {
        const UNDO = 'Disconnect again';
        void vscode.window
          .showWarningMessage(
            `Switchboard: Claude Code now points at ${result.baseUrl}, but nothing is ` +
              'listening there. The CLI will fail until you start the bridge.',
            UNDO,
          )
          .then(async (pick) => {
            if (pick === UNDO) await unwireClaude();
          });
      }
      await panel.refresh();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Switchboard: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async function unwireClaude(): Promise<void> {
    try {
      const result = await unwireClaudeCode(context);
      output.appendLine(`[extension] restored ${result.file}`);
      void vscode.window.showInformationMessage(
        'Switchboard: Claude Code settings restored. Restart any open CLI sessions.',
      );
      await panel.refresh();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Switchboard: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /* ---------------- panel ---------------- */

  const panel = new SwitchboardPanel(bridge, {
    start: () => start(),
    stop: async () => {
      await bridge.stop();
      output.appendLine('[extension] bridge stopped');
      await updateStatusBar();
    },
    restart,
    select: (p) => select(p),
    test,
    refreshToken,
    fetchModels,
    setPat,
    wireClaude,
    wireCopilot: async () => wireCopilot((await bridge.status()).port, output),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SwitchboardPanel.viewId, panel),
  );

  bridge.onDidChange(() => void updateStatusBar());

  /* ---------------- commands ---------------- */

  const register = (id: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('switchboard.start', () => start());
  register('switchboard.stop', async () => {
    await bridge.stop();
    await updateStatusBar();
  });
  register('switchboard.restart', restart);
  register('switchboard.selectProvider', selectProvider);
  register('switchboard.toggle', () => select());
  register('switchboard.test', test);
  register('switchboard.refreshToken', refreshToken);
  register('switchboard.fetchModels', async () => {
    const id = await pickProvider('Fetch models from which platform?');
    if (id) await fetchModels(id);
  });
  register('switchboard.logs', () => output.show(true));
  register('switchboard.setPat', async () => {
    const id = await pickProvider('Set the token for which platform?');
    if (id) await setPat(id);
  });
  register('switchboard.clearPat', async () => {
    const id = await pickProvider('Clear the token for which platform?');
    if (!id) return;
    await context.secrets.delete(id === 'direct' ? DIRECT_KEY : patKey(id));
    void vscode.window.showInformationMessage(`Switchboard: ${LABELS[id]} token cleared.`);
    if ((await bridge.status()).running) await restart();
    await panel.refresh();
  });
  register('switchboard.setDirectKey', () => setPat('direct'));
  register('switchboard.wireClaude', wireClaude);
  register('switchboard.unwireClaude', unwireClaude);
  register('switchboard.wireCopilot', async () =>
    wireCopilot((await bridge.status()).port, output),
  );

  /* ---------------- reactions ---------------- */

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!RESTART_ON.some((key) => e.affectsConfiguration(key))) return;

      const portChanged = e.affectsConfiguration('switchboard.listenPort');
      if (!(await bridge.status()).running) {
        await panel.refresh();
        return;
      }

      const RESTART = 'Restart now';
      const choice = await vscode.window.showInformationMessage(
        'Switchboard: settings changed. The bridge needs a restart to pick them up.',
        RESTART,
      );
      if (choice !== RESTART) return;

      await restart();

      // A moved port leaves the Claude Code settings pointing at the old one.
      if (portChanged && !isClaudeWired((await bridge.status()).port)) {
        const REWIRE = 'Update Claude Code';
        const pick = await vscode.window.showWarningMessage(
          'Switchboard: the port changed, so Claude Code is still pointed at the old one.',
          REWIRE,
        );
        if (pick === REWIRE) await wireClaude();
      }
    }),
  );

  /* ---------------- startup ---------------- */

  const settings = readSettings();
  if (settings.autoStart) await start(true);

  // Always land on a correct status bar, whichever path startup took.
  await updateStatusBar();

  if ((await bridge.status()).running && !isClaudeWired(settings.listenPort)) {
    const WIRE = 'Connect it';
    void vscode.window
      .showInformationMessage(
        'Switchboard is running but Claude Code is not pointed at it yet.',
        WIRE,
      )
      .then(async (choice) => {
        if (choice === WIRE) await wireClaude();
      });
  }
}

export function deactivate(): void {
  // The bridge process is left running on purpose: the terminal CLI keeps
  // working after VS Code closes. Use "Switchboard: Stop bridge" to end it.
}
