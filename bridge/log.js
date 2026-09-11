'use strict';

/**
 * Logging with credential redaction baked in.
 *
 * Everything the bridge prints ends up in the extension's output channel and,
 * during a demo, on a projector. Nothing here may ever emit a PAT.
 */

const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-gateway-token',
  'api-key',
  'proxy-authorization',
  'cookie',
]);

const secrets = new Set();

/** Register a value that must never appear in output. */
function guard(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

function mask(text) {
  let out = String(text);
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join('••••••••');
  }
  return out;
}

/** Copy headers with secret values replaced, for logging only. */
function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? '••••••••' : mask(v);
  }
  return out;
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(stream, level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  stream(stamp() + ' ' + level + ' ' + mask(text));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const log = {
  guard,
  mask,
  safeHeaders,
  info: (...a) => emit(console.log, '[bridge]', a),
  warn: (...a) => emit(console.log, '[warn]  ', a),
  error: (...a) => emit(console.error, '[error] ', a),
  /** Structured line the extension panel can parse. */
  event: (name, data) => {
    console.log(stamp() + ' [event] ' + mask(safeStringify({ name, ...data })));
  },
};

module.exports = log;
