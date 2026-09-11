'use strict';

/**
 * Gateway credential exchange.
 *
 * Some corporate gateways do not accept a personal access token directly.
 * They trade it for a short-lived JWT which is what actually authorises calls:
 *
 *   POST {refreshBaseUrl}/refresh
 *   headers: the configured tenant and identity headers
 *   body:    { "token": "<PAT>" }
 *   returns: { "token": "<JWT>" }
 *
 * Header names are supplied by configuration rather than fixed here, so a
 * second platform with different conventions needs no new code.
 *
 * Two refinements over a fixed refresh interval:
 *
 *   The expiry is read from the JWT's own `exp` claim where present, so the
 *   token is renewed on the schedule the issuer actually set rather than one
 *   we assumed. A fixed interval is the fallback.
 *
 *   Concurrent callers share a single in-flight refresh, so a burst of
 *   requests after expiry produces one exchange rather than a stampede.
 */

const { fetch } = require('undici');

const DEFAULT_LIFETIME_MS = 30 * 60 * 1000;
/** Renew this far ahead of expiry so a request never races the deadline. */
const EARLY_RENEWAL_MS = 60 * 1000;

/** Read `exp` out of a JWT without verifying it. We are the bearer, not the verifier. */
function expiryFromJwt(jwt) {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

class TokenManager {
  /**
   * @param {object} opts
   * @param {string} opts.refreshUrl       Base URL; "/refresh" is appended.
   * @param {string} opts.pat              The long-lived personal access token.
   * @param {string} [opts.email]          Value for the identity header.
   * @param {string} [opts.identityHeader] Header carrying the identity.
   * @param {string} [opts.tenantId]       Value for the tenant header.
   * @param {string} [opts.tenantHeader]   Header carrying the tenant.
   * @param {string} [opts.label]          Name used in log lines.
   * @param {object} [opts.log]            Logger with info/warn/error/guard.
   */
  constructor({
    refreshUrl,
    pat,
    email,
    identityHeader,
    tenantId,
    tenantHeader,
    label,
    log,
  }) {
    this.refreshUrl = (refreshUrl || '').replace(/\/+$/, '');
    this.pat = pat || '';
    this.email = email || '';
    this.identityHeader = identityHeader || '';
    this.tenantId = tenantId || '';
    this.tenantHeader = tenantHeader || '';
    this.label = label || 'gateway';
    this.log = log || { info() {}, warn() {}, error() {} };

    this.jwt = null;
    this.expiresAtMs = 0;
    this.inFlight = null;
    this.lastError = undefined;
    this.refreshCount = 0;
  }

  get configured() {
    // An identity is only required when a header has been named for it.
    const identityOk = !this.identityHeader || Boolean(this.email);
    return Boolean(this.refreshUrl && this.pat && identityOk);
  }

  /** True when a usable token is held. */
  get valid() {
    return Boolean(this.jwt) && Date.now() < this.expiresAtMs;
  }

  /**
   * Return a usable JWT, exchanging or renewing as needed.
   * Pass forceRefresh after the gateway rejects a token we believed was good.
   */
  async get({ forceRefresh = false } = {}) {
    if (!this.configured) {
      const missing = [];
      if (!this.refreshUrl) missing.push('a refresh URL');
      if (!this.pat) missing.push('a personal access token');
      if (this.identityHeader && !this.email) missing.push('a user identity');
      throw new Error(`token exchange for ${this.label} needs ${missing.join(', ')}`);
    }

    if (!forceRefresh && this.valid) return this.jwt;

    // Collapse concurrent callers onto one exchange.
    if (!this.inFlight) {
      this.inFlight = this.exchange().finally(() => {
        this.inFlight = null;
      });
    }

    await this.inFlight;
    return this.jwt;
  }

  async exchange() {
    const url = `${this.refreshUrl}/refresh`;
    const started = Date.now();

    const headers = { 'Content-Type': 'application/json' };
    if (this.tenantHeader && this.tenantId) headers[this.tenantHeader] = this.tenantId;
    if (this.identityHeader && this.email) headers[this.identityHeader] = this.email;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: this.pat }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      this.lastError = `token exchange could not reach ${url}: ${err.message}`;
      throw new Error(this.lastError);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.lastError =
        `token exchange failed with ${response.status}` +
        (text ? `: ${text.slice(0, 300)}` : '');
      throw new Error(this.lastError);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      this.lastError = 'token exchange returned a body that is not JSON';
      throw new Error(this.lastError);
    }

    if (!body || typeof body.token !== 'string' || !body.token) {
      this.lastError = 'token exchange response has no token field';
      throw new Error(this.lastError);
    }

    this.jwt = body.token;
    this.refreshCount += 1;
    this.lastError = undefined;

    // Register the new credential for redaction. The PAT is guarded at
    // startup, but the JWT only exists from here on.
    this.log.guard?.(this.jwt);

    const claimed = expiryFromJwt(this.jwt);
    if (claimed) {
      // Renew ahead of expiry, but never by so much that a freshly issued
      // token counts as already stale. A gateway handing out short-lived
      // tokens would otherwise send us into a refresh loop.
      const lifetime = Math.max(0, claimed - Date.now());
      const margin = Math.min(EARLY_RENEWAL_MS, lifetime * 0.1);
      this.expiresAtMs = claimed - margin;
    } else {
      this.expiresAtMs = Date.now() + DEFAULT_LIFETIME_MS;
    }

    // Never log the token itself, only how long it is good for.
    const minutes = Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 60000));
    this.log.info(
      `${this.label}: token exchanged in ${Date.now() - started}ms, renewing in ~${minutes}m` +
        (claimed ? ' (from the exp claim)' : ' (no exp claim; using the default lifetime)'),
    );

    return this.jwt;
  }

  /** Safe for a UI or a log: says everything except the token. */
  describe() {
    return {
      configured: this.configured,
      hasToken: Boolean(this.jwt),
      valid: this.valid,
      expiresInSeconds: this.jwt
        ? Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000))
        : 0,
      refreshCount: this.refreshCount,
      lastError: this.lastError,
      label: this.label,
      email: this.email,
      tenantId: this.tenantId,
      refreshUrl: this.refreshUrl,
    };
  }
}

module.exports = { TokenManager, expiryFromJwt, DEFAULT_LIFETIME_MS, EARLY_RENEWAL_MS };
