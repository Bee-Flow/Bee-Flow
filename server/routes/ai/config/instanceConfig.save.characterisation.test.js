// @typecheck
'use strict';

/**
 * Characterisation (golden) test for POST /ai/config: the real router behind
 * the real platform-admin gate, the real config store and saveAIConfig on a
 * PGlite with the whole schema. Per request the golden holds the status, the
 * answer and every write the config store received, in order and in clear
 * text (the store's setConfig / setSecret record and then run; of the large
 * `ai` record what the save changed in it), plus the
 * Stripe Tax backfill and the re-embedding that a save starts.
 *
 * The requests run in order on one database, so a later request sees what an
 * earlier one saved (the Stripe Tax switch going off and on, the embedding
 * model changing and staying). They cover each setting on its own (a value,
 * an empty value, null), each on/off switch, every setting with its own
 * check, the refusals and what was already written when one refuses, all
 * settings in one request, and who may call.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --require ./testUtils/registerFeatures.js --test routes/ai/config/instanceConfig.save.characterisation.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../../../testUtils/routeHarness');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { createPlatformAdminGate } = require('../../../auth/requirePlatformAdmin');
const kit = require('../platformAdmin.testkit');

const GOLDEN = path.join(__dirname, 'instanceConfig.save.characterisation.golden.json');

const gate = createPlatformAdminGate({ isSuperAdmin: (req) => /** @type {any} */ (req).session?.user?.role === 'admin' });
const { api } = h.routeUnderTest(test, '/ai', () => require('./instanceConfig'), {
    pg: ladderPglite(),
    gates: { hasPlatformAdminAccess: gate.hasPlatformAdminAccess, requirePlatformAdmin: gate.requirePlatformAdmin },
});

/** @type {unknown[][]} */
let effects = [];
const configStore = require('../../../stores/configStore');
const stripeService = require('../../../services/stripeService');
const embeddingMigration = require('../../../core/kb/embeddingMigration');
const swaps = require('../../../testUtils/swaps').makeSwaps();
/**
 * The leaves of `now` that differ from `before`, as [path, value] pairs: the
 * `ai` record is large and written by every save, so the golden holds what
 * each save changed in it.
 * @param {any} before @param {any} now @param {string} at @param {Array<[string, unknown]>} out
 */
function changedLeaves(before, now, at = '', out = []) {
    const nested = (/** @type {unknown} */ v) => v !== null && typeof v === 'object';
    if (!nested(before) || !nested(now) || Array.isArray(before) !== Array.isArray(now)) {
        if (JSON.stringify(before) !== JSON.stringify(now)) out.push([at, now === undefined ? '<gone>' : now]);
        return out;
    }
    for (const key of new Set([...Object.keys(before), ...Object.keys(now)])) changedLeaves(before[key], now[key], at ? `${at}.${key}` : key, out);
    return out;
}
/** @type {unknown} */
let lastAi = {};
for (const name of /** @type {const} */ (['setConfig', 'setSecret', 'deleteConfig'])) {
    const real = configStore[name];
    swaps.swap(configStore, name, async (/** @type {any[]} */ ...args) => {
        if (name === 'setConfig' && args[0] === 'ai') {
            const now = JSON.parse(JSON.stringify(args[1]));
            effects.push([name, 'ai', { changed: changedLeaves(lastAi, now) }]);
            lastAi = now;
        } else {
            effects.push([name, ...args]);
        }
        return real.apply(configStore, args);
    });
}
swaps.swap(stripeService, 'enableAutomaticTaxForExistingSubscriptions', async () => { effects.push(['stripe tax backfill']); return { updated: 2, skipped: 1 }; });
swaps.swap(embeddingMigration, 'ensureKbEmbeddingsCurrent', (/** @type {unknown} */ o) => { effects.push(['re-embed', o]); });
test.after(() => swaps.restore());

const TEXT_SETTINGS = [
    'url', 'model', 'apiKey', 'mistralApiKey', 'openaiApiKey', 'claudeApiKey', 'googleApiKey', 'eugptApiKey', 'ionosApiKey',
    'elevenlabsApiKey', 'googleVertexProject', 'googleVertexLocation', 'googleVertexServiceAccountKey', 'azureEndpoint',
    'azureApiKey', 'azureApiVersion', 'agentSearchUrl', 'lakeraApiKey', 'embeddingModel', 'embeddingProviderId',
    'googleMapsApiKey', 'serperApiKey', 'azureDocIntelligenceEndpoint', 'azureDocIntelligenceKey',
    'azureOpenaiEmbeddingEndpoint', 'azureOpenaiEmbeddingKey', 'azureOpenaiEmbeddingModel', 'serviceEmailDisplayName',
    'azureSpeechKey', 'azureSpeechRegion', 'transcriptionProvider', 'azureRerankerEndpoint', 'azureRerankerKey',
    'azureRerankerModel', 'rerankProviderId', 'rerankModel', 'stripeSecretKey', 'stripeWebhookSecret',
    'stripePublishableKey', 'stripeTaxCountry', 'subscriptionNotifyEmail', 'searchProvider', 'kbProvider', 'bingSearchKey',
    'bingSearchMarket', ...['linkedin', 'withings'].flatMap((app) => [`${app}ClientId`, `${app}ClientSecret`]),
    'whisperxUrl', 'whisperxToken', 'scalewayApiKey', 'scalewayModel', 'scalewayUrl', 'pyannoteApiKey',
    'pyannoteTranscriptionModel', 'piiDetectionAction',
];
const FLAGS = [
    'useAzureDocProcessing', 'notebooksEnabled', 'projectsEnabled', 'askAiEnabled', 'exportEnabled', 'openInNotebookEnabled',
    'notebooksMenuEnabled', 'stripeEnabled', 'stripeTaxEnabled', 'cpuRerankerEnabled', 'voiceprintMatchingEnabled',
    'localWhisperEnabled', 'piiDetectionEnabled',
];
/** A value each text setting accepts, so the request reaches the save. */
const VALID_TEXT = {
    azureSpeechRegion: 'westeurope', transcriptionProvider: 'azure', searchProvider: 'bing', kbProvider: 'local',
    whisperxUrl: 'https://whisperx.example/api', scalewayUrl: 'http://scaleway.example', piiDetectionAction: 'warn',
    pyannoteTranscriptionModel: require('../../../core/voice/pyannoteModels').TRANSCRIPTION_MODELS[0],
};

/** Settings with a check or a normalisation of their own. @type {Record<string, unknown[]>} */
const VARIANTS = {
    searchProvider: ['agent-search', 'node-search', 'disabled', 'serper'],
    maxToolRoundsChat: [null, '', false, '7', 7, 0, -3, 999, 'abc', 12.7, true, '15 rounds'],
    kbProvider: ['remote', 'elsewhere'],
    azureSpeechRegion: ['  WestEurope  ', 'bad region!', 'x', 'a'.repeat(33), 'east-us-2'],
    whisperxUrl: ['  http://whisperx.internal:9000  ', 'ftp://whisperx.example', 'not a url', 'javascript:alert(1)'],
    scalewayUrl: ['  https://api.scaleway.example/v1  ', 'ftp://scaleway.example', 'scaleway'],
    scalewayModel: ['  whisper-large-v3  '],
    pyannoteTranscriptionModel: [`  ${require('../../../core/voice/pyannoteModels').TRANSCRIPTION_MODELS[1]}  `, 'whisper-tiny'],
    pyannoteIdentifyThreshold: [50, 49.6, 0, 100, -1, 101, 'abc', '75', null, true, [60]],
    transcriptionProvider: ['voxtral', 'whisperx', 'scaleway', 'whisper_azure', 'pyannote', 'local', 'somewhere'],
    piiDetectionAction: ['block', 'tokenize', 'allow', 'BLOCK'],
    stripeTaxEnabled: [true, true, false, 'true', 'false', true],
    subscriptionNotifyEmail: ['  billing@example.test  '],
    azureModels: ['gpt-4o@swedencentral', '', null, ['gpt-4o'], { a: 1 }, 0],
    azureImageModels: [[{ deployment: ' img-1 ', model: 'gpt-image-1', pricePerImage: 0.04 }, { deployment: 'img-2' }], [], [{ deployment: '' }], 'img-1'],
    allowedModelsByAgentType: [{ chat: ['m1', 'm2'] }, null, 'm1'],
    directChatRegexGuardrails: [{ ruleIds: ['r1'] }, null],
    regexGuardrails: [{ rules: [{ id: 'r1', name: 'IBAN', pattern: 'NL\\d{2}' }], collections: [] }, null],
    piiDetectionCategories: [['email', 'phone'], null],
    piiDetectionConfidenceThreshold: [0.5, null, 'high'],
    piiDetectionScope: [{ userInput: true, agentOutput: true }, null],
    embeddingModel: ['embed-a', 'embed-a', 'embed-b'],
    embeddingProviderId: ['p-embed', 'p-embed'],
};

/** @type {Array<{ name: string, body?: unknown, user?: Record<string, unknown> | null }>} */
const REQUESTS = [{ name: 'nothing sent', body: {} }];
for (const key of TEXT_SETTINGS) {
    REQUESTS.push({ name: `${key}: a value`, body: { [key]: VALID_TEXT[key] || `value of ${key}` } });
    REQUESTS.push({ name: `${key}: empty`, body: { [key]: '' } });
    REQUESTS.push({ name: `${key}: null`, body: { [key]: null } });
}
for (const key of FLAGS) {
    for (const value of [true, false, 'true', 'false', null, 'yes']) REQUESTS.push({ name: `${key}: ${JSON.stringify(value)}`, body: { [key]: value } });
}
for (const [key, values] of Object.entries(VARIANTS)) {
    values.forEach((value, i) => REQUESTS.push({ name: `${key} #${i}: ${JSON.stringify(value)}`, body: { [key]: value } }));
}
const everything = Object.fromEntries([
    ...TEXT_SETTINGS.map((key) => [key, VALID_TEXT[key] || `all ${key}`]),
    ...FLAGS.map((key) => [key, true]),
    ['azureModels', 'gpt-4o'], ['azureImageModels', [{ deployment: 'img' }]], ['regexGuardrails', null], ['piiDetectionCategories', ['email']],
    ['piiDetectionConfidenceThreshold', 0.9], ['piiDetectionScope', { userInput: true, agentOutput: false }],
    ['allowedModelsByAgentType', { chat: ['m'] }], ['directChatRegexGuardrails', null], ['maxToolRoundsChat', 20], ['pyannoteIdentifyThreshold', 66],
]);
REQUESTS.push(
    { name: 'every setting at once', body: everything },
    { name: 'every setting at once, switches off', body: { ...everything, ...Object.fromEntries(FLAGS.map((key) => [key, false])) } },
    // A refusal part-way: what is written before it stays written, the rest is not.
    { name: 'refused at the speech region', body: { ...everything, azureSpeechRegion: 'not a region' } },
    { name: 'refused at the WhisperX address', body: { ...everything, whisperxUrl: 'whisperx' } },
    { name: 'refused at the Scaleway address', body: { ...everything, scalewayUrl: 'scaleway' } },
    { name: 'refused at the pyannote model', body: { ...everything, pyannoteTranscriptionModel: 'unknown-model' } },
    { name: 'refused at the identify threshold', body: { ...everything, pyannoteIdentifyThreshold: 500 } },
    { name: 'refused at the transcription provider', body: { ...everything, transcriptionProvider: 'nowhere' } },
    { name: 'refused at the PII action, before any write', body: { ...everything, piiDetectionAction: 'allow' } },
    { name: 'two refusals: the first one answers', body: { serperApiKey: 'k', azureSpeechRegion: '!!', transcriptionProvider: 'nowhere' } },
    { name: 'a key the route does not know', body: { stripeSecretKey: 'sk', notAKey: true } },
    { name: 'a number where text goes', body: { serperApiKey: 12 } },
    { name: 'no body', body: undefined },
    { name: 'an organisation admin', body: { stripeSecretKey: 'sk_from_org_admin' }, user: kit.ORG_ADMIN },
    { name: 'a member', body: { stripeSecretKey: 'sk_from_member' }, user: kit.MEMBER },
    { name: 'nobody signed in', body: { stripeSecretKey: 'sk_from_nobody' }, user: null },
);

test('POST /ai/config: answer and writes per request (golden)', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const { name, body, user } of REQUESTS) {
        effects = [];
        const res = await api.call('POST', '/ai/config', { body, user: user === undefined ? kit.PLATFORM_ADMIN : user });
        // The backfill and its log line run after the answer.
        await new Promise((resolve) => setImmediate(resolve));
        const answer = res.body && typeof res.body === 'object' ? { ...res.body } : res.text;
        if (answer && typeof answer === 'object' && 'correlationId' in answer) answer.correlationId = '<id>';
        assert.equal(name in actual, false, `two requests named ${name}`);
        actual[name] = { status: res.status, answer, effects: JSON.parse(JSON.stringify(effects)) };
    }
    // One request per line.
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `{\n${Object.entries(actual).map(([name, seen]) => `${JSON.stringify(name)}: ${JSON.stringify(seen)}`).join(',\n')}\n}\n`);
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
