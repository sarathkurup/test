import * as vscode from 'vscode';

/** The upstreams Switchboard can route to, in the order the UI shows them. */
export const PROVIDER_IDS = ['genai', 'bedrock', 'direct'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type AuthMode = 'pat' | 'jwt' | 'none';
export type ApiShape = 'openai' | 'anthropic';

/** Each corporate platform keeps its token under its own key. */
export function patKey(id: ProviderId): string {
  return `switchboard.${id}.pat`;
}

export interface ProviderSettings {
  id: ProviderId;
  label: string;
  url: string;
  authMode: AuthMode;
  apiShape: ApiShape;
  userEmail: string;
  environment: string;
  environmentUrls: Record<string, string>;
  refreshUrl: string;
  modelMap: Record<string, string>;
  identityHeader: string;
  tenantHeader: string;
  tenantId: string;
  authHeader: string;
  authPrefix: string;
  pathTemplate: string;
  extraHeaders: Record<string, string>;
  region: string;
}

export interface Settings {
  activeProvider: ProviderId;
  listenHost: string;
  listenPort: number;
  autoStart: boolean;
  includeUsage: boolean;
  forceNonStreaming: boolean;
  verbose: boolean;
  directUrl: string;
  providers: Record<'genai' | 'bedrock', ProviderSettings>;
}

const LABELS: Record<ProviderId, string> = {
  genai: 'GenAI platform',
  bedrock: 'AWS Bedrock',
  direct: 'Direct',
};

function readProvider(id: 'genai' | 'bedrock'): ProviderSettings {
  const c = vscode.workspace.getConfiguration(`switchboard.${id}`);
  const str = (k: string, d = '') => c.get<string>(k, d).trim();

  return {
    id,
    label: LABELS[id],
    url: str('url').replace(/\/+$/, ''),
    authMode: c.get<AuthMode>('authMode', 'pat'),
    apiShape: c.get<ApiShape>('apiShape', 'openai'),
    userEmail: str('userEmail'),
    environment: str('environment').toUpperCase(),
    environmentUrls: c.get<Record<string, string>>('environmentUrls', {}),
    refreshUrl: str('refreshUrl').replace(/\/+$/, ''),
    modelMap: c.get<Record<string, string>>('modelMap', {}),
    identityHeader: str('identityHeader'),
    tenantHeader: str('tenantHeader'),
    tenantId: str('tenantId'),
    authHeader: str('authHeader', 'Authorization'),
    // Not trimmed: the trailing space in "Bearer " is load-bearing.
    authPrefix: c.get<string>('authPrefix', 'Bearer '),
    pathTemplate: str('pathTemplate'),
    extraHeaders: c.get<Record<string, string>>('extraHeaders', {}),
    region: str('region'),
  };
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('switchboard');
  return {
    activeProvider: c.get<ProviderId>('activeProvider', 'genai'),
    listenHost: c.get<string>('listenHost', '127.0.0.1').trim() || '127.0.0.1',
    listenPort: c.get<number>('listenPort', 8787),
    autoStart: c.get<boolean>('autoStart', true),
    includeUsage: c.get<boolean>('includeUsage', true),
    forceNonStreaming: c.get<boolean>('forceNonStreaming', false),
    verbose: c.get<boolean>('verbose', false),
    directUrl: c.get<string>('direct.url', 'https://api.anthropic.com/v1/messages'),
    providers: { genai: readProvider('genai'), bedrock: readProvider('bedrock') },
  };
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration('switchboard')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/** The token exchange URL this provider will actually use. */
export function effectiveRefreshUrl(p: ProviderSettings): string {
  if (p.refreshUrl) return p.refreshUrl;
  const fromEnv = p.environmentUrls?.[p.environment];
  return (fromEnv ?? '').trim().replace(/\/+$/, '');
}

/** What is still missing before this provider can be reached. */
export function missingForProvider(p: ProviderSettings, patSet: boolean): string[] {
  const missing: string[] = [];
  if (!p.url) missing.push('a URL');
  if (p.authMode !== 'none' && !patSet) missing.push('a token');
  if (p.authMode === 'jwt') {
    if (!effectiveRefreshUrl(p)) {
      missing.push(
        p.environment
          ? `a refresh URL for ${p.environment}`
          : 'an environment or a refresh URL',
      );
    }
    if (p.identityHeader && !p.userEmail) missing.push('a user email');
  }
  return missing;
}

/**
 * Build the environment for the bridge process.
 *
 * Secrets travel here and nowhere else: they are passed to the child at spawn
 * time and never written to a settings file.
 */
export function bridgeEnv(
  s: Settings,
  pats: Record<string, string>,
  directKey: string,
  active: ProviderId,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(s.listenPort),
    HOST: s.listenHost,
    ACTIVE_PROVIDER: active,
    DIRECT_URL: s.directUrl,
    DIRECT_API_KEY: directKey,
    INCLUDE_USAGE: s.includeUsage ? '1' : '0',
    FORCE_NON_STREAMING: s.forceNonStreaming ? '1' : '0',
    BRIDGE_VERBOSE: s.verbose ? '1' : '0',
  };

  for (const id of ['genai', 'bedrock'] as const) {
    const p = s.providers[id];
    const prefix = id.toUpperCase();
    Object.assign(out, {
      [`${prefix}_LABEL`]: p.label,
      [`${prefix}_URL`]: p.url,
      [`${prefix}_SHAPE`]: p.apiShape,
      [`${prefix}_AUTH_MODE`]: p.authMode,
      [`${prefix}_PAT`]: pats[id] ?? '',
      [`${prefix}_AUTH_HEADER`]: p.authHeader,
      [`${prefix}_AUTH_PREFIX`]: p.authPrefix,
      [`${prefix}_IDENTITY_HEADER`]: p.identityHeader,
      [`${prefix}_EMAIL`]: p.userEmail,
      [`${prefix}_TENANT_HEADER`]: p.tenantHeader,
      [`${prefix}_TENANT_ID`]: p.tenantId,
      [`${prefix}_ENV`]: p.environment,
      [`${prefix}_ENV_URLS`]: JSON.stringify(p.environmentUrls ?? {}),
      [`${prefix}_REFRESH_URL`]: p.refreshUrl,
      [`${prefix}_PATH_TEMPLATE`]: p.pathTemplate,
      [`${prefix}_EXTRA_HEADERS`]: JSON.stringify(p.extraHeaders ?? {}),
      [`${prefix}_MODEL_MAP`]: JSON.stringify(p.modelMap ?? {}),
      [`${prefix}_REGION`]: p.region,
    });
  }

  return out;
}

export async function getPats(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ['genai', 'bedrock'] as const) {
    out[id] = (await context.secrets.get(patKey(id))) ?? '';
  }
  return out;
}

export const DIRECT_KEY = 'switchboard.direct.apiKey';

export async function getDirectKey(context: vscode.ExtensionContext): Promise<string> {
  return (await context.secrets.get(DIRECT_KEY)) ?? '';
}

/** Prompt for a secret and store it. Returns true if something was saved. */
export async function promptForSecret(
  context: vscode.ExtensionContext,
  key: string,
  prompt: string,
): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    prompt,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Paste the token. It is stored in the OS keychain, never in settings.json.',
  });
  if (value === undefined) return false;

  if (value.trim() === '') {
    await context.secrets.delete(key);
    return true;
  }
  await context.secrets.store(key, value.trim());
  return true;
}
