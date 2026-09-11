'use strict';

/**
 * Runtime configuration.
 *
 * Deliberately contains no organisation-specific values. Every URL, header
 * name and identity is supplied by the extension's settings and arrives here
 * as an environment variable at spawn time. Secrets are never written to disk
 * by this process.
 *
 * Three upstreams are configurable and only one is active at a time:
 *
 *   genai    the primary corporate platform
 *   bedrock  a second corporate platform, configured independently
 *   direct   api.anthropic.com, for comparison
 */

const PROVIDER_IDS = ['genai', 'bedrock', 'direct'];

function env(name, dflt = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}

function envBool(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function parseJsonObject(raw, label) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.error(`[bridge] ${label} is not valid JSON; ignoring it`);
    return {};
  }
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read one provider's settings from `${PREFIX}_*` variables.
 * Every provider supports the same options, so a second platform needs no
 * new code, only its own settings.
 */
function readProvider(id, prefix, defaults = {}) {
  const envUrls = parseJsonObject(env(`${prefix}_ENV_URLS`), `${prefix}_ENV_URLS`);
  const environment = env(`${prefix}_ENV`).toUpperCase();
  const shape = env(`${prefix}_SHAPE`, defaults.shape || 'openai');
  const authMode = env(`${prefix}_AUTH_MODE`, defaults.authMode || 'pat');

  return {
    id,
    label: env(`${prefix}_LABEL`, defaults.label || id),
    url: trimSlash(env(`${prefix}_URL`)),
    shape: shape === 'anthropic' ? 'anthropic' : 'openai',
    authMode: ['pat', 'jwt', 'none'].includes(authMode) ? authMode : 'pat',

    pat: env(`${prefix}_PAT`),
    authHeader: env(`${prefix}_AUTH_HEADER`, 'Authorization'),
    authPrefix:
      process.env[`${prefix}_AUTH_PREFIX`] !== undefined
        ? process.env[`${prefix}_AUTH_PREFIX`]
        : 'Bearer ',

    /* Identity, sent on every call when both name and value are set. */
    identityHeader: env(`${prefix}_IDENTITY_HEADER`),
    email: env(`${prefix}_EMAIL`),
    tenantHeader: env(`${prefix}_TENANT_HEADER`),
    tenantId: env(`${prefix}_TENANT_ID`),

    /* Token exchange. */
    environment,
    envUrls,
    refreshUrl: trimSlash(env(`${prefix}_REFRESH_URL`) || envUrls[environment] || ''),

    /**
     * Overrides the derived request path. `{model}` is substituted, which is
     * how model-in-the-path APIs such as Bedrock address a deployment.
     */
    pathTemplate: env(`${prefix}_PATH_TEMPLATE`),

    extraHeaders: parseJsonObject(env(`${prefix}_EXTRA_HEADERS`), `${prefix}_EXTRA_HEADERS`),
    modelMap: parseJsonObject(env(`${prefix}_MODEL_MAP`), `${prefix}_MODEL_MAP`),

    region: env(`${prefix}_REGION`),
  };
}

const providers = {
  genai: readProvider('genai', 'GENAI', { label: 'GenAI platform', shape: 'openai' }),
  bedrock: readProvider('bedrock', 'BEDROCK', { label: 'Bedrock', shape: 'anthropic' }),
  direct: {
    id: 'direct',
    label: 'Direct',
    url: env('DIRECT_URL', 'https://api.anthropic.com/v1/messages'),
    shape: 'anthropic',
    authMode: 'pat',
    pat: env('DIRECT_API_KEY'),
    authHeader: 'x-api-key',
    authPrefix: '',
    identityHeader: '',
    email: '',
    tenantHeader: '',
    tenantId: '',
    environment: '',
    envUrls: {},
    refreshUrl: '',
    pathTemplate: '',
    extraHeaders: { 'anthropic-version': env('DIRECT_ANTHROPIC_VERSION', '2023-06-01') },
    modelMap: {},
    region: '',
  },
};

const requested = env('ACTIVE_PROVIDER', 'genai');
const state = {
  active: PROVIDER_IDS.includes(requested) ? requested : 'genai',
};

const config = {
  port: Number(env('PORT', '8787')),
  host: env('HOST', '127.0.0.1'),
  providers,

  includeUsage: envBool('INCLUDE_USAGE', true),
  forceNonStreaming: envBool('FORCE_NON_STREAMING', false),
  verbose: envBool('BRIDGE_VERBOSE', false),
};

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

function getActive() {
  return state.active;
}

function setActive(next) {
  if (!PROVIDER_IDS.includes(next)) {
    throw new Error(`unknown provider "${next}" (expected ${PROVIDER_IDS.join(', ')})`);
  }
  state.active = next;
  return state.active;
}

/** Which providers are usable, in preference order. */
function configuredProviders() {
  return PROVIDER_IDS.filter((id) => Boolean(providers[id].url));
}

/** Step to the next configured provider, so one command can cycle them all. */
function cycleActive() {
  const usable = configuredProviders();
  if (usable.length < 2) return state.active;
  const i = usable.indexOf(state.active);
  return setActive(usable[(i + 1) % usable.length]);
}

function currentProvider() {
  return providers[state.active];
}

/** True when the request needs Anthropic to OpenAI translation. */
function needsTranslation(provider = currentProvider()) {
  return provider.shape === 'openai';
}

/* ------------------------------------------------------------------ */
/* URL shaping                                                         */
/* ------------------------------------------------------------------ */

const ENDPOINT_TAIL = /\/(chat\/completions|messages|completions|invoke|invoke-with-response-stream)$/;

/**
 * Build the request URL for a provider.
 * A base URL gains the conventional path; a full endpoint is used as given;
 * a path template wins over both and may carry the model.
 */
function endpointFor(provider, model = '') {
  if (!provider.url) return '';

  if (provider.pathTemplate) {
    const path = provider.pathTemplate.replace(/\{model\}/g, encodeURIComponent(model || ''));
    return provider.url + (path.startsWith('/') ? path : `/${path}`);
  }

  if (ENDPOINT_TAIL.test(provider.url)) return provider.url;

  return provider.url + (provider.shape === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
}

function modelsEndpointFor(provider = currentProvider()) {
  if (!provider.url) return '';
  const base = provider.url.replace(/\/v1\/(chat\/completions|messages|completions)$/, '');
  return `${base}/v1/models`;
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

function stripBearer(value) {
  return String(value || '').replace(/^Bearer\s+/i, '');
}

/**
 * Headers for one upstream call.
 *
 * @param {object} provider
 * @param {object} inbound  headers the client sent, used only as a fallback
 * @param {string} bearer   a JWT from the token manager, when auth mode is jwt
 */
function upstreamHeaders(provider, inbound = {}, bearer = '') {
  const headers = { 'Content-Type': 'application/json' };

  const credential =
    provider.authMode === 'jwt'
      ? bearer
      : provider.pat || inbound['x-api-key'] || stripBearer(inbound['authorization']);

  if (provider.authMode !== 'none' && credential) {
    headers[provider.authHeader] = provider.authPrefix + credential;
  }

  if (provider.tenantHeader && provider.tenantId) {
    headers[provider.tenantHeader] = provider.tenantId;
  }
  if (provider.identityHeader && provider.email) {
    headers[provider.identityHeader] = provider.email;
  }

  for (const [k, v] of Object.entries(provider.extraHeaders)) headers[k] = String(v);
  return headers;
}

/** Map a client-facing model id onto whatever this provider calls it. */
function mapModel(model, provider = currentProvider()) {
  if (!model) return model;
  const map = provider.modelMap || {};
  if (map[model]) return map[model];
  for (const [from, to] of Object.entries(map)) {
    if (from.endsWith('*') && model.startsWith(from.slice(0, -1))) return to;
  }
  return model;
}

/* ------------------------------------------------------------------ */

/** Safe to hand to a UI or a log: contains no credentials. */
function describeProvider(p) {
  return {
    id: p.id,
    label: p.label,
    url: p.url,
    endpoint: endpointFor(p),
    shape: p.shape,
    authMode: p.authMode,
    authHeader: p.authHeader,
    patConfigured: Boolean(p.pat),
    identityHeader: p.identityHeader,
    email: p.email,
    tenantHeader: p.tenantHeader,
    tenantId: p.tenantId,
    environment: p.environment,
    refreshUrl: p.refreshUrl,
    modelMap: p.modelMap,
    region: p.region,
    configured: Boolean(p.url),
  };
}

function describe() {
  return {
    active: state.active,
    port: config.port,
    host: config.host,
    configured: configuredProviders(),
    providers: Object.fromEntries(
      PROVIDER_IDS.map((id) => [id, describeProvider(providers[id])]),
    ),
    includeUsage: config.includeUsage,
    forceNonStreaming: config.forceNonStreaming,
  };
}

module.exports = {
  PROVIDER_IDS,
  config,
  providers,
  getActive,
  setActive,
  cycleActive,
  configuredProviders,
  currentProvider,
  needsTranslation,
  endpointFor,
  modelsEndpointFor,
  upstreamHeaders,
  mapModel,
  describe,
  describeProvider,
};
