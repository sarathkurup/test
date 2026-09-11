'use strict';

/**
 * A stand-in for the corporate gateway: an OpenAI-shaped endpoint that streams.
 *
 * It exists so the adapter can be proven before anyone hands over a real URL
 * and PAT. It deliberately reproduces the awkward parts of real gateways:
 * tool_call fragments split across chunks, the name arriving separately from
 * the arguments, and an optional mode that refuses streaming outright.
 *
 *   node mock/upstream.js                 # normal streaming gateway
 *   MOCK_REFUSE_STREAM=1 node mock/...    # rejects stream:true, forces fallback
 */

const express = require('express');

const PORT = Number(process.env.MOCK_PORT || 9099);
const REFUSE_STREAM = /^(1|true|yes)$/i.test(process.env.MOCK_REFUSE_STREAM || '');
const REQUIRED_TOKEN = process.env.MOCK_TOKEN || 'test-pat';

// Header names the simulated gateway insists on. Configurable so the mock is
// not tied to any one organisation's conventions either.
const IDENTITY_HEADER = (process.env.MOCK_IDENTITY_HEADER || 'x-ndaq-user').toLowerCase();
const TENANT_HEADER = (process.env.MOCK_TENANT_HEADER || 'x-amz-tenant-id').toLowerCase();

const app = express();
app.use(express.json({ limit: '64mb' }));

function chunk(model, delta, finish = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function write(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decide what the fake model should do, based on the conversation so far. */
function plan(messages) {
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
  if (lastTool) {
    return {
      kind: 'summary',
      text:
        'I read the file. It contains: ' +
        String(lastTool.content).slice(0, 120) +
        ' -- the function is called computeTotals.',
    };
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? '');

  if (/read|open|cat|show me the file/i.test(text)) {
    return {
      kind: 'tool',
      name: 'Read',
      args: { file_path: '/tmp/example.txt' },
      preamble: 'Let me read that file.',
    };
  }

  if (/2\s*\+\s*2/.test(text)) return { kind: 'text', text: '2 + 2 is 4.' };

  return { kind: 'text', text: 'Mock gateway received: ' + text.slice(0, 200) };
}

/* ------------------------------------------------------------------ */
/* Gateway-shaped surface                                              */
/*                                                                      */
/* Mirrors a corporate gateway that will not take a PAT directly: the   */
/* PAT is traded for a short-lived JWT at /api-access/refresh, and      */
/* every call must carry that JWT plus tenant and user headers.         */
/* ------------------------------------------------------------------ */

const issued = new Map();

function makeJwt(seconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const token = `${b64({ alg: 'none' })}.${b64({ sub: 'mock', exp })}.sig`;
  issued.set(token, exp * 1000);
  return token;
}

/** Short by design, so token renewal is exercised rather than assumed. */
const JWT_LIFETIME_SECONDS = Number(process.env.MOCK_JWT_SECONDS || 120);

app.post('/api-access/refresh', (req, res) => {
  if (req.headers[TENANT_HEADER] === undefined) {
    return res.status(400).json({ message: `missing ${TENANT_HEADER}` });
  }
  if (!req.headers[IDENTITY_HEADER]) {
    return res.status(400).json({ message: `missing ${IDENTITY_HEADER}` });
  }
  if (req.body?.token !== REQUIRED_TOKEN) {
    return res.status(403).json({ message: 'unknown personal access token' });
  }
  const token = makeJwt(JWT_LIFETIME_SECONDS);
  console.log(`  issued a JWT valid for ${JWT_LIFETIME_SECONDS}s to ${req.headers[IDENTITY_HEADER]}`);
  res.json({ token });
});

/** Returns an error payload when the caller is not properly authorised. */
function gatewayAuthProblem(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, message: 'missing Authorization' };
  if (!issued.has(token)) return { status: 401, message: 'not a token we issued' };
  if (Date.now() > issued.get(token)) return { status: 401, message: 'token expired' };
  if (!req.headers[TENANT_HEADER]) return { status: 400, message: `missing ${TENANT_HEADER}` };
  if (!req.headers[IDENTITY_HEADER]) return { status: 400, message: `missing ${IDENTITY_HEADER}` };
  return null;
}

app.get('/openai/v1/models', (req, res) => {
  const problem = gatewayAuthProblem(req);
  if (problem) return res.status(problem.status).json({ error: { message: problem.message } });
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model' },
      { id: 'gpt-4o-mini', object: 'model' },
      { id: 'claude-sonnet-4-5', object: 'model' },
    ],
  });
});

app.post('/openai/v1/chat/completions', async (req, res) => {
  const problem = gatewayAuthProblem(req);
  if (problem) {
    console.log(`  rejected: ${problem.message}`);
    return res.status(problem.status).json({ error: { message: problem.message } });
  }
  return chatCompletions(req, res);
});

/* ------------------------------------------------------------------ */

app.post('/v1/chat/completions', async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!auth.includes(REQUIRED_TOKEN)) {
    return res.status(401).json({
      error: { message: 'bad or missing token', type: 'authentication_error' },
    });
  }
  return chatCompletions(req, res);
});

async function chatCompletions(req, res) {
  const { model = 'mock-model', messages = [], stream } = req.body || {};
  const action = plan(messages);

  if (stream && REFUSE_STREAM) {
    return res.status(400).json({
      error: { message: 'stream is not supported on this deployment', type: 'invalid_request_error' },
    });
  }

  /* ---------- non-streaming ---------- */
  if (!stream) {
    const message =
      action.kind === 'tool'
        ? {
            role: 'assistant',
            content: action.preamble,
            tool_calls: [
              {
                id: 'call_mock_1',
                type: 'function',
                function: { name: action.name, arguments: JSON.stringify(action.args) },
              },
            ],
          }
        : { role: 'assistant', content: action.text };

    return res.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: action.kind === 'tool' ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
    });
  }

  /* ---------- streaming ---------- */
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  write(res, chunk(model, { role: 'assistant', content: '' }));

  const text = action.kind === 'tool' ? action.preamble : action.text;
  for (const word of text.split(' ')) {
    write(res, chunk(model, { content: word + ' ' }));
    await sleep(15);
  }

  if (action.kind === 'tool') {
    // Name first, with no arguments -- exactly how real gateways fragment this.
    write(
      res,
      chunk(model, {
        tool_calls: [
          { index: 0, id: 'call_mock_1', type: 'function', function: { name: action.name, arguments: '' } },
        ],
      }),
    );
    const json = JSON.stringify(action.args);
    for (let i = 0; i < json.length; i += 7) {
      write(
        res,
        chunk(model, {
          tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 7) } }],
        }),
      );
      await sleep(10);
    }
    write(res, chunk(model, {}, 'tool_calls'));
  } else {
    write(res, chunk(model, {}, 'stop'));
  }

  if (req.body.stream_options?.include_usage) {
    write(res, {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
    });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

/* ------------------------------------------------------------------ */
/* Anthropic-shaped surface                                            */
/*                                                                      */
/* Stands in for api.anthropic.com so the mid-conversation toggle can   */
/* be exercised without a real API key. It answers from the history it  */
/* is given, which is what makes continuity observable.                 */
/* ------------------------------------------------------------------ */

function aevent(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

/** Pull every piece of text out of an Anthropic message list. */
function historyText(messages) {
  const out = [];
  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push(m.content);
      continue;
    }
    for (const b of m.content || []) {
      if (b.type === 'text') out.push(b.text);
      if (b.type === 'tool_result') {
        out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    }
  }
  return out.join('\n');
}

app.post('/v1/messages', async (req, res) => {
  const { model = 'mock-direct', messages = [] } = req.body || {};
  const all = historyText(messages);

  // Answer from earlier turns so a reply proves the history arrived intact.
  const named = all.match(/\b([a-z][A-Za-z0-9_]*)\s*\(\)/);
  const text = named
    ? 'From this conversation so far, the function was ' + named[1] + '.'
    : 'I can see ' + messages.length + ' messages of history, but no function name in them.';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  aevent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mockdirect', type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 99, output_tokens: 0 },
    },
  });
  aevent(res, 'content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
  });
  for (const word of text.split(' ')) {
    aevent(res, 'content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: word + ' ' },
    });
    await sleep(10);
  }
  aevent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  aevent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 12 },
  });
  aevent(res, 'message_stop', { type: 'message_stop' });
  res.end();
});

app.listen(PORT, '127.0.0.1', () => {
  console.log('mock gateway on http://127.0.0.1:' + PORT + '/v1/chat/completions');
  console.log('  token: ' + REQUIRED_TOKEN + (REFUSE_STREAM ? '   (refusing streaming)' : ''));
});
