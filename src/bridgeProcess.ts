import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProviderId, Settings, bridgeEnv } from './settings';

export const STATE_DIR = path.join(os.homedir(), '.switchboard');
export const PID_FILE = path.join(STATE_DIR, 'bridge.pid');
export const LOG_FILE = path.join(STATE_DIR, 'bridge.log');

export interface TokenStatus {
  configured: boolean;
  hasToken: boolean;
  valid: boolean;
  expiresInSeconds: number;
  refreshCount: number;
  lastError?: string;
  label?: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  url: string;
  endpoint: string;
  shape: string;
  authMode: string;
  patConfigured: boolean;
  email: string;
  environment: string;
  refreshUrl: string;
  configured: boolean;
  modelMap: Record<string, string>;
}

export interface BridgeStatus {
  running: boolean;
  adopted: boolean;
  host: string;
  port: number;
  active: string;
  configured: string[];
  providers: Record<string, ProviderStatus>;
  tokens: Record<string, TokenStatus>;
}

interface HealthBody {
  active: string;
  port: number;
  host: string;
  configured: string[];
  providers: Record<string, ProviderStatus>;
  tokens: Record<string, TokenStatus>;
}

interface PidRecord {
  pid: number;
  port: number;
  startedAt: string;
}

function readPidFile(): PidRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as PidRecord;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function httpJson<T>(url: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Owns the detached bridge process.
 *
 * The bridge deliberately outlives VS Code: the terminal CLI keeps working
 * after the editor closes. That means the extension has to be able to find and
 * adopt a bridge it did not start.
 */
export class BridgeProcess {
  private ownPid: number | undefined;
  private adopted = false;
  private tailTimer: NodeJS.Timeout | undefined;
  private tailOffset = 0;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidLog = new vscode.EventEmitter<string>();
  readonly onDidLog = this._onDidLog.event;

  /** Recent bridge output, so a panel opened later still has context. */
  readonly recentLines: string[] = [];
  private static readonly MAX_LINES = 300;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  get port(): number {
    return (
      readPidFile()?.port ??
      vscode.workspace.getConfiguration('switchboard').get<number>('listenPort', 8787)
    );
  }

  private base(port = this.port): string {
    return `http://127.0.0.1:${port}`;
  }

  /** Is something answering on the port, whoever started it? */
  async ping(port = this.port): Promise<BridgeStatus | undefined> {
    try {
      const health = await httpJson<HealthBody>(`${this.base(port)}/health`, undefined, 1500);
      return {
        running: true,
        adopted: this.adopted,
        host: health.host,
        port: health.port,
        active: health.active,
        configured: health.configured ?? [],
        providers: health.providers ?? {},
        tokens: health.tokens ?? {},
      };
    } catch {
      return undefined;
    }
  }

  async status(): Promise<BridgeStatus> {
    const live = await this.ping();
    if (live) return live;

    const c = vscode.workspace.getConfiguration('switchboard');
    return {
      running: false,
      adopted: false,
      host: c.get<string>('listenHost', '127.0.0.1'),
      port: this.port,
      active: c.get<string>('activeProvider', 'genai'),
      configured: [],
      providers: {},
      tokens: {},
    };
  }

  /** Exchange a platform's token without sending a prompt. */
  async refreshToken(
    provider?: string,
  ): Promise<{ ok: boolean; token?: TokenStatus; skipped?: string; error?: string }> {
    try {
      return await httpJson(
        `${this.base()}/__control/refresh`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(provider ? { provider } : {}),
        },
        35000,
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Ask a platform which models it actually serves. */
  async upstreamModels(provider?: string): Promise<string[]> {
    const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    try {
      const body = await httpJson<{ models: string[] }>(
        `${this.base()}/__control/upstream-models${query}`,
        undefined,
        15000,
      );
      return body.models ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Start the bridge, or adopt one that is already serving the port.
   * Returns a short description of what happened, for the log.
   */
  async ensureRunning(
    settings: Settings,
    pats: Record<string, string>,
    directKey: string,
    active: ProviderId,
  ): Promise<'started' | 'adopted'> {
    const existing = await this.ping(settings.listenPort);
    if (existing) {
      this.adopted = this.ownPid === undefined;
      this.startTailing();
      this._onDidChange.fire();
      return 'adopted';
    }

    // A dead pid file means a previous bridge crashed. Clear it and move on.
    const record = readPidFile();
    if (record && !isAlive(record.pid)) {
      try {
        fs.unlinkSync(PID_FILE);
      } catch {
        /* best effort */
      }
    }

    const script = path.join(this.context.extensionPath, 'bridge', 'standalone.js');
    if (!fs.existsSync(script)) {
      throw new Error(`bridge script missing at ${script}`);
    }

    // Logs go to a file rather than a pipe. A piped child is tied to this
    // process; a file-backed one is genuinely independent of VS Code.
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const logFd = fs.openSync(LOG_FILE, 'a');

    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...bridgeEnv(settings, pats, directKey, active), BRIDGE_PID_FILE: PID_FILE },
      windowsHide: true,
    });

    child.unref();
    fs.closeSync(logFd);
    this.ownPid = child.pid;
    this.adopted = false;

    child.on('error', (err) => {
      this.output.appendLine(`[extension] failed to spawn bridge: ${err.message}`);
    });

    await this.waitForHealth(settings.listenPort);
    this.startTailing();
    this._onDidChange.fire();
    return 'started';
  }

  private async waitForHealth(port: number, attempts = 25): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (await this.ping(port)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `bridge did not come up on port ${port}. Check the log: ${LOG_FILE}`,
    );
  }

  async stop(): Promise<void> {
    const record = readPidFile();
    const pid = record?.pid ?? this.ownPid;
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        this.output.appendLine(`[extension] could not stop pid ${pid}: ${err}`);
      }
    }
    this.ownPid = undefined;
    this.adopted = false;

    // Give it a moment to release the port before anyone rebinds it.
    for (let i = 0; i < 15; i++) {
      if (!(await this.ping(record?.port ?? this.port))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    this._onDidChange.fire();
  }

  async restart(
    settings: Settings,
    pats: Record<string, string>,
    directKey: string,
    active: ProviderId,
  ): Promise<void> {
    await this.stop();
    await this.ensureRunning(settings, pats, directKey, active);
  }

  /* ---------------- control plane ---------------- */

  /** Select a provider by id, or step to the next configured one. */
  async select(provider?: ProviderId): Promise<string> {
    const res = await httpJson<{ active: string }>(`${this.base()}/__control/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider ? { provider } : {}),
    });
    this._onDidChange.fire();
    return res.active;
  }

  async testConnection(model?: string, provider?: string): Promise<{
    ok: boolean;
    status?: number;
    ms?: number;
    provider?: string;
    label?: string;
    body?: string;
    error?: string;
  }> {
    try {
      return await httpJson(`${this.base()}/__control/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, provider }),
      }, 35000);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /* ---------------- log tailing ---------------- */

  /**
   * Follow the bridge log file into the output channel. Polling beats fs.watch
   * here: it behaves the same on every platform and cannot miss an append.
   */
  private startTailing(): void {
    if (this.tailTimer) return;

    try {
      this.tailOffset = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    } catch {
      this.tailOffset = 0;
    }

    this.tailTimer = setInterval(() => {
      try {
        if (!fs.existsSync(LOG_FILE)) return;
        const size = fs.statSync(LOG_FILE).size;
        if (size === this.tailOffset) return;
        if (size < this.tailOffset) this.tailOffset = 0; // rotated or truncated

        const fd = fs.openSync(LOG_FILE, 'r');
        const length = size - this.tailOffset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, this.tailOffset);
        fs.closeSync(fd);
        this.tailOffset = size;

        const text = buf.toString('utf8');
        for (const raw of text.split('\n')) {
          const line = raw.replace(/\r$/, '');
          if (!line.trim()) continue;
          this.output.appendLine(line);
          this.recentLines.push(line);
          this._onDidLog.fire(line);
        }
        if (this.recentLines.length > BridgeProcess.MAX_LINES) {
          this.recentLines.splice(0, this.recentLines.length - BridgeProcess.MAX_LINES);
        }
        if (/\[event\]/.test(text)) this._onDidChange.fire();
      } catch {
        /* the log will be there next tick */
      }
    }, 600);
  }

  dispose(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = undefined;
    this._onDidChange.dispose();
    this._onDidLog.dispose();
    // The bridge process is deliberately left running.
  }
}
