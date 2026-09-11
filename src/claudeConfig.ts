import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Overridable so the merge can be exercised against a copy in tests rather
// than against the real file in the user's home directory.
export const CLAUDE_DIR =
  process.env.SWITCHBOARD_CLAUDE_DIR || path.join(os.homedir(), '.claude');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

const BASE_URL = 'ANTHROPIC_BASE_URL';
const AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';

/** What was in the file before we touched it, so we can put it back exactly. */
const PREVIOUS_KEY = 'switchboard.claudeEnvBefore';

interface PreviousEnv {
  baseUrl?: string;
  authToken?: string;
  /** Whether the key existed at all, so unwire can delete rather than blank it. */
  hadBaseUrl: boolean;
  hadAuthToken: boolean;
}

export interface WireResult {
  file: string;
  backup?: string;
  baseUrl: string;
}

function readSettings(): Record<string, unknown> {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return {};

  const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  if (raw.trim() === '') return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    // Never overwrite a file we do not understand.
    throw new Error(
      `Could not parse ${CLAUDE_SETTINGS} (${err instanceof Error ? err.message : err}). ` +
        'Fix or move that file, then connect Claude Code again.',
    );
  }
}

function backup(): string | undefined {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(CLAUDE_DIR, `settings.json.switchboard-backup-${stamp}`);
  fs.copyFileSync(CLAUDE_SETTINGS, target);
  pruneBackups();
  return target;
}

/** Keep the five most recent backups; the rest are noise in the user's home. */
function pruneBackups(): void {
  try {
    const files = fs
      .readdirSync(CLAUDE_DIR)
      .filter((f) => f.startsWith('settings.json.switchboard-backup-'))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 5))) {
      fs.unlinkSync(path.join(CLAUDE_DIR, stale));
    }
  } catch {
    /* best effort */
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Point the Claude Code CLI at the bridge.
 *
 * Merges into the existing file and records the previous values so the change
 * can be undone precisely rather than approximately.
 */
export async function wireClaudeCode(
  context: vscode.ExtensionContext,
  port: number,
): Promise<WireResult> {
  const settings = readSettings();
  const env = (settings.env ?? {}) as Record<string, string>;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Only record the pre-bridge state the first time, so repeated wiring does
  // not overwrite the original values with our own.
  const alreadyWired = typeof env[BASE_URL] === 'string' && env[BASE_URL].includes('127.0.0.1');
  if (!alreadyWired || !context.globalState.get(PREVIOUS_KEY)) {
    const previous: PreviousEnv = {
      baseUrl: env[BASE_URL],
      authToken: env[AUTH_TOKEN],
      hadBaseUrl: BASE_URL in env,
      hadAuthToken: AUTH_TOKEN in env,
    };
    await context.globalState.update(PREVIOUS_KEY, previous);
  }

  const backupPath = backup();

  settings.env = { ...env, [BASE_URL]: baseUrl, [AUTH_TOKEN]: 'bridge' };
  writeSettings(settings);

  return { file: CLAUDE_SETTINGS, backup: backupPath, baseUrl };
}

/** Restore the environment keys to exactly what they were before wiring. */
export async function unwireClaudeCode(
  context: vscode.ExtensionContext,
): Promise<{ file: string; backup?: string }> {
  const settings = readSettings();
  const env = (settings.env ?? {}) as Record<string, string>;
  const previous = context.globalState.get<PreviousEnv>(PREVIOUS_KEY);

  const backupPath = backup();

  if (previous?.hadBaseUrl && previous.baseUrl !== undefined) {
    env[BASE_URL] = previous.baseUrl;
  } else {
    delete env[BASE_URL];
  }

  if (previous?.hadAuthToken && previous.authToken !== undefined) {
    env[AUTH_TOKEN] = previous.authToken;
  } else {
    delete env[AUTH_TOKEN];
  }

  if (Object.keys(env).length === 0) {
    delete settings.env;
  } else {
    settings.env = env;
  }

  writeSettings(settings);
  await context.globalState.update(PREVIOUS_KEY, undefined);
  return { file: CLAUDE_SETTINGS, backup: backupPath };
}

/** Is the CLI currently pointed at this bridge? */
export function isClaudeWired(port: number): boolean {
  try {
    const settings = readSettings();
    const env = (settings.env ?? {}) as Record<string, string>;
    return env[BASE_URL] === `http://127.0.0.1:${port}`;
  } catch {
    return false;
  }
}
