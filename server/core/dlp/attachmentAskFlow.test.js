/**
 * resolveAttachmentAsk — the attachment-side counterpart to dlpPreflight's
 * text 'ask' branch: emits `dlp_attachment_preview`, awaits one decision,
 * and returns a result shaped exactly like scanAttachmentText's other
 * outcomes so callers need no special case.
 *
 * DB-free: applyAttachmentRedactionChoice and decisionQueue.register are
 * both stubbed, mirroring dlpPreflight.test.js's approach.
 *
 * Run: cd server && node --test --test-force-exit core/dlp/attachmentAskFlow.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

let registerImpl;
const applyCalls = [];
const setPrefCalls = [];

const fakeDecisionQueue = { register: (...a) => registerImpl(...a) };
const fakeAttachmentScanner = {
    applyAttachmentRedactionChoice: (args) => {
        applyCalls.push(args);
        return { action: 'tokenize', text: 'tokenised-text', findings: args.findings, summary: { filename: args.filename, count: args.findings.length }, tokenMap: { '[x_1]': 'raw' } };
    },
};
const fakeDlpRunner = {
    setConversationPref: (convId, choice) => setPrefCalls.push({ convId, choice }),
};

const restore = installResolveStub({
    './decisionQueue': fakeDecisionQueue,
    './attachmentScanner': fakeAttachmentScanner,
    './dlpRunner': fakeDlpRunner,
});

const { resolveAttachmentAsk } = require('./attachmentAskFlow');

function reset() { applyCalls.length = 0; setPrefCalls.length = 0; }

test('emits dlp_attachment_preview with full per-finding shape (category, offset, length, band, full text)', async () => {
    reset();
    const events = [];
    registerImpl = () => ({ decisionId: 'd1', promise: Promise.resolve({ choice: 'allow' }) });
    await resolveAttachmentAsk({
        text: 'call me at leak@example.com',
        findings: [{ label: 'Email', category: 'Email', source: 'pii', text: 'leak@example.com', offset: 12, length: 17, confidence: 0.93 }],
        filename: 'report.pdf',
        provider: { displayName: 'OpenAI', isExternal: true },
        orgShield: { piiDetectionConfidenceThreshold: 0.7 },
        conversationId: 'conv1',
        userId: 'u1',
        emit: (type, data) => events.push({ type, data }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'dlp_attachment_preview');
    const payload = events[0].data;
    assert.equal(payload.decisionId, 'd1');
    assert.equal(payload.filename, 'report.pdf');
    assert.equal(payload.reviewText, 'call me at leak@example.com');
    assert.equal(payload.findings[0].text, 'leak@example.com');
    assert.equal(payload.findings[0].offset, 12);
    assert.equal(payload.findings[0].length, 17);
    assert.equal(payload.findings[0].confidenceBand, 'high');
});

test('choice "allow": returns pass with the ORIGINAL text and findings still reported', async () => {
    reset();
    registerImpl = () => ({ decisionId: 'd2', promise: Promise.resolve({ choice: 'allow' }) });
    const r = await resolveAttachmentAsk({
        text: 'raw text with pii', findings: [{ category: 'Email', offset: 0, length: 3, text: 'raw' }],
        filename: 'a.txt', orgShield: {}, conversationId: 'c',
    });
    assert.deepEqual(r, { action: 'pass', text: 'raw text with pii', findings: [{ category: 'Email', offset: 0, length: 3, text: 'raw' }], summary: { filename: 'a.txt' }, tokenMap: null });
});

test('choice "block": returns a block outcome, reason user_blocked', async () => {
    reset();
    registerImpl = () => ({ decisionId: 'd3', promise: Promise.resolve({ choice: 'block' }) });
    const r = await resolveAttachmentAsk({ text: 'x', findings: [], filename: 'a.txt', orgShield: {}, conversationId: 'c' });
    assert.equal(r.action, 'block');
    assert.equal(r.reason, 'user_blocked');
    assert.equal(r.text, null);
});

test('decision promise rejects (timeout): fail-closed block with reason ask_timeout, distinct from a scan timeout', async () => {
    reset();
    const err = new Error('to'); err.code = 'DLP_TIMEOUT';
    registerImpl = () => ({ decisionId: 'd4', promise: Promise.reject(err) });
    const r = await resolveAttachmentAsk({ text: 'x', findings: [], filename: 'a.txt', orgShield: {}, conversationId: 'c' });
    assert.equal(r.action, 'block');
    assert.equal(r.reason, 'ask_timeout');
});

test('rememberForConversation stores the choice via dlpRunner.setConversationPref', async () => {
    reset();
    registerImpl = () => ({ decisionId: 'd5', promise: Promise.resolve({ choice: 'allow', rememberForConversation: true }) });
    await resolveAttachmentAsk({ text: 'x', findings: [], filename: 'a.txt', orgShield: {}, conversationId: 'conv-r' });
    assert.deepEqual(setPrefCalls, [{ convId: 'conv-r', choice: 'allow' }]);
});

test('choice "redact": merges valid manualAdditions (re-sliced server-side) into applyAttachmentRedactionChoice', async () => {
    reset();
    const text = 'hello Alice, no auto hit here';
    registerImpl = () => ({
        decisionId: 'd6',
        promise: Promise.resolve({ choice: 'redact', manualAdditions: [{ offset: 6, length: 5 }] }),
    });
    const r = await resolveAttachmentAsk({ text, findings: [], filename: 'manual.txt', orgShield: {}, conversationId: 'c' });
    assert.equal(r.action, 'tokenize');
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].findings.length, 1);
    assert.equal(applyCalls[0].findings[0].text, 'Alice', 're-sliced from the server-side text, not trusted from the client');
    assert.equal(applyCalls[0].findings[0].category, 'UserMarked');
    assert.equal(applyCalls[0].findings[0].source, 'manual');
});

test('choice "redact": an out-of-bounds manualAddition is dropped, not applied', async () => {
    reset();
    const text = 'short';
    registerImpl = () => ({
        decisionId: 'd7',
        promise: Promise.resolve({ choice: 'redact', manualAdditions: [{ offset: 100, length: 5 }] }),
    });
    await resolveAttachmentAsk({ text, findings: [], filename: 'oob.txt', orgShield: {}, conversationId: 'c' });
    assert.deepEqual(applyCalls[0].findings, []);
});

test('choice "redact": auto findings and manual additions are merged into ONE applyAttachmentRedactionChoice call', async () => {
    reset();
    const text = 'auto here, manual there';
    const autoFinding = { category: 'Email', offset: 0, length: 4, text: 'auto', source: 'pii' };
    registerImpl = () => ({
        decisionId: 'd8',
        promise: Promise.resolve({ choice: 'redact', manualAdditions: [{ offset: 11, length: 6 }] }),
    });
    await resolveAttachmentAsk({ text, findings: [autoFinding], filename: 'both.txt', orgShield: {}, conversationId: 'c' });
    assert.equal(applyCalls[0].findings.length, 2);
    assert.ok(applyCalls[0].findings.includes(autoFinding));
    assert.ok(applyCalls[0].findings.some(f => f.text === 'manual'));
});

test.after(() => restore());
