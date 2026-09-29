/**
 * Unit tests for the history hydrator — the attachment sidecar replay that
 * keeps uploaded-file content visible to the model on follow-up turns.
 *
 * Run: node --test core/agentRuntime/historyHydrator.test.js
 *
 * Only sidecars WITHOUT storageKey / temp URLs are used here so the
 * tempDownloadUrl require inside refreshTempUrl never fires in unit scope.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { hydrateHistoryAttachments } = require('./historyHydrator');

const REINJECT_MAX_CHARS = 30_000; // mirrors the constant in historyHydrator.js

function textOf(msg) {
    if (typeof msg.content === 'string') return msg.content;
    return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

test('doc attachment with extractedText → real text re-injected, not a placeholder', async () => {
    const messages = [
        {
            role: 'user',
            content: 'summarize the report',
            attachments: [{ name: 'report.pdf', type: 'application/pdf', extractedText: 'QUARTERLY-NUMBERS-BODY' }],
        },
        { role: 'user', content: 'current turn' },
    ];
    await hydrateHistoryAttachments(messages, { skipLast: false });

    assert.ok(Array.isArray(messages[0].content), 'string content converted to blocks');
    assert.strictEqual(messages[0].content[0].text, 'summarize the report', 'original text kept first');
    assert.ok(textOf(messages[0]).includes('QUARTERLY-NUMBERS-BODY'));
    assert.ok(!textOf(messages[0]).includes('previously attached'), 'no placeholder when text exists');
});

test('oversized extractedText is truncated with a replay marker + extractionKey ref', async () => {
    const big = 'A'.repeat(REINJECT_MAX_CHARS + 5000);
    const messages = [
        {
            role: 'user',
            content: 'read this',
            attachments: [{ name: 'big.pdf', type: 'application/pdf', extractedText: big, extractionKey: 'ek-42' }],
        },
        { role: 'user', content: 'current turn' },
    ];
    await hydrateHistoryAttachments(messages, { skipLast: false });

    const text = textOf(messages[0]);
    assert.ok(text.includes('truncated for replay'));
    assert.ok(text.includes('ek-42'), 'extractionKey referenced so full text stays recoverable');
    assert.ok(text.length < big.length, 'actually truncated');
});

test('missing extractedText falls back to a typed placeholder (no store fetch)', async () => {
    // Design decision (extractedTextStore.js): the hydrator replays only the
    // inline head+tail snippet; it never fetches extractionKey from RustFS.
    const messages = [
        {
            role: 'user',
            content: 'about the files',
            attachments: [
                { name: 'scan.pdf', type: 'application/pdf', extractionKey: 'ek-9' },
                { name: 'notes.txt', type: 'text/plain' },
            ],
        },
        { role: 'user', content: 'current turn' },
    ];
    await hydrateHistoryAttachments(messages, { skipLast: false });

    const text = textOf(messages[0]);
    assert.ok(text.includes('[PDF previously attached: scan.pdf]'));
    assert.ok(text.includes('[File previously attached: notes.txt]'));
});

test('image attachment with no url/storageKey/content degrades to a placeholder', async () => {
    const messages = [
        { role: 'user', content: 'look at this', attachments: [{ name: 'pic.png', type: 'image/png' }] },
        { role: 'user', content: 'current turn' },
    ];
    await hydrateHistoryAttachments(messages, { skipLast: false });
    assert.ok(textOf(messages[0]).includes('[Image previously attached: pic.png]'));
});

test('skipLast=true (default) leaves the final message untouched', async () => {
    const mk = () => [
        { role: 'user', content: 'old turn', attachments: [{ name: 'a.pdf', type: 'application/pdf', extractedText: 'OLD-TEXT' }] },
        { role: 'user', content: 'live turn', attachments: [{ name: 'b.pdf', type: 'application/pdf', extractedText: 'LIVE-TEXT' }] },
    ];

    const defaulted = mk();
    await hydrateHistoryAttachments(defaulted, {});
    assert.ok(textOf(defaulted[0]).includes('OLD-TEXT'), 'history hydrated');
    assert.strictEqual(defaulted[1].content, 'live turn', 'last message untouched (processAttachments owns it)');

    const all = mk();
    await hydrateHistoryAttachments(all, { skipLast: false });
    assert.ok(textOf(all[1]).includes('LIVE-TEXT'), 'skipLast:false hydrates everything');
});

test('messages without attachments or image blocks pass through untouched', async () => {
    const messages = [
        { role: 'user', content: 'plain' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'current' },
    ];
    const snapshot = JSON.stringify(messages);
    await hydrateHistoryAttachments(messages, { skipLast: false });
    assert.strictEqual(JSON.stringify(messages), snapshot);
});

// ── BFSF-307: the invariant the whole persistence fix rests on ──────────────
//
// chatStream keeps two arrays — the LLM prompt and the durable history — that
// SHARE element objects, which is only safe because hydration replaces array
// SLOTS rather than mutating the message objects. If someone ever "simplifies"
// this to an in-place mutation, the durable history silently starts carrying
// content blocks again and BFSF-307 reopens with no test failing anywhere else.
test('BFSF-307: hydration replaces slots, never mutates the caller\'s message objects', async () => {
    const original = {
        role: 'user',
        content: 'kijk eens naar deze factuur',
        attachments: [{ name: 'factuur.pdf', type: 'application/pdf', extractedText: 'Factuur 2026-0042' }],
    };
    const messages = [original, { role: 'user', content: 'en nu?' }];
    // A second array holding the SAME element, exactly as chatStream does.
    const durable = [original];

    await hydrateHistoryAttachments(messages, {});

    assert.strictEqual(typeof original.content, 'string',
        'the message object itself must be untouched');
    assert.strictEqual(durable[0].content, 'kijk eens naar deze factuur',
        'the durable array must not see the hydrated content');
    assert.ok(Array.isArray(messages[0].content),
        'the prompt array slot must have been replaced with content blocks');
    assert.notStrictEqual(messages[0], durable[0],
        'prompt and durable must now hold different objects for this turn');
});
