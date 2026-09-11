'use strict';

const express = require('express');
const { fetch } = require('undici');

const log = require('./log');
const { TokenManager } = require('./token');
const {
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
} = require('./config');
const {
  toOpenAI,
  streamToAnthropic,
  completionToAnthropic,
  sse,
} = require('./adapter');

/* ------------------------------------------------------------------ */
/* Credentials, one exchange per provider                              */
/* ------------------------------------------------------------------ */

const tokens = Object.fromEntries(
  PROVIDER_IDS.map((id) => {
    const p = providers[id];
    return [
      id,
      new TokenManager({
        refreshUrl: p.refreshUrl,
        pat: p.pat,
        email: p.email,
        identityHeader: p.identityHeader,
        tenantId: p.tenantId,
        tenantHeader: p.tenantHeader,
        label: p.label,
        log,
      }),
    ];
  }),
);

async function bearerFor(provider, forceRefresh = false) {
  if (provider.authMode !== 'jwt') return '';
  return tokens[provider.id].get({ forceRefresh });
}

const isAuthRejection = (status) => status === 401 || status === 403;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function anthropicError(res, status, message, type = 'api_error') {
  if (res.headersSent) return;
  res.status(status).json({ type: 'error', error: { type, message } });
}

function openSseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/**
 * Relay an upstream body to the client, honouring backpressure.
 *
 * Writing without checking the return value lets a slow client push the whole
 * response into this process's memory, which for a long streamed answer is a
 * real amount of it.
 *
 * Upstream response headers are never copied. undici has already decompressed
 * the body, so forwarding content-encoding or content-length would tell the
 * client to gunzip plaintext or expect the wrong byte count.
 */
async function relay(body, res) {
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length ?? 0;
    if (!res.write(Buffer.from(chunk))) {
      await new Promise((resolve) => {
        const finish = () => {
          res.off('drain', finish);
          res.off('close', finish);
          resolve();
        };
        res.once('drain', finish);
        res.once('close', finish);
      });
    }
    if (res.writableEnded || res.destroyed) break;
  }
  return bytes;
}

/** Rough token estimate. count_tokens is advisory, so this need not be exact. */
function estimateTokens(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body ?? {}).length / 4));
}

function isStreamRejection(status, text) {
  if (status !== 400 && status !== 422 && status !== 501) return false;
  return /stream/i.test(text || '');
}

/**
 * POST to a provider, renewing the credential and retrying once if rejected.
 * A JWT can expire between the check and the call, and a gateway may revoke
 * one early; either way a single clean retry beats a failed turn.
 */
async function postUpstream(provider, body, inbound, controller, model) {
  const url = endpointFor(provider, model);
  let bearer = await bearerFor(provider);

  let response = await fetch(url, {
    method: 'POST',
    headers: upstreamHeaders(provider, inbound, bearer),
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  if (isAuthRejection(response.status) && provider.authMode === 'jwt') {
    log.warn(
      `${provider.label} returned ${response.status}; renewing the token and retrying once`,
    );
    bearer = await bearerFor(provider, true);
    response = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(provider, inbound, bearer),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  }

  return response;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function createApp() {
  const app = express();
  app.use(express.json({ limit: '64mb' }));

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError) {
      return anthropicError(res, 400, 'malformed JSON body', 'invalid_request_error');
    }
    return next(err);
  });

  /* ---------------- health + control ---------------- */

  const status = () => ({
    ...describe(),
    tokens: Object.fromEntries(PROVIDER_IDS.map((id) => [id, tokens[id].describe()])),
  });

  app.get('/health', (req, res) => res.json({ ok: true, ...status() }));
  app.get('/__control/status', (req, res) => res.json(status()));

  app.post('/__control/select', (req, res) => {
    try {
      const next = req.body?.provider ? setActive(req.body.provider) : cycleActive();
      log.info(`upstream switched to ${providers[next].label}`);
      log.event('toggle', { active: next, label: providers[next].label });
      res.json({ active: next });
    } catch (err) {
      anthropicError(res, 400, err.message, 'invalid_request_error');
    }
  });

  /** Exchange a token without sending a prompt, so credentials can be checked alone. */
  app.post('/__control/refresh', async (req, res) => {
    const provider = req.body?.provider ? providers[req.body.provider] : currentProvider();
    if (!provider) {
      return res.status(400).json({ ok: false, error: 'unknown provider' });
    }
    if (provider.authMode !== 'jwt') {
      return res.json({
        ok: true,
        skipped: `${provider.label} sends its token directly; no exchange needed`,
      });
    }
    try {
      await tokens[provider.id].get({ forceRefresh: true });
      res.json({ ok: true, token: tokens[provider.id].describe() });
    } catch (err) {
      log.error(`token exchange failed: ${err.message}`);
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  /** One-shot probe so the UI can prove connectivity end to end. */
  app.post('/__control/test', async (req, res) => {
    const provider = req.body?.provider ? providers[req.body.provider] : currentProvider();
    if (!provider?.url) {
      return res.status(400).json({ ok: false, error: 'that provider has no URL configured' });
    }

    const model = mapModel(req.body?.model || Object.keys(provider.modelMap)[0] || '', provider);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const body =
        provider.shape === 'anthropic'
          ? { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
          : { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };

      const r = await postUpstream(provider, body, req.headers, controller, model);
      const text = await r.text();
      const ms = Date.now() - started;
      log.event('test', { upstream: provider.id, status: r.status, ms });
      res.json({
        ok: r.ok,
        status: r.status,
        ms,
        provider: provider.id,
        label: provider.label,
        url: endpointFor(provider, model),
        token: tokens[provider.id].describe(),
        body: text.slice(0, 600),
      });
    } catch (err) {
      log.error(`test failed: ${err.message}`);
      res.status(502).json({ ok: false, error: err.message, provider: provider.id });
    } finally {
      clearTimeout(timer);
    }
  });

  /* ---------------- Anthropic surface (Claude Code) ---------------- */

  app.post('/v1/messages/count_tokens', (req, res) => {
    res.json({ input_tokens: estimateTokens(req.body) });
  });

  app.post('/v1/messages', async (req, res) => {
    const provider = currentProvider();
    const clientModel = req.body?.model || 'unknown';

    if (!provider.url) {
      return anthropicError(
        res,
        503,
        `${provider.label} has no URL configured. Set one, or switch provider.`,
        'invalid_request_error',
      );
    }

    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);

    const started = Date.now();
    log.event('request', {
      upstream: provider.id,
      model: clientModel,
      messages: req.body?.messages?.length ?? 0,
      tools: req.body?.tools?.length ?? 0,
      stream: req.body?.stream !== false,
    });

    try {
      if (!needsTranslation(provider)) {
        return await passthroughAnthropic(req, res, provider, controller, started);
      }
      return await translateToOpenAI(req, res, provider, controller, started, clientModel);
    } catch (err) {
      if (controller.signal.aborted) {
        log.warn('client disconnected mid-request');
        return;
      }
      const message = err.message || String(err);
      log.error(`request failed: ${message}`);
      if (!res.headersSent) return anthropicError(res, 502, `bridge: ${message}`);
      try {
        sse(res, 'error', { type: 'error', error: { type: 'api_error', message } });
        res.end();
      } catch {
        /* socket already gone */
      }
    } finally {
      res.off('close', onClose);
    }
  });

  /* ---------------- OpenAI surface ---------------- */

  const modelCache = new Map();

  /** Ask a provider which models it actually serves. */
  async function upstreamModels(provider = currentProvider()) {
    const url = modelsEndpointFor(provider);
    if (!url) return [];

    const cached = modelCache.get(provider.id);
    if (cached && Date.now() - cached.at < 60000) return cached.ids;

    try {
      const bearer = await bearerFor(provider);
      const r = await fetch(url, {
        method: 'GET',
        headers: upstreamHeaders(provider, {}, bearer),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return [];
      const body = await r.json();
      const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
      modelCache.set(provider.id, { at: Date.now(), ids });
      return ids;
    } catch (err) {
      log.warn(`could not list models for ${provider.label}: ${err.message}`);
      return [];
    }
  }

  app.get('/v1/models', async (req, res) => {
    const provider = currentProvider();
    const mapped = Object.keys(provider.modelMap);
    const ids = mapped.length ? mapped : await upstreamModels(provider);

    res.json({
      object: 'list',
      data: (ids.length ? ids : ['claude-opus-4-6', 'claude-sonnet-4-6']).map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'switchboard',
      })),
    });
  });

  /** What a provider serves, unmapped. Useful when filling in the model map. */
  app.get('/__control/upstream-models', async (req, res) => {
    const provider = req.query.provider ? providers[String(req.query.provider)] : currentProvider();
    if (!provider) return res.status(400).json({ models: [], error: 'unknown provider' });
    res.json({ provider: provider.id, models: await upstreamModels(provider) });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const provider = currentProvider();
    if (!provider.url || provider.shape !== 'openai') {
      return res.status(503).json({
        error: {
          message:
            `OpenAI passthrough needs an OpenAI-shaped upstream. ${provider.label} is ` +
            `${provider.shape}. Point this client at /v1/messages instead, which serves ` +
            'every provider.',
          type: 'invalid_request_error',
        },
      });
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const model = mapModel(req.body?.model, provider);
    const body = { ...req.body, model };
    const wantsStream = body.stream !== false;
    const started = Date.now();

    log.event('request', {
      surface: 'openai',
      upstream: provider.id,
      model: req.body?.model,
      stream: wantsStream,
    });

    try {
      const r = await postUpstream(provider, body, req.headers, controller, model);

      if (!r.ok) {
        const text = await r.text();
        log.error(`${provider.label} ${r.status}: ${text.slice(0, 400)}`);
        return res.status(r.status).type('application/json').send(text);
      }

      if (!wantsStream) {
        log.event('response', { surface: 'openai', ms: Date.now() - started });
        return res.json(await r.json());
      }

      openSseHeaders(res);
      await relay(r.body, res);
      res.end();
      log.event('response', { surface: 'openai', ms: Date.now() - started });
    } catch (err) {
      if (controller.signal.aborted) return;
      log.error(`openai passthrough failed: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: err.message, type: 'api_error' } });
      } else {
        res.end();
      }
    }
  });

  app.use((req, res) =>
    anthropicError(res, 404, `no route ${req.method} ${req.path}`, 'not_found_error'),
  );

  return app;
}

/* ------------------------------------------------------------------ */
/* Request paths                                                       */
/* ------------------------------------------------------------------ */

/** Anthropic-shaped upstream: remap the model, forward, pipe the stream back. */
async function passthroughAnthropic(req, res, provider, controller, started) {
  const model = mapModel(req.body?.model, provider);
  const body = { ...req.body, model };
  const r = await postUpstream(provider, body, req.headers, controller, model);

  if (!r.ok) {
    const text = await r.text();
    log.error(`${provider.label} ${r.status}: ${text.slice(0, 400)}`);
    return res.status(r.status).type('application/json').send(text);
  }

  if (body.stream === false) {
    log.event('response', { upstream: provider.id, ms: Date.now() - started });
    return res.json(await r.json());
  }

  openSseHeaders(res);
  await relay(r.body, res);
  res.end();
  log.event('response', { upstream: provider.id, ms: Date.now() - started });
}

/** OpenAI-shaped upstream: full translation in both directions. */
async function translateToOpenAI(req, res, provider, controller, started, clientModel) {
  const openaiBody = toOpenAI(req.body, {
    mapModel: (m) => mapModel(m, provider),
    includeUsage: config.includeUsage,
  });

  if (config.verbose) {
    log.info(`-> ${provider.label} ${JSON.stringify(openaiBody).slice(0, 2000)}`);
  }

  const nonStreamingBody = () => {
    const copy = { ...openaiBody, stream: false };
    delete copy.stream_options;
    return copy;
  };

  let r = await postUpstream(
    provider,
    config.forceNonStreaming ? nonStreamingBody() : openaiBody,
    req.headers,
    controller,
    openaiBody.model,
  );

  if (!r.ok) {
    const text = await r.text();
    if (isStreamRejection(r.status, text)) {
      log.warn(`${provider.label} rejected streaming; retrying without it`);
      r = await postUpstream(
        provider,
        nonStreamingBody(),
        req.headers,
        controller,
        openaiBody.model,
      );
      if (!r.ok) {
        const retryText = await r.text();
        log.error(`${provider.label} ${r.status}: ${retryText.slice(0, 400)}`);
        return anthropicError(res, r.status, retryText.slice(0, 2000));
      }
    } else {
      log.error(`${provider.label} ${r.status}: ${text.slice(0, 400)}`);
      return anthropicError(res, r.status, text.slice(0, 2000));
    }
  }

  const contentType = r.headers.get('content-type') || '';
  openSseHeaders(res);

  const result = contentType.includes('text/event-stream')
    ? await streamToAnthropic(r.body, res, clientModel)
    : completionToAnthropic(await r.json(), res, clientModel);

  log.event('response', {
    upstream: provider.id,
    ms: Date.now() - started,
    stop: result.finish,
    tools: result.toolCalls,
    in: result.usage.input_tokens,
    out: result.usage.output_tokens,
  });
}

/* ------------------------------------------------------------------ */

function start() {
  for (const id of PROVIDER_IDS) log.guard(providers[id].pat);

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    log.info(`listening on http://${config.host}:${config.port}`);

    const usable = configuredProviders();
    log.info(
      usable.length
        ? `providers configured: ${usable.map((id) => providers[id].label).join(', ')}`
        : 'no providers configured yet',
    );

    for (const id of usable) {
      const p = providers[id];
      log.info(
        `  ${p.label}: ${p.url}  shape=${p.shape}  auth=${p.authMode}` +
          `  token=${p.pat ? '••••••••' : '(none)'}` +
          (p.authMode === 'jwt' ? `  exchange=${p.refreshUrl || '(not set)'}` : ''),
      );
    }
    log.info(`active: ${providers[getActive()].label}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `port ${config.port} is already in use. Another bridge may be running, or an ` +
          'existing gateway proxy that listens on the same port. Stop it, or set a ' +
          'different port.',
      );
      process.exit(2);
    }
    log.error(`server error: ${err.message}`);
    process.exit(1);
  });

  // A long agentic turn can easily outlast Node's default timeouts, which
  // would sever the connection mid-stream and look like the model hanging.
  // There is no sensible upper bound to pick, so there is none.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.timeout = 0;

  // Without this, Nagle's algorithm holds small SSE frames in the socket
  // buffer waiting for more data, so tokens arrive in clumps.
  server.on('connection', (socket) => socket.setNoDelay(true));

  // Renew credentials shortly before they lapse, so the first request after an
  // idle spell does not pay for the exchange. Lazy renewal covers the rest.
  const timer = setInterval(() => {
    for (const id of PROVIDER_IDS) {
      const manager = tokens[id];
      if (providers[id].authMode !== 'jwt') continue;
      if (!manager.configured || !manager.jwt) continue;
      if (manager.expiresAtMs - Date.now() > 2 * 60 * 1000) continue;
      manager
        .get({ forceRefresh: true })
        .catch((err) => log.warn(`background renewal failed: ${err.message}`));
    }
  }, 60 * 1000);
  timer.unref();

  return server;
}

module.exports = { createApp, start, tokens };
