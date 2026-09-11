import * as vscode from 'vscode';

/**
 * Wiring for VS Code's built-in chat.
 *
 * As of 1.136 Copilot is bundled into VS Code rather than installed as a
 * separate extension, and custom models are registered through the
 * languageModelChatProviders contribution point. The provider to use is
 * "Custom Endpoint" (vendor `customendpoint`). Two older routes are dead ends:
 * `customOAIModels` is deprecated, and the `customoai` vendor that replaced it
 * is both deprecated and gated to non-stable builds.
 *
 * Custom Endpoint takes an apiType of chat-completions, responses or messages.
 * We point it at the Messages surface rather than the Chat Completions one,
 * because /v1/messages serves both upstreams while /v1/chat/completions only
 * works when the active upstream is OpenAI-shaped. Choosing Messages keeps the
 * upstream toggle working for the editor chat too.
 *
 * Provider configuration is held by VS Code internally, not in settings.json,
 * so it cannot be written from here. This walks the user to the dialog with
 * the right values on the clipboard.
 */

const MODEL_PICKER = 'workbench.action.chat.openModelPicker';

export interface CopilotWireInfo {
  /** The route to register. Serves every upstream, so the toggle keeps working. */
  endpointUrl: string;
  /** Fallback for clients that only speak Chat Completions. */
  chatCompletionsUrl: string;
  apiType: 'messages';
  chatAvailable: boolean;
}

export function copilotInfo(port: number): CopilotWireInfo {
  // Chat is built into recent VS Code; older setups carry it as an extension.
  const chatCommandsExist =
    vscode.extensions.getExtension('github.copilot-chat') !== undefined ||
    vscode.extensions.getExtension('github.copilot') !== undefined;

  return {
    endpointUrl: `http://127.0.0.1:${port}/v1/messages`,
    chatCompletionsUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiType: 'messages',
    chatAvailable: chatCommandsExist || Number(vscode.version.split('.')[1]) >= 122,
  };
}

/** Confirm the OpenAI surface answers before sending anyone to a dialog. */
export async function verifyOpenAiSurface(
  port: number,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, models: [], error: `models endpoint returned ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return { ok: true, models: (body.data ?? []).map((m) => m.id) };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function wireCopilot(port: number, output: vscode.OutputChannel): Promise<void> {
  const info = copilotInfo(port);
  const check = await verifyOpenAiSurface(port);

  if (!check.ok) {
    // "fetch failed" means nothing is listening at all, which is almost always
    // a bridge that never started for want of a gateway URL.
    const nothingListening = /fetch failed|ECONNREFUSED/i.test(check.error ?? '');
    const SETTINGS = 'Open settings';
    const choice = await vscode.window.showErrorMessage(
      nothingListening
        ? `Switchboard: nothing is listening on port ${port}. The bridge only starts once ` +
            'a gateway URL is set, so set one and start the bridge, then try again.'
        : `Switchboard: the endpoint is not answering (${check.error}).`,
      SETTINGS,
    );
    if (choice === SETTINGS) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'switchboard.gatewayUrl');
    }
    return;
  }

  const models = check.models.length ? check.models : ['(no model mapping set)'];

  output.appendLine('[extension] register this under Custom Endpoint:');
  output.appendLine(`[extension]   URL      ${info.endpointUrl}`);
  output.appendLine('[extension]   API type Messages');
  output.appendLine('[extension]   API key  any non-empty value, the bridge supplies the real one');
  output.appendLine(`[extension]   models   ${models.join(', ')}`);
  output.appendLine(
    `[extension] chat-completions clients can use ${info.chatCompletionsUrl}, ` +
      'but that route only serves the gateway upstream, so the toggle will not follow it.',
  );

  await vscode.env.clipboard.writeText(info.endpointUrl);

  if (!info.chatAvailable) {
    void vscode.window.showWarningMessage(
      'Switchboard: no chat client found to point at the bridge. ' +
        `The endpoint is ready and copied to your clipboard: ${info.endpointUrl}`,
    );
    return;
  }

  const OPEN_PICKER = 'Open model picker';
  const SHOW_STEPS = 'Show the values';

  const choice = await vscode.window.showInformationMessage(
    `Switchboard: ${info.endpointUrl} is on your clipboard. In the model picker choose ` +
      'Manage Models, then Custom Endpoint, and set the API type to Messages.',
    OPEN_PICKER,
    SHOW_STEPS,
  );

  if (choice === SHOW_STEPS) {
    output.show(true);
    return;
  }

  if (choice !== OPEN_PICKER) return;

  try {
    await vscode.commands.executeCommand(MODEL_PICKER);
  } catch (err) {
    output.appendLine(`[extension] could not open the model picker: ${err}`);
    output.show(true);
    void vscode.window.showWarningMessage(
      'Switchboard: could not open the model picker in this build. ' +
        'Open chat, click the model name, and choose Manage Models.',
    );
  }
}
