/**
 * Multiple attachments in one turn each needing their own 'ask' review —
 * DB-free, stubs attachmentScanner + attachmentAskFlow so no guard service,
 * no real decisionQueue timers, and no DB are touched.
 *
 * Pins: each attachment gets its OWN resolveAttachmentAsk call (sequential,
 * not batched — see attachmentAskFlow.js's header), with the RIGHT filename
 * and findings passed to each, and each attachment's redacted text lands in
 * the message content independently — no cross-contamination between files.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/attachmentProcessor.multiFile.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

class FakeAttachmentPrivacyBlock extends Error {
    constructor({ filename, summary, findings, reason }) {
        super(`blocked: ${filename}`);
        this.code = 'ATTACHMENT_PII_BLOCKED';
        this.filename = filename; this.summary = summary; this.findings = findings; this.reason = reason;
    }
}

const resolveCalls = [];
let resolveImpl; // (args) => result — set per test

const fakeAttachmentScanner = {
    // Every attachment "needs review" in this suite — the scanner always
    // returns 'ask' with a finding tagged by filename, so the two files are
    // trivially distinguishable in assertions.
    scanAttachmentText: async ({ text, filename }) => ({
        action: 'ask',
        text,
        findings: [{ id: `pii_${filename}`, category: 'Person', source: 'pii', offset: 0, length: 4, text: text.slice(0, 4), confidence: 0.9 }],
        summary: { filename },
        tokenMap: null,
    }),
    AttachmentPrivacyBlock: FakeAttachmentPrivacyBlock,
};
const fakeAttachmentAskFlow = {
    resolveAttachmentAsk: async (args) => { resolveCalls.push(args); return resolveImpl(args); },
};

const restore = installResolveStub({
    '../dlp/attachmentScanner': fakeAttachmentScanner,
    '../dlp/attachmentAskFlow': fakeAttachmentAskFlow,
});

const { processAttachments } = require('./attachmentProcessor');

function reset() { resolveCalls.length = 0; }

test('two attachments each needing ask get their OWN sequential review, correct filename/findings per call', async () => {
    reset();
    resolveImpl = ({ text, filename }) => ({
        action: 'tokenize', text: `[REDACTED-${filename}]${text.slice(4)}`, findings: [], summary: { filename, count: 1 }, tokenMap: { [`[x_${filename}]`]: text.slice(0, 4) },
    });

    const lastMsg = { role: 'user', content: 'please review these two files' };
    const attachments = [
        { name: 'a.txt', type: 'text/plain', content: 'AAAA is confidential' },
        { name: 'b.txt', type: 'text/plain', content: 'BBBB is confidential' },
    ];
    const events = [];
    const { attachmentScanSummaries } = await processAttachments(attachments, lastMsg, 'u1', {
        orgShield: { dlpEnabled: true, dlpMode: 'ask' },
        conversationId: 'conv1',
        emit: (type, data) => events.push({ type, data }),
    });

    // Both files were resolved, in upload order, each with its own text/filename.
    assert.equal(resolveCalls.length, 2);
    assert.equal(resolveCalls[0].filename, 'a.txt');
    assert.equal(resolveCalls[0].text, 'AAAA is confidential');
    assert.equal(resolveCalls[1].filename, 'b.txt');
    assert.equal(resolveCalls[1].text, 'BBBB is confidential');

    // Each file's redacted text landed in the message content, not swapped.
    const textBlock = lastMsg.content.find(c => c.type === 'text');
    assert.ok(textBlock.text.includes('[REDACTED-a.txt]'), 'file a\'s own redaction must appear');
    assert.ok(textBlock.text.includes('[REDACTED-b.txt]'), 'file b\'s own redaction must appear');
    assert.ok(!textBlock.text.includes('AAAA'), 'raw content of a.txt must not survive');
    assert.ok(!textBlock.text.includes('BBBB'), 'raw content of b.txt must not survive');

    // Summaries carry both files' own detail, not merged/overwritten.
    assert.equal(attachmentScanSummaries.length, 2);
    assert.deepEqual(attachmentScanSummaries.map(s => s.filename).sort(), ['a.txt', 'b.txt']);
});

test('a block decision on the SECOND of two attachments still stops the turn (throws), first file\'s scan is not silently kept', async () => {
    reset();
    resolveImpl = ({ filename }) => {
        if (filename === 'b.txt') return { action: 'block', reason: 'user_blocked', text: null, findings: [], summary: { filename } };
        return { action: 'tokenize', text: '[REDACTED-a]', findings: [], summary: { filename: 'a.txt', count: 1 }, tokenMap: {} };
    };
    const lastMsg = { role: 'user', content: 'two files, block the second' };
    const attachments = [
        { name: 'a.txt', type: 'text/plain', content: 'AAAA harmless-ish' },
        { name: 'b.txt', type: 'text/plain', content: 'BBBB blocked' },
    ];
    await assert.rejects(
        () => processAttachments(attachments, lastMsg, 'u1', { orgShield: { dlpEnabled: true, dlpMode: 'ask' }, conversationId: 'conv2' }),
        (err) => err.code === 'ATTACHMENT_PII_BLOCKED' && err.filename === 'b.txt',
    );
    assert.equal(resolveCalls.length, 2, 'the first file was still reviewed before the second one blocked the turn');
});

test.after(() => restore());
