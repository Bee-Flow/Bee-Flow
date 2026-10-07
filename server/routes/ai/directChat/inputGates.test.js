/**
 * Direct chat input gates: what reaches the logs and what reaches the model.
 *
 *   - The PII gate never logs a slice of the message, a token's real value or
 *     a blocked entity's text: in production those lines go to the log sink
 *     with a request id, which is exactly where the shield promises the
 *     originals never land.
 *   - A regex 'redact' rule redacts the text the model will receive. When the
 *     PII gate has already tokenised the last message, the redaction must not
 *     write the raw message (with the real values) back over the tokens.
 *
 * The real guardrailsRunner, unicode sanitizer, phase events and logger run;
 * the shield, the detector and the stores are stubbed. Synthetic data.
 *
 * Run: cd server && node --test routes/ai/directChat/inputGates.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const NAME = 'Johannes Vermeulen';
const EMAIL = 'johannes.vermeulen@example.org';
const MESSAGE = `Stuur ${NAME} een mail via ${EMAIL} over CASE-4821 vandaag`;
const TOKENISED = 'Stuur [person_1] een mail via [email_1] over CASE-4821 vandaag';
const ENTITIES = [
    { text: NAME, label: 'Person', category: 'Person' },
    { text: EMAIL, label: 'Email', category: 'Email' },
];

const fx = { shield: null, validate: null };

const guardrailEventStore = { logGuardrailEvent: async () => {} };
const orgShield = {
    resolveShieldFor: async () => fx.shield,
    mergeWithOrgShield: (a, b) => a || b,
};
const piiDetection = {
    validateInputForPii: (...args) => fx.validate(...args),
    windowCountFor: () => 1,
};
const dlpRunner = {
    getConversationTokenMapAsync: async () => ({}),
    getConversationTokenMap: () => ({}),
    mergeTokenMap: () => {},
};

const restore = installResolveStub({
    '../../../stores/configStore': { getConfig: async () => null, getAllConfig: async () => ({}) },
    '../../../core/aiAgent': { getAIConfig: async () => ({}) },
    '../../../stores/guardrailEventStore': guardrailEventStore,
    '../../stores/guardrailEventStore': guardrailEventStore,
    '../../../core/dlp/tokenPreservationPrompt': { buildTokenPreservationAddendum: () => '' },
    '../../../services/orgHealth': { problem: () => {} },
    '../../../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../../../core/privacy/orgShield': orgShield,
    '../privacy/orgShield': orgShield,
    '../../../core/privacy/piiDetection': piiDetection,
    '../privacy/piiDetection': piiDetection,
    '../../../core/dlp/dlpRunner': dlpRunner,
    '../dlp/dlpRunner': dlpRunner,
});

const { runInputGates } = require('./inputGates');
test.after(restore);

/** Run one turn with console captured. Returns the captured lines and messages. */
async function turn() {
    const lines = [];
    const saved = {};
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
        saved[m] = console[m];
        console[m] = (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    }
    const messages = [
        { role: 'system', content: 'stable' },
        { role: 'system', content: 'volatile' },
        { role: 'user', content: MESSAGE },
    ];
    const events = [];
    try {
        await runInputGates({
            req: { session: { user: { id: 'u1', organizationId: 'org1' } } },
            res: { end: () => {} },
            send: (type, data) => events.push({ type, data }),
            userId: 'u1',
            convId: 'conv-1',
            message: MESSAGE,
            messages,
            modelId: 'model-1',
            config: { providerType: 'test' },
        });
    } finally {
        for (const m of Object.keys(saved)) console[m] = saved[m];
    }
    return { lines, messages, events };
}

/** Every 8-character window of the message, plus each token value and entity text. */
function secrets() {
    const out = new Set([NAME, EMAIL]);
    for (let i = 0; i + 8 <= MESSAGE.length; i++) {
        const w = MESSAGE.slice(i, i + 8);
        // Windows that sit wholly inside the tokenised text are not secret.
        if (!TOKENISED.includes(w)) out.add(w);
    }
    return [...out];
}

function assertNoSecretLogged(lines) {
    for (const line of lines) {
        for (const s of secrets()) {
            assert.ok(!line.includes(s), `a log line carries user content (${JSON.stringify(s)}): ${line}`);
        }
    }
}

const TOKENISE_SHIELD = { enabled: true, piiDetectionAction: 'tokenize', rulesWithNames: [], scope: {} };

test('a tokenised turn logs no message text and no token value', async () => {
    fx.shield = TOKENISE_SHIELD;
    fx.validate = async () => ({
        tokenizedText: TOKENISED,
        tokenMap: { '[person_1]': NAME, '[email_1]': EMAIL },
        entities: ENTITIES,
    });
    const { lines, messages } = await turn();
    assert.strictEqual(messages[2].content, TOKENISED);
    assert.ok(lines.some(l => l.includes('PII tokenized (2 tokens)')), 'the tokenise line still says how many');
    assertNoSecretLogged(lines);
});

test('a blocked turn logs no message text and no entity text', async () => {
    fx.shield = { ...TOKENISE_SHIELD, piiDetectionAction: 'block' };
    fx.validate = async () => {
        const err = new Error('PII detected (Person, Email)');
        err.piiEntities = ENTITIES;
        throw err;
    };
    const { lines, events } = await turn();
    assert.ok(events.some(e => e.type === 'guardrail_violation'), 'the turn is still blocked');
    assert.ok(lines.some(l => l.includes('PII blocked') && l.includes('2 entities')), 'the block line still says how many');
    assertNoSecretLogged(lines);
});

test('a regex redaction keeps the tokens the PII gate put in', async () => {
    fx.shield = {
        enabled: true,
        piiDetectionAction: 'tokenize',
        rulesWithNames: [{ name: 'case-ref', pattern: 'CASE-\\d{4}' }],
        scope: { userInput: true, agentOutput: true },
        action: 'redact',
    };
    fx.validate = async () => ({
        tokenizedText: TOKENISED,
        tokenMap: { '[person_1]': NAME, '[email_1]': EMAIL },
        entities: ENTITIES,
    });
    const { messages } = await turn();
    const sent = messages[2].content;
    assert.ok(sent.includes('[REDACTED: case-ref]'), sent);
    assert.ok(!sent.includes(NAME), `the real name went back into the prompt: ${sent}`);
    assert.ok(!sent.includes(EMAIL), `the real address went back into the prompt: ${sent}`);
    assert.ok(sent.includes('[person_1]'), sent);
});
