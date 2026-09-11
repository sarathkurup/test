'use strict';

/**
 * Protocol translation between the Anthropic Messages API (what Claude Code
 * speaks) and the OpenAI Chat Completions API (what most corporate gateways
 * speak).
 *
 * Three directions:
 *   toOpenAI()              Anthropic request -> OpenAI request
 *   streamToAnthropic()     OpenAI SSE        -> Anthropic SSE
 *   completionToAnthropic() OpenAI JSON       -> Anthropic SSE (fallback)
 */

const STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

// Anthropic block types we accept but deliberately do not forward.
const DROPPED_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/* ------------------------------------------------------------------ */
/* Request: Anthropic -> OpenAI                                        */
/* ------------------------------------------------------------------ */

function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

function imagePart(block) {
  const src = block.source || {};
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  if (src.data) {
    const media = src.media_type || 'image/png';
    return {
      type: 'image_url',
      image_url: { url: 'data:' + media + ';base64,' + src.data },
    };
  }
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text') return c.text ?? '';
      // An image inside a tool result cannot travel in an OpenAI tool message.
      if (c?.type === 'image') return '[image omitted]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function mapToolChoice(choice) {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return choice.name
        ? { type: 'function', function: { name: choice.name } }
        : 'required';
    default:
      return undefined;
  }
}

/**
 * @param {object} body  Anthropic Messages request
 * @param {object} opts  { mapModel, includeUsage }
 */
function toOpenAI(body, opts = {}) {
  const mapModel = opts.mapModel || ((m) => m);
  const messages = [];

  const system = flattenSystem(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      if (msg.content.length) messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of msg.content || []) {
      if (!block || DROPPED_BLOCKS.has(block.type)) continue;

      switch (block.type) {
        case 'text':
          if (block.text) parts.push({ type: 'text', text: block.text });
          break;

        case 'image': {
          const part = imagePart(block);
          if (part) parts.push(part);
          break;
        }

        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
          break;

        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultText(block.content) || '(no output)',
          });
          break;

        default:
          // document, server_tool_use, anything new: silently skipped.
          break;
      }
    }

    // OpenAI requires every tool message to follow the assistant turn that
    // requested it, before any new user content.
    messages.push(...toolResults);

    if (parts.length || toolCalls.length) {
      const out = { role: msg.role };
      if (parts.length) {
        out.content = parts.every((p) => p.type === 'text')
          ? parts.map((p) => p.text).join('\n')
          : parts;
      } else {
        out.content = null;
      }
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    }
  }

  const out = {
    model: mapModel(body.model),
    messages,
    stream: true,
  };

  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }

  if (body.tools?.length) {
    const fns = body.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));
    if (fns.length) out.tools = fns;
  }

  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined && out.tools) out.tool_choice = toolChoice;

  if (opts.includeUsage) out.stream_options = { include_usage: true };

  // Deliberately dropped: cache_control, metadata, thinking, top_k, container.
  return out;
}

/* ------------------------------------------------------------------ */
/* Response: OpenAI -> Anthropic SSE                                   */
/* ------------------------------------------------------------------ */

/** Returns false when the socket buffer is full, as res.write does. */
function sse(res, event, data) {
  return res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

/** Wait for the client to catch up rather than buffering without limit. */
function drain(res) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      res.off('drain', finish);
      res.off('close', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
  });
}

/**
 * Emits Anthropic SSE events in the order Claude Code expects, and guarantees
 * that every block it opens is closed exactly once, in order.
 */
class AnthropicSseWriter {
  constructor(res, model) {
    this.res = res;
    this.model = model;
    this.msgId = 'msg_' + Math.random().toString(36).slice(2, 14);
    this.nextIndex = 0;
    this.openIndex = null;
    this.started = false;
    this.stopped = false;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.needsDrain = false;
  }

  /** Record whether the last write filled the socket buffer. */
  note(ok) {
    if (ok === false) this.needsDrain = true;
    return ok;
  }

  /** Let the client catch up. Safe to call when nothing is pending. */
  async drain() {
    if (!this.needsDrain) return;
    this.needsDrain = false;
    await drain(this.res);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.note(sse(this.res, 'message_start', {
      type: 'message_start',
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.input_tokens, output_tokens: 0 },
      },
    }));
  }

  openBlock(contentBlock) {
    this.closeBlock();
    const index = this.nextIndex++;
    this.openIndex = index;
    this.note(sse(this.res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    }));
    return index;
  }

  delta(payload) {
    if (this.openIndex === null) return;
    this.note(sse(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.openIndex,
      delta: payload,
    }));
  }

  closeBlock() {
    if (this.openIndex === null) return;
    this.note(sse(this.res, 'content_block_stop', {
      type: 'content_block_stop',
      index: this.openIndex,
    }));
    this.openIndex = null;
  }

  finish(finishReason) {
    if (this.stopped) return;
    this.stopped = true;
    this.closeBlock();
    this.note(sse(this.res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: STOP_MAP[finishReason] ?? 'end_turn',
        stop_sequence: null,
      },
      usage: {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
      },
    }));
    this.note(sse(this.res, 'message_stop', { type: 'message_stop' }));
  }

  /** Report a mid-stream upstream failure without leaving the client hanging. */
  fail(message) {
    if (this.stopped) return;
    if (!this.started) return;
    this.closeBlock();
    this.note(sse(this.res, 'error', {
      type: 'error',
      error: { type: 'api_error', message },
    }));
    this.stopped = true;
    this.note(sse(this.res, 'message_stop', { type: 'message_stop' }));
  }
}

/** Assemble buffered OpenAI tool_call fragments into Anthropic tool_use blocks. */
function emitToolBlocks(writer, toolCalls) {
  const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [slot, call] of ordered) {
    if (!call.name) continue;
    writer.openBlock({
      type: 'tool_use',
      id: call.id || 'toolu_' + writer.msgId + '_' + slot,
      name: call.name,
      input: {},
    });
    // Claude Code concatenates partial_json, so one complete chunk is valid.
    writer.delta({ type: 'input_json_delta', partial_json: call.args || '{}' });
    writer.closeBlock();
  }
}

/**
 * Pump an OpenAI SSE stream into Anthropic SSE on `res`.
 *
 * Text streams through live. Tool calls are buffered and emitted as whole
 * blocks once the stream ends, because gateways are inconsistent about the
 * order and completeness of their tool_call fragments.
 */
async function streamToAnthropic(upstreamBody, res, model, hooks = {}) {
  const writer = new AnthropicSseWriter(res, model);
  writer.start();

  let textOpen = false;
  let finish = 'stop';
  let buffer = '';
  /** @type {Map<number, {id:string,name:string,args:string}>} */
  const toolCalls = new Map();

  const handleEvent = (payload) => {
    if (!payload || payload === '[DONE]') return;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    if (parsed.usage) {
      writer.usage.input_tokens =
        parsed.usage.prompt_tokens ?? writer.usage.input_tokens;
      writer.usage.output_tokens =
        parsed.usage.completion_tokens ?? writer.usage.output_tokens;
    }

    // Some gateways surface errors as an SSE frame rather than an HTTP status.
    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }

    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;

    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textOpen) {
        writer.openBlock({ type: 'text', text: '' });
        textOpen = true;
      }
      writer.delta({ type: 'text_delta', text: delta.content });
      hooks.onText?.(delta.content);
    }

    for (const tc of delta.tool_calls ?? []) {
      const slot = tc.index ?? 0;
      const entry = toolCalls.get(slot) || { id: '', name: '', args: '' };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      toolCalls.set(slot, entry);
    }
  };

  // undici yields Uint8Array, not Buffer, so decode explicitly. The streaming
  // decoder also keeps multi-byte characters intact across chunk boundaries.
  const decoder = new TextDecoder('utf-8');

  try {
    for await (const chunk of upstreamBody) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line.startsWith('data:')) continue;
        handleEvent(line.slice(5).trim());
      }
      // Let a slow client catch up instead of buffering the whole response.
      await writer.drain();
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) handleEvent(buffer.slice(5).trim());
  } catch (err) {
    const message = err.message || String(err);
    writer.fail(message);
    res.end();
    return { finish: 'error', toolCalls: 0, usage: writer.usage, error: message };
  }

  if (textOpen) writer.closeBlock();
  emitToolBlocks(writer, toolCalls);

  if (toolCalls.size && finish === 'stop') finish = 'tool_calls';
  writer.finish(finish);
  res.end();

  return { finish, toolCalls: toolCalls.size, usage: writer.usage };
}

/**
 * Non-streaming fallback: take a whole OpenAI completion and synthesise the
 * SSE event sequence. Used when the gateway rejects or strips streaming.
 */
function completionToAnthropic(completion, res, model) {
  const writer = new AnthropicSseWriter(res, model);
  const choice = completion.choices?.[0] || {};
  const message = choice.message || {};

  if (completion.usage) {
    writer.usage.input_tokens = completion.usage.prompt_tokens ?? 0;
    writer.usage.output_tokens = completion.usage.completion_tokens ?? 0;
  }

  writer.start();

  const text =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((c) => c?.text ?? '').join('')
        : '';

  if (text) {
    writer.openBlock({ type: 'text', text: '' });
    writer.delta({ type: 'text_delta', text });
    writer.closeBlock();
  }

  const toolCalls = new Map();
  (message.tool_calls ?? []).forEach((tc, i) => {
    toolCalls.set(i, {
      id: tc.id,
      name: tc.function?.name ?? '',
      args: tc.function?.arguments ?? '{}',
    });
  });
  emitToolBlocks(writer, toolCalls);

  let finish = choice.finish_reason || 'stop';
  if (toolCalls.size && finish === 'stop') finish = 'tool_calls';
  writer.finish(finish);
  res.end();

  return { finish, toolCalls: toolCalls.size, usage: writer.usage };
}

module.exports = {
  toOpenAI,
  streamToAnthropic,
  completionToAnthropic,
  AnthropicSseWriter,
  emitToolBlocks,
  sse,
  STOP_MAP,
  flattenSystem,
};
