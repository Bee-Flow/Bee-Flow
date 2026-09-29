/**
 * Unit tests for the direct-chat history merge helpers.
 *
 * Run: node --test core/conversation/historyMerge.test.js
 *
 * The bug under test: on edit/retry (and on surfaces that never sync a
 * conversation id) the client sends history with attachments stripped to
 * { name, type }. The server used to trust that copy, so the hydrator lost
 * the extractedText sidecar and the model forgot uploaded files. The exact
 * content-string matching in the old persistence merge also failed on PII
 * tokenization ([email_1] in the DB vs restored text on the client), wiping
 * attachments out of the DB for good.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { alignClientToDb, mergeAttachmentSidecars, shouldDisableResponsesChaining } = require('./historyMerge');

const RICH_ATT = {
    name: 'report.pdf',
    type: 'application/pdf',
    extractedText: 'FULL-EXTRACTED-TEXT',
    extractionKey: 'ek-1',
    storageKey: 'sk-1',
};

function dbRows() {
    return [
        { role: 'user', content: 'hello', timestamp: 't1' },
        { role: 'assistant', content: 'hi there', timestamp: 't2' },
        { role: 'user', content: 'read [email_1] and the file', timestamp: 't3', attachments: [RICH_ATT] },
        { role: 'assistant', content: 'summary of the file', timestamp: 't4' },
    ];
}

test('edit/retry prefix: stripped attachments are grafted back from DB', () => {
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'read tom@example.com and the file', attachments: [{ name: 'report.pdf', type: 'application/pdf' }] },
    ];
    const merged = mergeAttachmentSidecars(client, dbRows());

    assert.strictEqual(merged.length, 3);
    assert.strictEqual(merged[2].attachments[0].extractedText, 'FULL-EXTRACTED-TEXT');
    assert.strictEqual(merged[2].attachments[0].extractionKey, 'ek-1');
    // Client content stays authoritative (restored text, possible edit)
    assert.strictEqual(merged[2].content, 'read tom@example.com and the file');
});

test('PII-tokenized DB content still aligns via role-ordinal fallback', () => {
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        // Restored text ≠ tokenized DB copy, and no client attachments at all
        { role: 'user', content: 'read tom@example.com and the file' },
    ];
    const aligned = alignClientToDb(client, dbRows());

    assert.strictEqual(aligned[0].dbMatch.timestamp, 't1');
    assert.strictEqual(aligned[2].dbMatch.timestamp, 't3', 'ordinal pairing bridges the tokenization gap');
    const merged = mergeAttachmentSidecars(client, dbRows());
    assert.strictEqual(merged[2].attachments[0].extractedText, 'FULL-EXTRACTED-TEXT');
});

test('tool and system rows in the DB are skipped during alignment', () => {
    const db = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello', timestamp: 't1' },
        { role: 'assistant', content: 'calling a tool', timestamp: 't2' },
        { role: 'tool', content: 'tool result' },
        { role: 'assistant', content: 'done', timestamp: 't3' },
    ];
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'calling a tool' },
        { role: 'assistant', content: 'done' },
    ];
    const aligned = alignClientToDb(client, db);
    assert.strictEqual(aligned[1].dbMatch.timestamp, 't2');
    assert.strictEqual(aligned[2].dbMatch.timestamp, 't3');
});

test('client longer than DB: unmatched tail passes through with dbMatch null', () => {
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'brand new message not in DB yet' },
    ];
    const aligned = alignClientToDb(client, dbRows().slice(0, 2));
    assert.strictEqual(aligned[2].dbMatch, null);

    const merged = mergeAttachmentSidecars(client, dbRows().slice(0, 2));
    assert.deepStrictEqual(merged[2], client[2]);
});

test('attachment-name disagreement keeps the client copy (defensive)', () => {
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'read the file', attachments: [{ name: 'other.docx', type: 'application/docx' }] },
    ];
    const merged = mergeAttachmentSidecars(client, dbRows());
    assert.deepStrictEqual(merged[2].attachments, [{ name: 'other.docx', type: 'application/docx' }]);
});

test('inputs are not mutated', () => {
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'read the file', attachments: [{ name: 'report.pdf', type: 'application/pdf' }] },
    ];
    const db = dbRows();
    const clientSnapshot = JSON.stringify(client);
    const dbSnapshot = JSON.stringify(db);
    mergeAttachmentSidecars(client, db);
    alignClientToDb(client, db);
    assert.strictEqual(JSON.stringify(client), clientSnapshot);
    assert.strictEqual(JSON.stringify(db), dbSnapshot);
});

test('alignClientToDb returns rich DB rows for the persistence path', () => {
    // The persistence merge maps client history back to rich saved rows; a
    // PII-tokenized row must map to its DB original (timestamps, attachments,
    // privacy meta intact), not degrade to a bare {role, content} record.
    const client = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'read tom@example.com and the file' },
        { role: 'assistant', content: 'summary of the file' },
    ];
    const saved = alignClientToDb(client, dbRows()).map(({ client: c, dbMatch }) =>
        dbMatch || { role: c.role, content: c.content, timestamp: 'now' });

    assert.strictEqual(saved[2].timestamp, 't3');
    assert.strictEqual(saved[2].attachments[0].extractedText, 'FULL-EXTRACTED-TEXT');
    assert.strictEqual(saved[3].timestamp, 't4');
});

test('duplicate content anchors stay monotonic (no crossed alignment)', () => {
    const db = [
        { role: 'user', content: 'same question', timestamp: 't1', attachments: [RICH_ATT] },
        { role: 'assistant', content: 'first answer', timestamp: 't2' },
        { role: 'user', content: 'same question', timestamp: 't3' },
        { role: 'assistant', content: 'second answer', timestamp: 't4' },
    ];
    const client = [
        { role: 'user', content: 'same question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'same question' },
    ];
    const aligned = alignClientToDb(client, db);
    assert.strictEqual(aligned[0].dbMatch.timestamp, 't1');
    assert.strictEqual(aligned[2].dbMatch.timestamp, 't3', 'second duplicate maps to the later row');
});

test('shouldDisableResponsesChaining truth table', () => {
    assert.strictEqual(shouldDisableResponsesChaining({ clientHistoryProvided: false, attachmentContext: false }), false);
    assert.strictEqual(shouldDisableResponsesChaining({ clientHistoryProvided: true, attachmentContext: false }), true);
    assert.strictEqual(shouldDisableResponsesChaining({ clientHistoryProvided: false, attachmentContext: true }), true);
    assert.strictEqual(shouldDisableResponsesChaining({ clientHistoryProvided: true, attachmentContext: true }), true);
    assert.strictEqual(shouldDisableResponsesChaining(), false);
    assert.strictEqual(shouldDisableResponsesChaining({}), false);
});
