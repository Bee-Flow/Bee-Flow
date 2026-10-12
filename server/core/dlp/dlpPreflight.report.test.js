/**
 * What runDlpPreflight says about its own scan (chat signals, build spec 5.2b).
 *
 * Every return carries `scanStatus`, `categories` and `tooShort`, and the
 * person's "send anyway" carries `override: true`, so the recorder
 * (core/privacy/chatSignals.outcomeFromDlp) can tell apart, WITHOUT a second
 * scan: a scan skipped by scope, a message too short to scan, a clean scan, a
 * person sending anyway, auto-allow with findings, a fail-open scan failure
 * and a fail-closed block. `categories` are category ids or labels only: never
 * the matched text, an offset or a token.
 *
 * The scan, the audit row and the decision queue are swapped on their module
 * objects (testUtils/swaps); the preflight itself is real.
 *
 * Run: cd server && node --test core/dlp/dlpPreflight.report.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

const { swap, restore } = makeSwaps();
// The DLP runner takes `detectPii` from the piiDetection barrel when it
// loads: swap the detector first, so the one test that runs the REAL scan
// asks a detector that reads the text it is given (e-mail addresses only).
const asked = [];
const piiDetection = require('../privacy/piiDetection');
swap(piiDetection, 'detectPii', async (text) => {
    asked.push(text);
    const entities = [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => ({
        text: m[0], label: 'Email', category: 'EmailAddress', offset: m.index, length: m[0].length, confidence: 0.95,
    }));
    return { hasPii: entities.length > 0, entities };
});
const dlpRunner = require('./dlpRunner');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { runDlpPreflight } = require('./dlpPreflight');
const { outcomeFromDlp } = require('../privacy/chatSignals');

const realScan = dlpRunner.scan;
let scanResult = null;
let useRealScan = false;
before(() => {
    swap(dlpRunner, 'scan', async (args) => (useRealScan ? realScan(args) : scanResult));
    swap(dlpRunner, 'applyRedactionChoice', async () => ({ tokenizedText: 'mail [email_1]', tokenMap: { '[email_1]': 'x' } }));
    swap(dlpRunner, 'setConversationPref', () => {});
    swap(guardrailEventStore, 'logDlpDecision', async () => {});
});
after(restore);

const FINDINGS = [
    { label: 'Email', category: 'EmailAddress', source: 'pii', text: 'ada@example.org', offset: 5, length: 15, confidence: 0.9 },
    { label: 'Email', category: 'EmailAddress', source: 'pii', text: 'bob@example.org', offset: 25, length: 15, confidence: 0.9 },
    { label: 'Project Nightingale', category: null, source: 'custom', text: 'Nightingale', offset: 50, length: 11 },
];

/** One preflight over `text` as the last message, with `scan` as the scan's answer and `choice` as the person's. */
async function run({ scan, text = 'mail ada@example.org about it', choice = null, mode = 'ask' }) {
    scanResult = { provider: { displayName: 'X', isExternal: true }, findings: [], summary: {}, redactedText: null, tokenMap: null, ...scan };
    return runDlpPreflight({
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: text }],
        resolvedShield: { dlpEnabled: true, dlpMode: mode },
        conversationId: null,
        providerConfig: { providerType: 'openai', url: 'https://api.openai.com', displayName: 'OpenAI' },
        emit: () => {},
        audit: {},
        registerDecision: () => ({ decisionId: 'd1', promise: choice instanceof Error ? Promise.reject(choice) : Promise.resolve(choice) }),
    });
}

test('skipped by scope, too short and clean are three different answers', async () => {
    const scoped = await run({ scan: { action: 'allow', scanStatus: 'skipped' } });
    const short = await run({ scan: { action: 'allow', scanStatus: 'skipped' }, text: 'hi' });
    const clean = await run({ scan: { action: 'allow', scanStatus: 'ok' } });
    assert.deepEqual([scoped.scanStatus, scoped.tooShort, scoped.categories], ['skipped', false, []]);
    assert.deepEqual([short.scanStatus, short.tooShort], ['skipped', true]);
    assert.deepEqual([clean.scanStatus, clean.tooShort, clean.categories], ['ok', false, []]);
    assert.deepEqual([scoped, short, clean].map(outcomeFromDlp), ['unscanned', 'clean', 'clean']);
});

test('"send anyway" says override, and auto-allow with findings carries the categories', async () => {
    const anyway = await run({ scan: { action: 'ask', scanStatus: 'ok', findings: FINDINGS }, choice: { choice: 'allow' } });
    assert.equal(anyway.outcome, 'allow');
    assert.equal(anyway.override, true);
    assert.deepEqual(anyway.categories, ['EmailAddress', 'Project Nightingale']);
    assert.equal(outcomeFromDlp(anyway), 'sent_unprotected');

    const auto = await run({ scan: { action: 'allow', scanStatus: 'ok', findings: FINDINGS } });
    assert.equal(auto.outcome, 'allow');
    assert.equal(auto.override, undefined, 'nobody chose: no override');
    assert.equal(outcomeFromDlp(auto), 'sent_unprotected');
});

test('a fail-open scan failure and a fail-closed block are told apart from a policy block', async () => {
    const failOpen = await run({ scan: { action: 'allow', scanStatus: 'failed' } });
    assert.deepEqual([failOpen.outcome, failOpen.scanStatus], ['scan_failed', 'failed']);
    assert.equal(outcomeFromDlp(failOpen), 'scan_failed_open');

    const failClosed = await run({ scan: { action: 'block', scanStatus: 'failed', reason: 'pii_unavailable' } });
    assert.deepEqual([failClosed.outcome, failClosed.blocked, failClosed.scanStatus], ['blocked', true, 'failed']);
    assert.equal(outcomeFromDlp(failClosed), 'scan_failed_closed');

    const policy = await run({ scan: { action: 'block', scanStatus: 'ok', findings: FINDINGS } });
    assert.equal(outcomeFromDlp(policy), 'blocked');
    assert.deepEqual(policy.categories, ['EmailAddress', 'Project Nightingale']);
});

test('redaction (automatic or chosen) and a person\'s block carry the scan fields too', async () => {
    const auto = await run({ scan: { action: 'redact', scanStatus: 'ok', findings: FINDINGS, redactedText: 'mail [email_1]', tokenMap: { '[email_1]': 'x' } } });
    assert.equal(auto.outcome, 'redacted');
    assert.equal(outcomeFromDlp(auto), 'protected');
    assert.deepEqual(auto.categories, ['EmailAddress', 'Project Nightingale']);

    const chosen = await run({ scan: { action: 'ask', scanStatus: 'ok', findings: FINDINGS }, choice: { choice: 'redact' } });
    assert.equal(chosen.outcome, 'redacted');
    assert.equal(chosen.scanStatus, 'ok');

    const timedOut = await run({ scan: { action: 'ask', scanStatus: 'ok', findings: FINDINGS }, choice: Object.assign(new Error('t'), { code: 'DLP_TIMEOUT' }) });
    assert.deepEqual([timedOut.reason, timedOut.scanStatus], ['ask_timeout', 'ok']);
    assert.equal(outcomeFromDlp(timedOut), 'blocked');

    const userBlocked = await run({ scan: { action: 'ask', scanStatus: 'ok', findings: FINDINGS }, choice: { choice: 'block' } });
    assert.equal(outcomeFromDlp(userBlocked), 'blocked');
});

test('categories are ids or labels only: never the matched text, an offset or a token', async () => {
    const results = [
        await run({ scan: { action: 'ask', scanStatus: 'ok', findings: FINDINGS }, choice: { choice: 'allow' } }),
        await run({ scan: { action: 'redact', scanStatus: 'ok', findings: FINDINGS, redactedText: 'mail [email_1]', tokenMap: { '[email_1]': 'x' } } }),
        await run({ scan: { action: 'block', scanStatus: 'ok', findings: FINDINGS } }),
    ];
    for (const r of results) {
        // Exactly `category || label` per finding, deduplicated.
        assert.deepEqual(r.categories, ['EmailAddress', 'Project Nightingale']);
        const fields = JSON.stringify({ scanStatus: r.scanStatus, categories: r.categories, tooShort: r.tooShort, override: r.override });
        for (const leak of ['ada@example.org', 'bob@example.org', '"Nightingale"', '[email_1]', 'offset', 'length']) {
            assert.ok(!fields.includes(leak), `the scan fields carry ${leak}: ${fields}`);
        }
    }
});

test('shared thread: only the last user message is scanned, so a colleague\'s address is never this turn\'s category', async () => {
    useRealScan = true;
    try {
        const shield = { enabled: true, dlpEnabled: true, dlpMode: 'block', dlpScope: 'all' };
        const thread = (last) => [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'Ann here, reach me at ann.devries@example.org' },
            { role: 'assistant', content: 'Noted.' },
            { role: 'user', content: last },
        ];
        const call = (messages) => runDlpPreflight({
            messages, resolvedShield: shield, conversationId: null,
            providerConfig: { providerType: 'openai', url: 'https://api.openai.com', displayName: 'OpenAI' },
            emit: () => {}, audit: {},
        });

        asked.length = 0;
        const clean = await call(thread('Can you summarise the plan for the team'));
        assert.deepEqual([clean.outcome, clean.scanStatus, clean.categories], ['allow', 'ok', []]);
        assert.equal(outcomeFromDlp(clean), 'clean');
        assert.ok(asked.length >= 1 && asked.every((t) => !t.includes('ann.devries')), 'the scan never saw the earlier message');

        const found = await call(thread('and mine is bob@example.org'));
        assert.deepEqual([found.outcome, found.categories], ['blocked', ['EmailAddress']], 'the last message\'s own finding still counts');
    } finally {
        useRealScan = false;
    }
});

