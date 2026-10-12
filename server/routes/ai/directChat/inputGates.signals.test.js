/**
 * Direct chat → chat signals, through the real input gates.
 *
 * streamTurn.js hands runInputGates an accumulator (`chatSignal`) and calls
 * countDirectTurn right after the gates resolve (that wiring is pinned in
 * ../directChat.scope.test.js). This file drives the REAL gates through every
 * exit and checks what reaches the recorder:
 *
 *   exit                         outcome
 *   protection unavailable       scan_failed_closed
 *   PII block                    blocked (+ the category ids)
 *   DLP block                    blocked (+ the DLP's category ids)
 *   regex block                  the Shield's PII decision (here: clean)
 *   normal return, masked        protected
 *   shield off                   unscanned
 *
 * Each exit is counted exactly once. The PII gate gets the accumulator's own
 * report object and only the last three messages, the DLP decision is copied
 * without its tokens, and the allowlisted hosts come from the shield.
 *
 * The gates' collaborators are swapped on their module objects before the
 * gates load (testUtils/swaps); the recorder's countTurn is a spy.
 *
 * Run: cd server && node --test routes/ai/directChat/inputGates.signals.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../../testUtils/swaps');

const aiAgent = require('../../../core/aiAgent');
const configStore = require('../../../stores/configStore');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const orgHealth = require('../../../services/orgHealth');
const auth = require('../../../auth');
const orgShield = require('../../../core/privacy/orgShield');
const piiDetection = require('../../../core/privacy/piiDetection');
const dlpPreflight = require('../../../core/dlp/dlpPreflight');
const dlpRunner = require('../../../core/dlp/dlpRunner');
const modelResolver = require('../../../core/llm/modelResolver');
const chatSignals = require('../../../core/privacy/chatSignals');

const fx = { shield: null, regex: null, validate: null, dlp: null, piiCalls: [], counted: [] };
const { swap, restore } = makeSwaps();
// The gates take getAIConfig when they load: swap before requiring them.
swap(aiAgent, 'getAIConfig', async () => ({ piiDetectionEnabled: false }));
swap(configStore, 'getConfig', async () => null);
swap(configStore, 'getAllConfig', async () => ({}));
swap(guardrailEventStore, 'logGuardrailEvent', async () => {});
swap(orgHealth, 'problem', () => {});
swap(auth, 'resolveUserOrgIds', async () => new Set(['org-1']));
swap(orgShield, 'resolveShieldFor', async () => fx.shield);
swap(orgShield, 'mergeWithOrgShield', () => fx.regex || { enabled: false });
swap(piiDetection, 'validateInputForPii', async (...args) => { fx.piiCalls.push(args); return fx.validate(...args); });
swap(dlpPreflight, 'runDlpPreflight', async () => fx.dlp);
swap(dlpRunner, 'mergeTokenMap', () => {});
swap(dlpRunner, 'getConversationTokenMap', () => ({}));
swap(dlpRunner, 'getConversationTokenMapAsync', async () => ({}));
swap(modelResolver, 'resolveEffectiveOrgId', async () => 'org-1');
swap(chatSignals, 'countTurn', (args) => { fx.counted.push(args); return undefined; });
const { runInputGates } = require('./inputGates');
const { countDirectTurn } = require('./chatSignalsTurn');
after(restore);

const MARK = 'direct@2026-10-14T09:00:00.000Z';
const CONFIG = { providerType: 'openai', url: 'https://api.openai.com/v1', providerName: 'OpenAI' };
const settle = () => new Promise((r) => setImmediate(r));

/** What a PII gate that found an e-mail address says, as validate.js says it. */
const piiFound = (decision) => (messages, enabled, shield, a, b, options) => {
    options.report.status = 'found';
    options.report.decision = decision;
    options.report.categories = ['EmailAddress'];
    if (decision === 'blocked') {
        throw Object.assign(new Error('PII Detected: Message contains sensitive personal information (Email).'), {
            piiEntities: [{ label: 'Email', category: 'EmailAddress', text: 'ada@example.org' }],
        });
    }
    return { tokenizedText: 'mail [email_1]', tokenMap: { '[email_1]': 'ada@example.org' }, entities: [{ label: 'Email', category: 'EmailAddress' }] };
};

/** One turn, exactly as streamTurn.js runs it: the gates, then the count. */
async function turn(message = 'mail ada@example.org') {
    const chatSignal = { pii: {}, dlp: null, allowlistedHosts: [] };
    const req = { body: { message, chatSignalsNotice: MARK }, session: { user: { id: 'u-1', organizationId: 'org-1' } } };
    const sent = [];
    const res = { ended: 0, end() { this.ended++; } };
    const messages = [
        { role: 'system', content: 'STABLE' },
        { role: 'user', content: 'an earlier question from a colleague: bob@example.org' },
        { role: 'assistant', content: 'an answer' },
        { role: 'system', content: 'VOLATILE' },
        { role: 'user', content: message },
    ];
    const result = await runInputGates({
        req, res, send: (event) => sent.push(event), userId: 'u-1', convId: null, message, messages,
        modelId: 'gpt-x', config: CONFIG, chatSignal,
    });
    countDirectTurn({ req, userId: 'u-1', chatSignal, config: CONFIG });
    await settle();
    return { result, chatSignal, sent, res };
}

beforeEach(() => {
    fx.shield = { enabled: true, piiDetectionAction: 'tokenize', dlpEnabled: false, dlpAllowlistedHosts: ['llm.internal.example'] };
    fx.regex = null;
    fx.validate = (messages, enabled, shield, a, b, options) => { if (options.report) options.report.status = 'clean'; return null; };
    fx.dlp = null;
    fx.piiCalls = [];
    fx.counted = [];
});

test('protection unavailable: the stream ends and the turn counts scan_failed_closed, once', async () => {
    fx.validate = (messages, enabled, shield, a, b, options) => {
        options.report.status = 'failed_closed';
        throw Object.assign(new Error('Privacy protection unavailable'), { privacyUnavailable: true, privacyUnavailableKind: 'unavailable' });
    };
    const t = await turn();
    assert.equal(t.result, undefined);
    assert.ok(t.sent.includes('dlp_blocked'));
    assert.equal(fx.counted.length, 1);
    assert.equal(fx.counted[0].outcome, 'scan_failed_closed');
});

test('a PII block: blocked, with the category ids', async () => {
    fx.shield.piiDetectionAction = 'block';
    fx.validate = piiFound('blocked');
    const t = await turn();
    assert.equal(t.result, undefined);
    assert.equal(fx.counted.length, 1);
    assert.deepEqual([fx.counted[0].outcome, fx.counted[0].categories], ['blocked', ['EmailAddress']]);
});

test('a DLP block: blocked, from the DLP decision, which is copied without its tokens', async () => {
    fx.shield.dlpEnabled = true;
    fx.dlp = { outcome: 'blocked', blocked: true, reason: 'policy_block', scanStatus: 'ok', categories: ['IBAN'], tooShort: false, tokenMap: { '[iban_1]': 'NL00BANK0123456789' } };
    const t = await turn();
    assert.equal(t.result, undefined);
    assert.equal(fx.piiCalls.length, 0, 'the PII gate deferred to DLP');
    assert.deepEqual(t.chatSignal.dlp, { outcome: 'blocked', scanStatus: 'ok', categories: ['IBAN'], override: false, tooShort: false });
    assert.equal(fx.counted.length, 1);
    assert.deepEqual([fx.counted[0].outcome, fx.counted[0].categories], ['blocked', ['IBAN']]);
});

test('a regex block: the outcome is still the Shield\'s PII decision', async () => {
    fx.regex = { enabled: true, scope: { userInput: true }, action: 'block', rulesWithNames: [{ name: 'six digits', pattern: '\\d{6}' }] };
    const t = await turn('my code is 123456');
    assert.equal(t.result, undefined);
    assert.ok(t.res.ended >= 1, 'the regex block ended the stream');
    assert.equal(fx.counted.length, 1);
    assert.equal(fx.counted[0].outcome, 'clean');
});

test('a normal return with masking: protected, once, with the shield\'s allowlisted hosts', async () => {
    fx.validate = piiFound('tokenised');
    const t = await turn();
    assert.ok(t.result, 'the gates handed the turn on');
    assert.equal(fx.counted.length, 1);
    const c = fx.counted[0];
    assert.deepEqual([c.outcome, c.categories, c.orgKey, c.surface, c.notice], ['protected', ['EmailAddress'], 'org-1', 'direct', MARK]);
    assert.deepEqual(c.allowlistedHosts, ['llm.internal.example']);
    assert.deepEqual(c.providerConfig, { providerType: 'openai', url: 'https://api.openai.com/v1' });
});

test('the shield off: unscanned', async () => {
    fx.shield = null;
    fx.validate = (messages, enabled, shield, a, b, options) => { options.report.status = 'disabled'; return null; };
    await turn();
    assert.equal(fx.counted.length, 1);
    assert.equal(fx.counted[0].outcome, 'unscanned');
});

test('the PII gate writes into the accumulator itself, and reads only the tail of the thread', async () => {
    const t = await turn();
    const [messages, , , , , options] = fx.piiCalls[0];
    assert.equal(options.report, t.chatSignal.pii, 'the same object, so the decision reaches the count');
    assert.equal(messages.length, 3, 'the last three messages, as before');
    assert.equal(messages[messages.length - 1].role, 'user');
    assert.ok(!messages.some(m => typeof m.content === 'string' && m.content.includes('bob@example.org')), 'a colleague\'s earlier message is not in the scan');
});

test('without an accumulator the gates answer as before', async () => {
    const req = { body: {}, session: { user: { id: 'u-1', organizationId: 'org-1' } } };
    const msgs = () => [{ role: 'system', content: 'S' }, { role: 'user', content: 'hello there' }];
    const without = await runInputGates({ req, res: { end() {} }, send: () => {}, userId: 'u-1', convId: null, message: 'hello there', messages: msgs(), modelId: 'm', config: CONFIG });
    const withIt = await runInputGates({ req, res: { end() {} }, send: () => {}, userId: 'u-1', convId: null, message: 'hello there', messages: msgs(), modelId: 'm', config: CONFIG, chatSignal: { pii: {}, dlp: null, allowlistedHosts: [] } });
    assert.deepEqual(Object.keys(withIt).sort(), Object.keys(without).sort());
    assert.equal(fx.piiCalls[0][5].report, undefined, 'no report without an accumulator');
});
