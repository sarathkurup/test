# Switchboard

**One local port. Any upstream. Same conversation.**

Point Claude Code and the editor's chat at your corporate AI platforms, and
switch between them mid-conversation without losing the session.

```
Claude Code CLI  ─┐                       ┌─→  GenAI platform
                  ├─→  Switchboard :8787 ─┼─→  AWS Bedrock
Editor chat      ─┘                       └─→  api.anthropic.com
```

Switchboard speaks the Anthropic Messages API to its clients and whatever each
platform speaks behind that, translating in both directions for the
OpenAI-shaped ones.

## Why the session survives the switch

Both APIs are stateless: the client sends the whole conversation on every
request. The client's base URL never changes, because it is always Switchboard.
Flipping the upstream between two turns means the next request carries the
entire history to the new platform. There is no session store to keep in sync
and nothing to reconnect.

## Nothing organisation-specific is built in

No URL, hostname, header name or identity is hardcoded. Every one is a setting,
and the defaults are empty. A test asserts this by scanning the source for
absolute URLs, so a shortcut cannot creep back in and end up in a screenshot.

## Getting started

```bash
npm install && npm test
```

Then double-click `install.cmd`, or:

```bash
npm run reinstall
```

Do not double-click the `.vsix`. On a machine with Visual Studio installed,
Windows hands `.vsix` files to Visual Studio's installer, which cannot install
VS Code extensions.

Restart VS Code, open the Switchboard panel from the activity bar, fill in a
platform's URL and token, then press Start.

## The three upstreams

| Id | What it is | Default shape |
|---|---|---|
| `genai` | The primary corporate platform | OpenAI |
| `bedrock` | A second corporate platform | Anthropic |
| `direct` | `api.anthropic.com`, for comparison | Anthropic |

Each corporate platform is configured entirely separately, under
`switchboard.genai.*` and `switchboard.bedrock.*`. They share no URL, token,
identity or model map. Both expose the same options, so a platform with
different conventions needs settings rather than code.

`genai` is the default, and the one requests go to until you switch.

## Per-platform settings

| Setting | Purpose |
|---|---|
| `url` | Base URL, or a full endpoint |
| `authMode` | `pat` to send the token, `jwt` to exchange it first, `none` for no credential |
| `userEmail` | Identity value, sent in the identity header |
| `environment` | Which entry of the environment URLs to use |
| `environmentUrls` | Token exchange base URL per environment; yours to supply |
| `refreshUrl` | Overrides the environment lookup |
| `apiShape` | `openai` to translate, `anthropic` to pass through |
| `modelMap` | Client model id to platform model id; trailing `*` matches by prefix |
| `identityHeader` | Header carrying the email; empty to send none |
| `tenantHeader` / `tenantId` | Header and value for tenancy |
| `authHeader` / `authPrefix` | How the credential is presented |
| `pathTemplate` | Overrides the path; `{model}` is substituted |
| `extraHeaders` | Static extras sent on every call |

Shared settings are `switchboard.activeProvider`, `listenHost`, `listenPort`
and `autoStart`.

## Authentication

**`pat`** sends your token straight through as the credential.

**`jwt`** trades it for a short-lived one first:

```
POST {refreshUrl}/refresh
     <tenantHeader>: <tenantId>
     <identityHeader>: <userEmail>
     { "token": "<PAT>" }
  -> { "token": "<JWT>" }
```

The JWT then becomes the credential. Switchboard reads its `exp` claim so it
renews on the issuer's schedule rather than a guessed interval, never treats a
freshly issued token as stale even when its lifetime is shorter than the
renewal margin, collapses concurrent callers onto a single exchange, and renews
and retries once if the platform rejects a token it believed was good.

Each platform keeps its own token in the OS keychain through VS Code
SecretStorage. Tokens reach the bridge only as environment variables at spawn
time, are never written to `settings.json`, and both the personal access token
and the exchanged JWT are redacted from every log line.

## Running without VS Code

The bridge is a plain Node process, spawned detached, so it keeps serving the
terminal after VS Code closes. It also runs alone:

```bash
GENAI_URL=https://api.example.com/openai GENAI_AUTH_MODE=jwt GENAI_PAT=xxx GENAI_EMAIL=you@company.com GENAI_REFRESH_URL=https://api.example.com/api-access node bridge/standalone.js
```

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=bridge claude
```

Every setting has a matching variable: `GENAI_*` and `BEDROCK_*` for the two
platforms, `DIRECT_URL` and `DIRECT_API_KEY` for Anthropic.

## Trying it without a real platform

The bundled mock serves three surfaces: a plain OpenAI one, an Anthropic one,
and a gateway-shaped one that refuses a token until it is exchanged for a JWT.

```bash
node mock/upstream.js
```

```bash
GENAI_URL=http://127.0.0.1:9099/openai GENAI_AUTH_MODE=jwt GENAI_PAT=test-pat GENAI_EMAIL=you@example.com GENAI_IDENTITY_HEADER=x-ndaq-user GENAI_TENANT_HEADER=x-amz-tenant-id GENAI_TENANT_ID=genai GENAI_REFRESH_URL=http://127.0.0.1:9099/api-access node bridge/standalone.js
```

`MOCK_JWT_SECONDS` shortens the token lifetime to exercise renewal, and
`MOCK_REFUSE_STREAM=1` makes the gateway reject streaming so the non-streaming
fallback runs.

## Connecting the editor's chat

As of 1.136 Copilot is bundled into VS Code rather than installed separately,
and custom models are registered through the `languageModelChatProviders`
contribution point. The provider to use is **Custom Endpoint**. Two older
routes are dead ends: `github.copilot.chat.customOAIModels` is deprecated, and
the `customoai` vendor that replaced it is deprecated and gated to non-stable
builds.

Open chat, click the model name, choose **Manage Models**, then **Custom
Endpoint**:

| Field | Value |
|---|---|
| URL | `http://127.0.0.1:8787/v1/messages` |
| API type | Messages |
| API key | any non-empty value; Switchboard supplies the real one |
| Model id | whatever you mapped in that platform's model map |

Use the Messages route rather than `/v1/chat/completions`. Both work against an
OpenAI-shaped platform, but only `/v1/messages` serves every upstream, so
choosing it keeps the switch working for editor chat as well as the CLI.

VS Code holds this provider configuration internally rather than in
`settings.json`, so the extension cannot write it for you.

## Endpoints

| Route | Serves |
|---|---|
| `POST /v1/messages` | Claude Code and any Messages client; every upstream |
| `POST /v1/messages/count_tokens` | Claude Code startup |
| `POST /v1/chat/completions` | OpenAI clients; OpenAI-shaped upstreams only |
| `GET /v1/models` | Model discovery |
| `POST /__control/select` | Choose an upstream, or step to the next |
| `POST /__control/refresh` | Exchange a token without sending a prompt |
| `POST /__control/test` | One-shot upstream probe |
| `GET /__control/upstream-models` | What a platform actually serves |
| `GET /health` | Status, with no credentials in the response |

## What the translation drops

`cache_control`, `metadata`, `thinking` blocks and `top_k` are removed on the
way out, because platforms reject fields they do not recognise. Images inside a
tool result become a placeholder, since an OpenAI tool message carries text
only.

## Production details worth knowing

Server timeouts are disabled, because a long agentic turn outlasts Node's
defaults and would otherwise be severed mid-stream. Nagle's algorithm is turned
off so streamed tokens reach the client as they arrive. Every relay honours
backpressure rather than buffering a slow client's response in memory. Upstream
response headers are never copied, since the body has already been decompressed
and forwarding `content-encoding` would tell the client to gunzip plaintext.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Agent loops re-reading one file | `tool_result` is not arriving upstream as `role: tool` |
| "Invalid tool input" | Argument fragments concatenated wrongly |
| Response hangs | A `content_block_stop` or `message_stop` never arrived |
| Errors before any prompt | `count_tokens` is not answering |
| Every request re-exchanges a token | The renewal margin exceeds the token lifetime |
| Port already in use | Another proxy holds it; change `switchboard.listenPort` |

Run `npm test` first. The suite covers the translation, the credential
exchange, redaction, configuration, and the Claude Code settings merge.
