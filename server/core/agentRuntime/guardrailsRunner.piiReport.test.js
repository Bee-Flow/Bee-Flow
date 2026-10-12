/**
 * runInputGuardrails hands back `piiReport`: what the agent path's PII gate
 * decided on this turn, for chat signals (core/privacy/chatSignals.js).
 *
 *   deferred_to_dlp   the org's DLP gate takes over (the turn preflight then
 *                     counts the DLP result instead)
 *   disabled          no PII gate for this agent
 *   found + tokenised / found + blocked, failed_closed, clean: from the gate's
 *                     own `options.report` (piiDetection/validate.js)
 *
 * Shape: { status, decision: string|null, categories: string[] }. Category ids
 * only. The runner's other outputs are unchanged.
 *
 * The real gate (validate.js) runs; the detector, the AI config, the shield
 * resolution, the token store and the audit row are swapped on their module
 * objects before the runner loads (testUtils/swaps).
 *
 * Run: cd server && node --test core/agentRuntime/guardrailsRunner.piiReport.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

const fx = { shield: null, detect: null, aiConfig: null, scans: 0 };
const { swap, restore } = makeSwaps();
// The gate (validate.js) takes `detectPii` when it loads, and the DLP runner
// below loads the gate: swap the detector before anything else is required.
const detect = require('../privacy/piiDetection/detect');
swap(detect, 'detectPii', async (text) => { fx.scans++; return fx.detect(text); });
const aiAgent = require('../aiAgent');
const orgShield = require('../privacy/orgShield');
const dlpRunner = require('../dlp/dlpRunner');
const guardrailEventStore = require('../../stores/guardrailEventStore');
// The runner takes these when it loads: swap them before requiring it.
swap(aiAgent, 'getAIConfig', async () => fx.aiConfig);
swap(orgShield, 'resolveShieldFor', async () => fx.shield);
swap(orgShield, 'mergeWithOrgShield', () => ({ enabled: false }));
swap(dlpRunner, 'getConversationTokenMapAsync', async () => ({}));
swap(dlpRunner, 'mergeTokenMap', () => {});
swap(guardrailEventStore, 'logGuardrailEvent', async () => {});
const { runInputGuardrails } = require('./guardrailsRunner');
after(restore);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function emailDetector(text) {
    const entities = [...text.matchAll(EMAIL)].map((m) => ({
        text: m[0], label: 'Email', category: 'EmailAddress', offset: m.index, length: m[0].length, confidence: 0.95,
    }));
    return { hasPii: entities.length > 0, entities };
}

let n = 0;
function turn(text, globalConfig = {}) {
    const userMessage = `${text} (${++n})`;
    return runInputGuardrails({
        agent: { id: 'agent-7', name: 'Contract reader', organization_id: 'org-1', config: {} },
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: userMessage }],
        userMessage,
        globalConfig,
        onEvent: () => {},
        conversationId: undefined,
        source: 'agent_stream',
        model: 'm',
    });
}

beforeEach(() => {
    fx.shield = { enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_closed', dlpEnabled: false };
    fx.detect = emailDetector;
    fx.aiConfig = { piiDetectionEnabled: false, piiDetectionAction: 'block' };
    fx.scans = 0;
});

test('DLP takes over: deferred_to_dlp, and the PII gate does not scan', async () => {
    fx.shield = { ...fx.shield, dlpEnabled: true };
    const r = await turn('mail ada@example.org');
    assert.deepEqual(r.piiReport, { status: 'deferred_to_dlp', decision: null, categories: [] });
    assert.equal(fx.scans, 0);
});

test('no gate for this agent: disabled', async () => {
    fx.shield = null;
    const r = await turn('mail ada@example.org');
    assert.deepEqual(r.piiReport, { status: 'disabled', decision: null, categories: [] });
    assert.equal(fx.scans, 0);
});

test('found and masked: found + tokenised, with the category id', async () => {
    const r = await turn('mail ada@example.org');
    assert.deepEqual(r.piiReport, { status: 'found', decision: 'tokenised', categories: ['EmailAddress'] });
    assert.ok(!r.processedUserMessage.includes('ada@example.org'), 'still masked as before');
    assert.equal(r.moderationViolation, null);
});

test('found and refused: found + blocked, and the violation is reported as before', async () => {
    fx.shield = { ...fx.shield, piiDetectionAction: 'block' };
    const r = await turn('mail ada@example.org');
    assert.deepEqual(r.piiReport, { status: 'found', decision: 'blocked', categories: ['EmailAddress'] });
    assert.match(r.moderationViolation, /^PII Detected/);
});

test('protection unavailable under fail_closed: failed_closed', async () => {
    fx.detect = () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable' });
    const r = await turn('mail ada@example.org');
    assert.deepEqual(r.piiReport, { status: 'failed_closed', decision: null, categories: [] });
    assert.ok(r.moderationViolation, 'the turn is still blocked');
});

test('nothing found: clean, with no categories; the report never holds a value', async () => {
    const clean = await turn('nothing personal in here');
    assert.deepEqual(clean.piiReport, { status: 'clean', decision: null, categories: [] });
    const found = await turn('mail ada@example.org');
    assert.ok(!JSON.stringify(found.piiReport).includes('ada@'), 'category ids only');
});
