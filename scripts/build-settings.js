'use strict';

/**
 * Regenerate the `contributes.configuration` block in package.json.
 *
 * Both corporate providers expose exactly the same options, so their settings
 * are generated from one shape rather than maintained twice. Run this after
 * changing what a provider can be configured with:
 *
 *   npm run settings
 */

const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'package.json');

/** The options every provider supports, in the order they should be shown. */
function providerProperties(id, d) {
  const p = (name) => `switchboard.${id}.${name}`;
  let order = 0;
  const next = () => ++order;

  return {
    [p('url')]: {
      type: 'string',
      default: '',
      order: next(),
      markdownDescription:
        `${d.label} address. A base URL is enough; the API path is appended. ` +
        'A full endpoint URL is also accepted.',
    },
    [p('authMode')]: {
      type: 'string',
      enum: ['pat', 'jwt', 'none'],
      enumDescriptions: [
        'Send the token straight through as the credential.',
        'Trade the token for a short-lived JWT first, then send that.',
        'Send no credential at all.',
      ],
      default: d.authMode,
      order: next(),
      markdownDescription:
        'How this platform expects to be authenticated. Choose `jwt` when it issues ' +
        'short-lived tokens from a refresh endpoint.',
    },
    [p('userEmail')]: {
      type: 'string',
      default: '',
      order: next(),
      description:
        'Identity this platform attributes usage to. Sent in the identity header below.',
    },
    [p('environment')]: {
      type: 'string',
      default: d.environment ?? '',
      order: next(),
      markdownDescription:
        'Which entry of the environment URLs below to use, for example `DEV`, `UAT` or `PRO`. ' +
        'Ignored when a refresh URL is set explicitly.',
    },
    [p('environmentUrls')]: {
      type: 'object',
      default: {},
      order: next(),
      additionalProperties: { type: 'string' },
      markdownDescription:
        'Token exchange base URL per environment, for example ' +
        '`{"DEV": "https://dev.example.com/api-access", "PRO": "https://example.com/api-access"}`. ' +
        'These are yours to supply; none are built in.',
    },
    [p('refreshUrl')]: {
      type: 'string',
      default: '',
      order: next(),
      markdownDescription:
        'Token exchange base URL, overriding the environment lookup. `/refresh` is appended.',
    },
    [p('apiShape')]: {
      type: 'string',
      enum: ['openai', 'anthropic'],
      default: d.apiShape,
      order: next(),
      markdownDescription:
        'Which API this platform speaks. `openai` translates in both directions; ' +
        '`anthropic` forwards with almost no translation.',
    },
    [p('modelMap')]: {
      type: 'object',
      default: {},
      order: next(),
      additionalProperties: { type: 'string' },
      markdownDescription:
        'Maps the model ids clients ask for onto the ids this platform serves. ' +
        'A key ending in `*` matches by prefix.',
    },
    [p('identityHeader')]: {
      type: 'string',
      default: d.identityHeader ?? '',
      order: next(),
      description:
        'Header carrying the user email. Leave empty if this platform does not want one.',
    },
    [p('tenantHeader')]: {
      type: 'string',
      default: d.tenantHeader ?? '',
      order: next(),
      description: 'Header carrying the tenant id. Leave empty if not required.',
    },
    [p('tenantId')]: {
      type: 'string',
      default: d.tenantId ?? '',
      order: next(),
      description: 'Value sent in the tenant header.',
    },
    [p('authHeader')]: {
      type: 'string',
      default: 'Authorization',
      order: next(),
      description: 'Header carrying the credential.',
    },
    [p('authPrefix')]: {
      type: 'string',
      default: 'Bearer ',
      order: next(),
      description: 'Text placed before the credential. Empty for a bare token.',
    },
    [p('pathTemplate')]: {
      type: 'string',
      default: d.pathTemplate ?? '',
      order: next(),
      markdownDescription:
        'Overrides the request path. `{model}` is substituted, which suits APIs that ' +
        'address a deployment by model id in the URL. Leave empty for the usual paths.',
    },
    [p('extraHeaders')]: {
      type: 'object',
      default: {},
      order: next(),
      additionalProperties: { type: 'string' },
      description: 'Additional static headers sent on every call to this platform.',
    },
    ...(d.region === undefined
      ? {}
      : {
          [p('region')]: {
            type: 'string',
            default: d.region,
            order: next(),
            description: 'Region, for platforms that need one.',
          },
        }),
  };
}

const configuration = [
  {
    title: 'Switchboard',
    properties: {
      'switchboard.activeProvider': {
        type: 'string',
        enum: ['genai', 'bedrock', 'direct'],
        enumDescriptions: [
          'The primary corporate platform.',
          'The second corporate platform.',
          'api.anthropic.com, for comparison.',
        ],
        default: 'genai',
        order: 1,
        description: 'Which upstream requests go to. The panel and status bar also switch this.',
      },
      'switchboard.listenHost': {
        type: 'string',
        default: '127.0.0.1',
        order: 2,
        markdownDescription:
          'Address the bridge listens on. Keep `127.0.0.1` unless you intend to expose it ' +
          'beyond this machine.',
      },
      'switchboard.listenPort': {
        type: 'number',
        default: 8787,
        order: 3,
        description:
          'Local port. Keep it stable: the value is written into your Claude Code settings. ' +
          'Change it if another proxy already uses this port.',
      },
      'switchboard.autoStart': {
        type: 'boolean',
        default: true,
        order: 4,
        description: 'Start the bridge when VS Code finishes loading.',
      },
    },
  },
  {
    title: 'Switchboard: GenAI platform',
    properties: providerProperties('genai', {
      label: 'The GenAI platform',
      authMode: 'jwt',
      apiShape: 'openai',
      environment: 'PRO',
      identityHeader: 'x-ndaq-user',
      tenantHeader: 'x-amz-tenant-id',
      tenantId: 'genai',
    }),
  },
  {
    title: 'Switchboard: AWS Bedrock',
    properties: providerProperties('bedrock', {
      label: 'Bedrock',
      authMode: 'pat',
      apiShape: 'anthropic',
      environment: '',
      identityHeader: '',
      tenantHeader: '',
      tenantId: '',
      pathTemplate: '',
      region: '',
    }),
  },
  {
    title: 'Switchboard: advanced',
    properties: {
      'switchboard.direct.url': {
        type: 'string',
        default: 'https://api.anthropic.com/v1/messages',
        description: 'Upstream used in direct mode.',
      },
      'switchboard.includeUsage': {
        type: 'boolean',
        default: true,
        description:
          'Ask the platform to report token counts. Turn off if it rejects the ' +
          'stream_options field.',
      },
      'switchboard.forceNonStreaming': {
        type: 'boolean',
        default: false,
        description:
          'Always request a whole response and synthesise the streaming events locally.',
      },
      'switchboard.verbose': {
        type: 'boolean',
        default: false,
        description: 'Log translated request bodies. Credentials are always redacted.',
      },
    },
  },
];

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
pkg.contributes.configuration = configuration;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

const count = configuration.reduce((n, s) => n + Object.keys(s.properties).length, 0);
console.log(`wrote ${count} settings across ${configuration.length} sections`);
