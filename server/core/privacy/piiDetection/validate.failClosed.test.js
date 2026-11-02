/**
 * The input gate's failure policy covers the gate ITSELF, not only the
 * detector's verdict.
 *
 * The vault read that seeds tokenisation is a database call that runs AFTER
 * PII was found. When it fails the text is known to carry personal data, so
 * under fail_closed the turn is refused with the same "protection
 * unavailable" error a degraded scan produces; under fail_open the text goes
 * on unmasked, as it always did. Both the fresh-scan path and the cache-hit
 * path (same text, second time) are pinned, because the cache-hit branch
 * tokenises outside the scan's try.
 *
 * The agent runtime's gate (inputPiiGate) is pinned the same way: an error
 * the gate raises before it can answer is a block under fail_closed and a
 * pass under fail_open.
 *
 * Run: cd server && node --test core/privacy/piiDetection/validate.failClosed.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../../testUtils/swaps');

const fx = { detect: null, aiConfig: null, vault: null };
const { swap, restore } = makeSwaps();
const detect = require('./detect');
swap(detect, 'detectPii', async (text, ...rest) => fx.detect(text, ...rest));
const aiAgent = require('../../aiAgent');
swap(aiAgent, 'getAIConfig', async () => fx.aiConfig);
const vault = require('../../../stores/piiVaultStore');
swap(vault, 'buildSeed', async (...args) => fx.vault(...args));
const guardrailEventStore = require('../../../stores/guardrailEventStore');
swap(guardrailEventStore, 'logGuardrailEvent', async () => {});
const { validateInputForPii } = require('./validate');
const { runInputPiiGate } = require('../../agentRuntime/inputPiiGate');
after(restore);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function emailDetector(text) {
    const entities = [...text.matchAll(EMAIL)].map((m) => ({
        text: m[0], label: 'Email', category: 'EmailAddress', offset: m.index, length: m[0].length, confidence: 0.95,
    }));
    return { hasPii: entities.length > 0, entities };
}

const SHIELD = (over = {}) => ({ enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_closed', ...over });
const user = (content) => [{ role: 'user', content }];
let n = 0;
const fresh = (body) => `${body} #${++n}`;

beforeEach(() => {
    fx.detect = emailDetector;
    fx.aiConfig = { piiDetectionEnabled: false, piiDetectionAction: 'block' };
    fx.vault = async (_userId, _entities, existing) => ({ tokenMap: existing || {}, counterFloors: {} });
});

async function outcome(call) {
    const report = {};
    try { return { report, returned: await call(report), threw: null }; } catch (threw) { return { report, returned: undefined, threw }; }
}

test('vault failure after a find: refused under fail_closed, unmasked under fail_open', async () => {
    fx.vault = async () => { throw new Error('connection terminated'); };

    const closed = await outcome((report) => validateInputForPii(user(fresh('mail ada@example.org')), false, SHIELD(), null, null, { vaultUserId: 'u1', report }));
    assert.equal(closed.threw?.privacyUnavailable, true, 'fail_closed refuses the turn');
    assert.match(closed.threw.degradedReason, /^gate_error: connection terminated/);
    assert.deepEqual(closed.report, { status: 'failed_closed' });

    const open = await outcome((report) => validateInputForPii(user(fresh('mail bob@example.org')), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { vaultUserId: 'u1', report }));
    assert.equal(open.threw, null);
    assert.equal(open.returned, null, 'fail_open lets the text through unmasked, as before');
    assert.deepEqual(open.report, { status: 'failed_open' });
});

test('the same failure on the cache-hit path takes the same policy', async () => {
    const text = fresh('write to eve@example.org');
    const first = await outcome((report) => validateInputForPii(user(text), false, SHIELD(), null, null, { vaultUserId: 'u1', report }));
    assert.ok(first.returned?.tokenizedText, 'the first scan tokenises and fills the cache');

    fx.vault = async () => { throw new Error('connection terminated'); };
    const cachedClosed = await outcome((report) => validateInputForPii(user(text), false, SHIELD(), null, null, { vaultUserId: 'u1', report }));
    assert.equal(cachedClosed.threw?.privacyUnavailable, true, 'a cache hit cannot bypass the policy');
    assert.deepEqual(cachedClosed.report, { status: 'failed_closed' });

    const cachedOpen = await outcome((report) => validateInputForPii(user(text), false, SHIELD({ piiFailureMode: 'fail_open' }), null, null, { vaultUserId: 'u1', report }));
    assert.equal(cachedOpen.returned, null);
    assert.deepEqual(cachedOpen.report, { status: 'failed_open' });
});

test('a verdict is never mistaken for a gate failure', async () => {
    const blocked = await outcome((report) => validateInputForPii(user(fresh('write to ivy@example.org')), false, SHIELD({ piiDetectionAction: 'block' }), null, null, { report }));
    assert.match(blocked.threw.message, /PII Detected/);
    assert.equal(blocked.threw.privacyUnavailable, undefined);
    assert.deepEqual(blocked.report, { status: 'found', decision: 'blocked', categories: ['EmailAddress'] });
});

// ── The agent runtime's gate ──────────────────────────────────────────────

function gateDeps(validate) {
    return {
        validateInputForPii: validate,
        startPrivacyScanPhase: () => ({ onProgress: () => {}, end: () => {} }),
        messageText: (m) => (typeof m?.content === 'string' ? m.content : ''),
        dlpRunner: () => ({ getConversationTokenMapAsync: async () => ({}), mergeTokenMap: () => {} }),
    };
}

function runGate(shield, validate) {
    const events = [];
    return runInputPiiGate({
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello there' }],
        orgShield: shield,
        orgPiiEnabled: true,
        onEvent: (name, data) => events.push([name, data]),
        userId: 'u1',
        conversationId: 'c1',
        model: 'm',
        eventCtx: { organization_id: 'o1', user_id: 'u1', agent_id: 'a1', agent_name: 'A', conversation_id: 'c1', source: 'test', model: 'm', is_dry_run: false },
        piiReport: {},
        processedUserMessage: 'hello there',
    }, gateDeps(validate)).then((out) => ({ out, events }));
}

test('agent gate: an error before a verdict blocks under fail_closed and passes under fail_open', async () => {
    const boom = async () => { throw new Error('config store unavailable'); };
    const closed = await runGate(SHIELD(), boom);
    assert.match(closed.out.moderationViolation || '', /Privacy protection temporarily unavailable/);

    const open = await runGate(SHIELD({ piiFailureMode: 'fail_open' }), boom);
    assert.equal(open.out.moderationViolation, null, 'fail_open: the turn continues');

    const none = await runGate(null, boom);
    assert.equal(none.out.moderationViolation, null, 'no shield resolved: no policy to apply, as before');
});

test('agent gate: a verdict still wins over the policy', async () => {
    const verdict = async () => { const e = new Error('PII Detected: Email'); e.piiEntities = [{ label: 'Email' }]; throw e; };
    const r = await runGate(SHIELD({ piiFailureMode: 'fail_open' }), verdict);
    assert.equal(r.out.moderationViolation, 'PII Detected: Email');
});
