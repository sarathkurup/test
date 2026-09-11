import * as vscode from 'vscode';

import { BridgeProcess, BridgeStatus } from './bridgeProcess';
import { isClaudeWired } from './claudeConfig';
import {
  ProviderId,
  effectiveRefreshUrl,
  missingForProvider,
  readSettings,
  updateSetting,
} from './settings';

export interface PanelActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  select(provider?: ProviderId): Promise<void>;
  test(): Promise<void>;
  refreshToken(): Promise<void>;
  fetchModels(provider: ProviderId): Promise<void>;
  setPat(provider: ProviderId): Promise<void>;
  wireClaude(): Promise<void>;
  wireCopilot(): Promise<void>;
}

function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Settings the panel may write, mapped to their full configuration key. */
const EDITABLE: Record<string, string> = {
  listenHost: 'listenHost',
  listenPort: 'listenPort',
  'genai.url': 'genai.url',
  'genai.authMode': 'genai.authMode',
  'genai.userEmail': 'genai.userEmail',
  'genai.environment': 'genai.environment',
  'genai.refreshUrl': 'genai.refreshUrl',
  'genai.tenantId': 'genai.tenantId',
  'genai.apiShape': 'genai.apiShape',
  'bedrock.url': 'bedrock.url',
  'bedrock.authMode': 'bedrock.authMode',
  'bedrock.userEmail': 'bedrock.userEmail',
  'bedrock.environment': 'bedrock.environment',
  'bedrock.refreshUrl': 'bedrock.refreshUrl',
  'bedrock.region': 'bedrock.region',
  'bedrock.apiShape': 'bedrock.apiShape',
};

export class SwitchboardPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'switchboard.panel';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly bridge: BridgeProcess,
    private readonly actions: PanelActions,
  ) {
    bridge.onDidChange(() => void this.refresh());
    bridge.onDidLog((line) => this.view?.webview.postMessage({ type: 'log', line }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      const provider = (msg?.provider as ProviderId) ?? 'genai';
      switch (msg?.type) {
        case 'ready':
          view.webview.postMessage({ type: 'logs', lines: this.bridge.recentLines });
          await this.refresh();
          break;
        case 'start':
          await this.actions.start();
          break;
        case 'stop':
          await this.actions.stop();
          break;
        case 'restart':
          await this.actions.restart();
          break;
        case 'select':
          await this.actions.select(provider);
          break;
        case 'test':
          await this.actions.test();
          break;
        case 'refreshToken':
          await this.actions.refreshToken();
          break;
        case 'fetchModels':
          await this.actions.fetchModels(provider);
          break;
        case 'setPat':
          await this.actions.setPat(provider);
          break;
        case 'wireClaude':
          await this.actions.wireClaude();
          break;
        case 'wireCopilot':
          await this.actions.wireCopilot();
          break;
        case 'showLogs':
          await vscode.commands.executeCommand('switchboard.logs');
          break;
        case 'openSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            msg.query || 'switchboard',
          );
          break;
        case 'save':
          await this.save(String(msg.key), msg.value);
          break;
      }
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
  }

  private async save(key: string, raw: unknown): Promise<void> {
    const target = EDITABLE[key];
    if (!target) return;
    const value =
      key === 'listenPort' ? Math.trunc(Number(raw)) || 8787 : String(raw ?? '').trim();
    await updateSetting(target, value);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;

    const status: BridgeStatus = await this.bridge.status();
    const s = readSettings();

    const providers = (['genai', 'bedrock'] as const).map((id) => {
      const p = s.providers[id];
      const live = status.providers[id];
      return {
        id,
        label: p.label,
        url: p.url,
        authMode: p.authMode,
        apiShape: p.apiShape,
        userEmail: p.userEmail,
        environment: p.environment,
        refreshUrl: p.refreshUrl,
        effectiveRefreshUrl: effectiveRefreshUrl(p),
        tenantId: p.tenantId,
        region: p.region,
        models: Object.keys(p.modelMap),
        patConfigured: live?.patConfigured ?? false,
        token: status.tokens?.[id],
        missing: missingForProvider(p, live?.patConfigured ?? false),
      };
    });

    this.view.webview.postMessage({
      type: 'status',
      running: status.running,
      host: status.host,
      port: status.port,
      active: status.active,
      providers,
      directConfigured: Boolean(s.directUrl),
      listen: { host: s.listenHost, port: s.listenPort },
      claudeWired: isClaudeWired(status.port),
    });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; --radius: 6px; --line: var(--vscode-widget-border, rgba(127,127,127,.25)); }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); margin: 0; padding: 12px 12px 20px;
  }

  .state {
    border: 1px solid var(--line); border-radius: var(--radius); padding: 12px;
    background: var(--vscode-editorWidget-background);
  }
  .state .top { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.up { background: var(--vscode-testing-iconPassed, #3fb950); }
  .dot.down { background: var(--vscode-charts-red, #f85149); }
  .state .label { font-weight: 600; }
  .state .addr {
    margin-left: auto; opacity: .6; font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .routes { display: flex; gap: 5px; margin-top: 10px; }
  .routes button {
    flex: 1; border: 1px solid transparent; border-radius: 5px; padding: 8px 7px;
    font: inherit; font-size: 11px; cursor: pointer; text-align: left; line-height: 1.35;
    background: var(--vscode-input-background); color: var(--vscode-foreground); opacity: .6;
  }
  .routes button .who { display: block; font-weight: 600; font-size: 12px; }
  .routes button .what {
    display: block; font-size: 10px; opacity: .75; margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .routes button.on {
    opacity: 1; border-color: var(--vscode-focusBorder);
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .routes button.unset { opacity: .35; }
  .routes button:disabled { cursor: default; }

  .meta { margin-top: 9px; font-size: 11px; opacity: .75; line-height: 1.55; }
  .warn { color: var(--vscode-editorWarning-foreground, #d29922); }
  .bad  { color: var(--vscode-errorForeground, #f85149); }
  .good { color: var(--vscode-testing-iconPassed, #3fb950); }

  details { margin-top: 10px; border: 1px solid var(--line); border-radius: var(--radius); }
  details > summary {
    cursor: pointer; padding: 9px 11px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; opacity: .75; list-style: none;
  }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: '▸ '; opacity: .6; }
  details[open] > summary::before { content: '▾ '; }
  details > summary .tag {
    float: right; text-transform: none; letter-spacing: 0; font-weight: 400; opacity: .8;
  }
  details > .body { padding: 0 11px 12px; }

  label { display: block; font-size: 11px; opacity: .7; margin: 9px 0 4px; }
  input, select {
    width: 100%; padding: 5px 7px; font: inherit; font-size: 12px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .pair { display: flex; gap: 8px; }
  .pair > div { flex: 1; }
  .pair > div.narrow { flex: 0 0 92px; }

  .token { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
  .token .value {
    flex: 1; padding: 5px 7px; border-radius: 4px; font-size: 12px;
    background: var(--vscode-input-background); opacity: .85;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  button.act {
    padding: 6px 10px; border: none; border-radius: 4px; font: inherit; font-size: 12px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  button.act.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button.act:hover { background: var(--vscode-button-hoverBackground); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
  .row button.act { flex: 1 1 calc(50% - 3px); }
  .hint { font-size: 11px; opacity: .6; margin-top: 7px; line-height: 1.5; }

  .traffic-head { display: flex; align-items: baseline; margin: 12px 0 6px; }
  .traffic-head h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    opacity: .7; margin: 0; font-weight: 600;
  }
  .traffic-head .count { margin-left: auto; font-size: 11px; opacity: .5; }
  #log {
    height: 210px; overflow-y: auto; border: 1px solid var(--line);
    border-radius: var(--radius); padding: 8px 10px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.07));
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.6;
  }
  #log .line { display: flex; gap: 8px; white-space: pre; }
  #log .t { opacity: .45; flex: none; }
  #log .d { flex: none; width: 14px; }
  #log .m { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #log .n { flex: none; opacity: .65; }
  #log .req .d { color: var(--vscode-charts-blue, #58a6ff); }
  #log .res .d { color: var(--vscode-charts-green, #3fb950); }
  #log .err { color: var(--vscode-errorForeground, #f85149); white-space: pre-wrap; }
  #log .note { opacity: .6; white-space: pre-wrap; }
  #log .empty { opacity: .45; }
</style>
</head>
<body>

<div class="state">
  <div class="top">
    <span class="dot down" id="dot"></span>
    <span class="label" id="stateLabel">Checking…</span>
    <span class="addr" id="addr"></span>
  </div>
  <div class="routes">
    <button data-p="genai"><span class="who">GenAI</span><span class="what" id="what-genai">not set</span></button>
    <button data-p="bedrock"><span class="who">Bedrock</span><span class="what" id="what-bedrock">not set</span></button>
    <button data-p="direct"><span class="who">Direct</span><span class="what">anthropic.com</span></button>
  </div>
  <div class="meta" id="meta"></div>
</div>

<details id="sec-genai" open>
  <summary>GenAI platform <span class="tag" id="tag-genai"></span></summary>
  <div class="body" data-provider="genai">
    <label>URL</label>
    <input data-k="genai.url" type="text" spellcheck="false" placeholder="https://api.example.com/openai">
    <div class="pair">
      <div>
        <label>Authentication</label>
        <select data-k="genai.authMode">
          <option value="pat">Send token directly</option>
          <option value="jwt">Exchange for a JWT</option>
          <option value="none">No credential</option>
        </select>
      </div>
      <div class="narrow">
        <label>Env</label>
        <input data-k="genai.environment" type="text" spellcheck="false" placeholder="PRO">
      </div>
    </div>
    <label>Token</label>
    <div class="token">
      <span class="value" id="pat-genai">not set</span>
      <button class="act primary" data-act="setPat" data-p="genai">Set</button>
    </div>
    <label>User email</label>
    <input data-k="genai.userEmail" type="email" spellcheck="false" placeholder="you@company.com">
    <label>Token exchange URL</label>
    <input data-k="genai.refreshUrl" type="text" spellcheck="false" placeholder="from the environment map, or set one here">
    <div class="pair">
      <div>
        <label>Tenant id</label>
        <input data-k="genai.tenantId" type="text" spellcheck="false">
      </div>
      <div>
        <label>API shape</label>
        <select data-k="genai.apiShape">
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>
    </div>
    <div class="row">
      <button class="act" data-act="fetchModels" data-p="genai">Fetch models</button>
      <button class="act" data-act="settings" data-q="switchboard.genai">All settings</button>
    </div>
    <div class="hint" id="hint-genai"></div>
  </div>
</details>

<details id="sec-bedrock">
  <summary>AWS Bedrock <span class="tag" id="tag-bedrock"></span></summary>
  <div class="body" data-provider="bedrock">
    <label>URL</label>
    <input data-k="bedrock.url" type="text" spellcheck="false" placeholder="https://bedrock-runtime.region.amazonaws.com">
    <div class="pair">
      <div>
        <label>Authentication</label>
        <select data-k="bedrock.authMode">
          <option value="pat">Send token directly</option>
          <option value="jwt">Exchange for a JWT</option>
          <option value="none">No credential</option>
        </select>
      </div>
      <div class="narrow">
        <label>Region</label>
        <input data-k="bedrock.region" type="text" spellcheck="false" placeholder="us-east-1">
      </div>
    </div>
    <label>Token</label>
    <div class="token">
      <span class="value" id="pat-bedrock">not set</span>
      <button class="act primary" data-act="setPat" data-p="bedrock">Set</button>
    </div>
    <div class="pair">
      <div>
        <label>Env</label>
        <input data-k="bedrock.environment" type="text" spellcheck="false">
      </div>
      <div>
        <label>API shape</label>
        <select data-k="bedrock.apiShape">
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </div>
    </div>
    <label>Token exchange URL</label>
    <input data-k="bedrock.refreshUrl" type="text" spellcheck="false" placeholder="only needed when exchanging">
    <div class="row">
      <button class="act" data-act="fetchModels" data-p="bedrock">Fetch models</button>
      <button class="act" data-act="settings" data-q="switchboard.bedrock">All settings</button>
    </div>
    <div class="hint" id="hint-bedrock"></div>
  </div>
</details>

<details id="sec-listen">
  <summary>Listening</summary>
  <div class="body">
    <div class="pair">
      <div>
        <label>Host</label>
        <input data-k="listenHost" type="text" spellcheck="false" placeholder="127.0.0.1">
      </div>
      <div class="narrow">
        <label>Port</label>
        <input data-k="listenPort" type="number" min="1" max="65535">
      </div>
    </div>
    <div class="hint" id="listenHint"></div>
  </div>
</details>

<div class="row">
  <button class="act" data-act="test">Test connection</button>
  <button class="act" data-act="refreshToken" id="btnToken">Refresh token</button>
  <button class="act" data-act="startstop" id="btnStartStop">Start</button>
  <button class="act" data-act="restart">Restart</button>
</div>
<div class="row">
  <button class="act" data-act="wireClaude">Connect Claude Code</button>
  <button class="act" data-act="wireCopilot">Connect editor chat</button>
</div>
<div class="row">
  <button class="act" data-act="showLogs">Full log</button>
</div>

<div class="traffic-head">
  <h2>Traffic</h2><span class="count" id="reqCount"></span>
</div>
<div id="log"><span class="empty">Waiting for the first request…</span></div>

<script nonce="${n}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

let running = false;
let active = 'genai';
let requests = 0;
const dirty = new Set();

/* A field being edited must not be overwritten by a refresh mid-keystroke. */
for (const el of document.querySelectorAll('[data-k]')) {
  const key = el.dataset.k;
  if (el.tagName === 'SELECT') {
    el.addEventListener('change', () => post('save', { key, value: el.value }));
  } else {
    el.addEventListener('input', () => dirty.add(key));
    el.addEventListener('change', () => { dirty.delete(key); post('save', { key, value: el.value }); });
    el.addEventListener('blur', () => dirty.delete(key));
  }
}

for (const b of document.querySelectorAll('.routes button')) {
  b.addEventListener('click', () => {
    if (b.dataset.p !== active) post('select', { provider: b.dataset.p });
  });
}

for (const b of document.querySelectorAll('[data-act]')) {
  b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'startstop') return post(running ? 'stop' : 'start');
    if (a === 'settings') return post('openSettings', { query: b.dataset.q });
    post(a, b.dataset.p ? { provider: b.dataset.p } : undefined);
  });
}

/* ---------- traffic ---------- */

function row(cls, time, mark, message, note) {
  const el = document.createElement('div');
  el.className = 'line ' + cls;
  const add = (c, text) => {
    const s = document.createElement('span');
    s.className = c; s.textContent = text; el.appendChild(s);
  };
  add('t', time);
  if (mark !== null) add('d', mark);
  add('m', message);
  if (note) add('n', note);
  return el;
}

function render(line) {
  const m = line.match(/^(\\S+) \\[(\\w+)\\]\\s*(.*)$/);
  if (!m) return row('note', '', null, line);
  const [, time, kind, rest] = m;
  if (kind === 'error') return row('err', time, '!', rest);
  if (kind !== 'event') return row('note', time, null, rest);

  let e;
  try { e = JSON.parse(rest); } catch { return row('note', time, null, rest); }

  if (e.name === 'request') {
    requests += 1;
    const bits = [e.upstream || '', e.model || '', e.tools ? e.tools + ' tools' : ''].filter(Boolean);
    return row('req', time, '\\u2192', bits.join('  '), e.messages ? e.messages + ' msgs' : '');
  }
  if (e.name === 'response') {
    const bits = [];
    if (e.stop) bits.push(e.stop);
    if (e.tools) bits.push(e.tools + ' tool calls');
    return row('res', time, '\\u2190', bits.join('  ') || 'done',
      [e.ms ? e.ms + 'ms' : '', e.out ? e.out + ' tok' : ''].filter(Boolean).join('  '));
  }
  if (e.name === 'toggle') return row('note', time, null, 'switched to ' + (e.label || e.active));
  if (e.name === 'test') return row('note', time, null, 'test ' + e.status, e.ms + 'ms');
  return row('note', time, null, rest);
}

function append(line) {
  const log = $('log');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(render(line));
  while (log.childElementCount > 400) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
  $('reqCount').textContent = requests ? requests + ' requests' : '';
}

/* ---------- status ---------- */

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function tokenNote(p) {
  if (p.authMode !== 'jwt') return '';
  const t = p.token;
  if (!t || !t.configured) return '';
  if (t.lastError) return '<span class="bad">' + esc(p.label) + ' token exchange failed: ' + esc(t.lastError) + '</span>';
  if (!t.hasToken) return esc(p.label) + ': no token exchanged yet.';
  if (!t.valid) return '<span class="warn">' + esc(p.label) + ' token has lapsed; it renews on the next request.</span>';
  const mins = Math.floor(t.expiresInSeconds / 60);
  return '<span class="good">' + esc(p.label) + ' token valid for ' +
    (mins >= 1 ? mins + 'm' : t.expiresInSeconds + 's') + '.</span>';
}

function setField(key, value) {
  if (dirty.has(key)) return;
  const el = document.querySelector('[data-k="' + key + '"]');
  if (el) el.value = value ?? '';
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;

  if (msg.type === 'log') return append(msg.line);
  if (msg.type === 'logs') {
    $('log').innerHTML = '';
    requests = 0;
    if (!msg.lines.length) $('log').innerHTML = '<span class="empty">Waiting for the first request…</span>';
    else msg.lines.forEach(append);
    return;
  }
  if (msg.type !== 'status') return;

  running = msg.running;
  active = msg.active;

  const byId = {};
  msg.providers.forEach((p) => { byId[p.id] = p; });
  const activeProvider = byId[active];

  $('dot').className = 'dot ' + (running ? 'up' : 'down');
  $('stateLabel').textContent = running
    ? 'Routing through ' + (activeProvider ? activeProvider.label : 'Direct')
    : 'Bridge stopped';
  $('addr').textContent = running ? msg.host + ':' + msg.port : '';
  $('btnStartStop').textContent = running ? 'Stop' : 'Start';
  $('btnStartStop').classList.toggle('primary', !running);
  $('btnToken').style.display =
    activeProvider && activeProvider.authMode === 'jwt' ? '' : 'none';

  for (const b of document.querySelectorAll('.routes button')) {
    const id = b.dataset.p;
    const p = byId[id];
    b.classList.toggle('on', running && active === id);
    b.classList.toggle('unset', id !== 'direct' && !(p && p.url));
    b.disabled = !running;
  }

  for (const p of msg.providers) {
    let host = 'not set';
    try { if (p.url) host = new URL(p.url).host; } catch { host = p.url || 'not set'; }
    $('what-' + p.id).textContent = host;
    $('pat-' + p.id).textContent = p.patConfigured ? '•••••••• in the keychain' : 'not set';
    $('tag-' + p.id).innerHTML = p.missing.length
      ? '<span class="warn">needs ' + esc(p.missing.join(', ')) + '</span>'
      : '<span class="good">ready</span>';
    $('hint-' + p.id).textContent = p.models.length
      ? 'Models: ' + p.models.join(', ')
      : 'No model mapping. Client model ids go through unchanged.';

    setField(p.id + '.url', p.url);
    setField(p.id + '.userEmail', p.userEmail);
    setField(p.id + '.environment', p.environment);
    setField(p.id + '.refreshUrl', p.refreshUrl);
    setField(p.id + '.tenantId', p.tenantId);
    setField(p.id + '.region', p.region);
    const mode = document.querySelector('[data-k="' + p.id + '.authMode"]');
    if (mode) mode.value = p.authMode;
    const shape = document.querySelector('[data-k="' + p.id + '.apiShape"]');
    if (shape) shape.value = p.apiShape;
  }

  setField('listenHost', msg.listen.host);
  setField('listenPort', msg.listen.port);

  const notes = [];
  if (activeProvider && activeProvider.missing.length) {
    notes.push('<span class="warn">' + esc(activeProvider.label) + ' still needs ' +
      esc(activeProvider.missing.join(', ')) + '.</span>');
  }
  const t = activeProvider ? tokenNote(activeProvider) : '';
  if (t) notes.push(t);
  notes.push(msg.claudeWired
    ? '<span class="good">Claude Code points here.</span>'
    : '<span class="warn">Claude Code is not connected.</span>');
  $('meta').innerHTML = notes.join('<br>');

  $('listenHint').textContent = msg.claudeWired
    ? 'Claude Code is wired to this port. Changing it rewrites your Claude settings.'
    : 'Changing the port after connecting Claude Code means reconnecting it.';

  // Open whichever platform still needs attention.
  for (const p of msg.providers) {
    if (p.id === active && p.missing.length) $('sec-' + p.id).open = true;
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
