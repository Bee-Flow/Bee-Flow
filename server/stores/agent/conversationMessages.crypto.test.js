/**
 * Encryption round-trip for the message store.
 *
 * The store owns the two chokepoints (messagesToRows / rowToMessage) where a
 * message becomes a DB row and back. These tests are DB-free on purpose — they
 * exercise exactly the transformation, including the case that matters most:
 * the attachment sidecar surviving intact.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { messagesToRows, rowToMessage } = require('./conversationMessages');
const { PLAINTEXT_CONTEXT } = require('./messageCrypto');
const { isEnvelope, FieldDecryptError } = require('../lib/fieldEnvelope');

const DEK = crypto.createHash('sha256').update('conv-msg-test-dek').digest();
const OTHER_DEK = crypto.createHash('sha256').update('a-different-dek').digest();
const CONV = 'conv-123';

const ON = { key: DEK, encryptMessages: true, encryptMeta: true, tier: 'managed' };
const OFF = PLAINTEXT_CONTEXT;
const MESSAGES_ONLY = { key: DEK, encryptMessages: true, encryptMeta: false, tier: 'managed' };
const META_ONLY = { key: DEK, encryptMessages: false, encryptMeta: true, tier: 'managed' };

const SAMPLE = [
    { role: 'user', content: 'What is our Q3 severance exposure?' },
    { role: 'assistant', content: 'Here is the analysis.' },
];

// A realistic attachment sidecar: storageKey and extractedText are the fields
// whose loss is unrecoverable.
const WITH_ATTACHMENT = [{
    role: 'user',
    content: 'Summarise this contract',
    attachments: [{
        name: 'Severance agreement.pdf',
        type: 'application/pdf',
        storageKey: 'users/u-1/uploads/upload_123_abc.pdf',
        url: 'https://example.invalid/proxy/abc',
        extractedText: 'CONFIDENTIAL — termination terms and amounts …',
        extractionKey: 'users/u-1/extractions/extract_123.txt',
    }],
}];

function roundTrip(messages, writeCtx, readCtx = writeCtx, type = 'agent') {
    const rows = messagesToRows(CONV, type, messages, writeCtx);
    return rows.map(r => rowToMessage(r, readCtx));
}

// ── Off by default ──────────────────────────────────────────────────────────

test('with no context the store behaves exactly as before (plaintext)', () => {
    const rows = messagesToRows(CONV, 'agent', SAMPLE);
    assert.strictEqual(rows[0].content, SAMPLE[0].content, 'content stored verbatim');
    assert.ok(!isEnvelope(rows[0].content));
    assert.ok(!isEnvelope(rows[0].meta_json));
    const back = rows.map(r => rowToMessage(r));
    assert.deepStrictEqual(back.map(m => ({ role: m.role, content: m.content })), SAMPLE);
});

test('explicitly disabled context also stores plaintext', () => {
    const rows = messagesToRows(CONV, 'agent', SAMPLE, OFF);
    assert.strictEqual(rows[0].content, SAMPLE[0].content);
});

// ── Encryption on ───────────────────────────────────────────────────────────

test('content and meta are ciphertext on disk, and round-trip', () => {
    const rows = messagesToRows(CONV, 'agent', SAMPLE, ON);
    assert.ok(isEnvelope(rows[0].content), 'content should be an envelope');
    assert.ok(isEnvelope(rows[0].meta_json), 'meta should be an envelope');
    assert.ok(!rows[0].content.includes('severance'), 'plaintext must not survive');
    assert.ok(!rows[0].content.includes('Q3'));

    const back = rows.map(r => rowToMessage(r, ON));
    assert.strictEqual(back[0].content, SAMPLE[0].content);
    assert.strictEqual(back[1].content, SAMPLE[1].content);
    assert.strictEqual(back[0].role, 'user');
});

test('role and tool_name stay queryable columns (not encrypted)', () => {
    const rows = messagesToRows(CONV, 'agent', [{ role: 'tool', content: 'x', tool_name: 'search' }], ON);
    assert.strictEqual(rows[0].role, 'tool');
    assert.strictEqual(rows[0].tool_name, 'search');
});

test('structured (array) content survives encryption', () => {
    const multimodal = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x/y' } }] }];
    const back = roundTrip(multimodal, ON);
    assert.deepStrictEqual(back[0].content, multimodal[0].content);
});

// ── The attachment sidecar — the regression that matters ────────────────────

test('attachment sidecar survives an encrypted round-trip byte-for-byte', () => {
    const back = roundTrip(WITH_ATTACHMENT, ON);
    assert.deepStrictEqual(back[0].attachments, WITH_ATTACHMENT[0].attachments);
    // Named explicitly: losing either of these is unrecoverable.
    assert.strictEqual(back[0].attachments[0].storageKey, WITH_ATTACHMENT[0].attachments[0].storageKey);
    assert.strictEqual(back[0].attachments[0].extractedText, WITH_ATTACHMENT[0].attachments[0].extractedText);
});

test('extracted document text is not readable on disk once meta is encrypted', () => {
    const rows = messagesToRows(CONV, 'agent', WITH_ATTACHMENT, ON);
    assert.ok(!rows[0].meta_json.includes('CONFIDENTIAL'), 'extracted text must not sit in the clear');
    assert.ok(!rows[0].meta_json.includes('Severance agreement.pdf'), 'filename must not sit in the clear');
});

test('a wrong key throws rather than yielding an empty sidecar', () => {
    const rows = messagesToRows(CONV, 'agent', WITH_ATTACHMENT, ON);
    assert.throws(
        () => rowToMessage(rows[0], { key: OTHER_DEK, encryptMessages: true, encryptMeta: true }),
        FieldDecryptError,
        'an empty sidecar would let mergeAttachmentSidecars destroy storageKey on the next edit'
    );
});

test('a missing key throws rather than yielding an empty sidecar', () => {
    const rows = messagesToRows(CONV, 'agent', WITH_ATTACHMENT, ON);
    assert.throws(() => rowToMessage(rows[0], PLAINTEXT_CONTEXT), FieldDecryptError);
});

// ── Partial enablement ──────────────────────────────────────────────────────

test('messages-only: content encrypted, meta left readable', () => {
    const rows = messagesToRows(CONV, 'agent', WITH_ATTACHMENT, MESSAGES_ONLY);
    assert.ok(isEnvelope(rows[0].content));
    assert.ok(!isEnvelope(rows[0].meta_json));
    const back = rowToMessage(rows[0], MESSAGES_ONLY);
    assert.strictEqual(back.content, WITH_ATTACHMENT[0].content);
    assert.deepStrictEqual(back.attachments, WITH_ATTACHMENT[0].attachments);
});

test('meta-only: content left searchable, sidecar protected', () => {
    const rows = messagesToRows(CONV, 'agent', WITH_ATTACHMENT, META_ONLY);
    assert.ok(!isEnvelope(rows[0].content), 'content stays plaintext so SQL search keeps working');
    assert.ok(isEnvelope(rows[0].meta_json));
    const back = rowToMessage(rows[0], META_ONLY);
    assert.deepStrictEqual(back.attachments, WITH_ATTACHMENT[0].attachments);
});

// ── Toggling, in both directions ────────────────────────────────────────────

test('rows written before encryption was enabled still read afterwards', () => {
    const legacyRows = messagesToRows(CONV, 'agent', SAMPLE, OFF);
    const back = legacyRows.map(r => rowToMessage(r, ON));   // policy now on
    assert.strictEqual(back[0].content, SAMPLE[0].content);
});

test('rows written while encryption was on still read after it is disabled', () => {
    const encRows = messagesToRows(CONV, 'agent', SAMPLE, ON);
    // Policy is off now, but the key is still resolvable, so reads must work.
    const readCtxAfterDisable = { key: DEK, encryptMessages: false, encryptMeta: false, tier: 'none' };
    const back = encRows.map(r => rowToMessage(r, readCtxAfterDisable));
    assert.strictEqual(back[0].content, SAMPLE[0].content);
});

test('a conversation with a mix of old plaintext and new encrypted rows reads correctly', () => {
    const older = messagesToRows(CONV, 'agent', [{ role: 'user', content: 'old turn' }], OFF);
    const newer = messagesToRows(CONV, 'agent', [{ role: 'assistant', content: 'new turn' }], ON);
    const back = [...older, ...newer].map(r => rowToMessage(r, ON));
    assert.deepStrictEqual(back.map(m => m.content), ['old turn', 'new turn']);
});

// ── Context binding ─────────────────────────────────────────────────────────

test('a row cannot be replayed into a different conversation', () => {
    const rows = messagesToRows(CONV, 'agent', SAMPLE, ON);
    const moved = { ...rows[0], conversation_id: 'conv-999' };
    assert.throws(() => rowToMessage(moved, ON), FieldDecryptError);
});

test('the same conversation decrypts regardless of which user reads it', () => {
    // The old scheme bound AAD to the requesting user, so a shared or
    // admin-viewed conversation failed its check and read back as empty.
    const rows = messagesToRows(CONV, 'agent', SAMPLE, ON);
    const asAnotherReader = { key: DEK, encryptMessages: true, encryptMeta: true, tier: 'managed' };
    assert.strictEqual(rowToMessage(rows[0], asAnotherReader).content, SAMPLE[0].content);
});

test('different conversations derive different keys from one DEK', () => {
    const a = messagesToRows('conv-a', 'agent', SAMPLE, ON);
    const b = messagesToRows('conv-b', 'agent', SAMPLE, ON);
    assert.notStrictEqual(a[0].content, b[0].content);
    assert.throws(() => rowToMessage({ ...a[0], conversation_id: 'conv-b' }, ON), FieldDecryptError);
});

test('empty message list produces no rows', () => {
    assert.deepStrictEqual(messagesToRows(CONV, 'agent', [], ON), []);
});

// ── Content encoding: the round-trip must be lossless ───────────────────────
//
// The writer used to store a string verbatim while the reader JSON.parsed
// everything and kept whatever was not a string. Any message text that happened
// to BE valid JSON for a non-string value therefore came back as that value —
// and a serialized tool result is exactly that. One such message in the history
// 400'd every later turn on the OpenAI-compatible providers ("Invalid type for
// 'messages[N].content' … got an object instead") and bricked the conversation.

const TOOL_RESULT_JSON = '{"sent":true,"runId":"run_9f2","to":"[email_1]"}';

test('a tool result that is serialized JSON reads back as the SAME string', () => {
    const msgs = [{ role: 'tool', content: TOOL_RESULT_JSON, tool_call_id: 'call_1' }];
    for (const ctx of [OFF, ON]) {
        const back = roundTrip(msgs, ctx);
        assert.strictEqual(typeof back[0].content, 'string', 'must not be revived as an object');
        assert.strictEqual(back[0].content, TOOL_RESULT_JSON);
    }
});

test('message text that merely looks like JSON stays text', () => {
    // Every one of these used to come back as a number/boolean/object/array.
    for (const text of ['42', 'true', 'false', '[1,2]', '{"a":1}', '3.14', '"quoted"']) {
        const back = roundTrip([{ role: 'user', content: text }], ON);
        assert.strictEqual(back[0].content, text, `${text} should survive as a string`);
        assert.strictEqual(typeof back[0].content, 'string');
    }
});

test('a user message reading exactly "null" is text, not null', () => {
    const back = roundTrip([{ role: 'user', content: 'null' }], ON);
    assert.strictEqual(back[0].content, 'null');
});

test('genuine null content (assistant with only tool_calls) round-trips as null', () => {
    const msgs = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] }];
    const back = roundTrip(msgs, ON);
    assert.strictEqual(back[0].content, null);
    assert.deepStrictEqual(back[0].tool_calls, msgs[0].tool_calls);
});

test('the encoding marker never leaks onto the message object', () => {
    const back = roundTrip([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ON);
    assert.ok(!('_contentJson' in back[0]), 'the marker describes the row, not the message');
});

test('legacy rows (no marker) still revive real block arrays, not objects', () => {
    // Written the way the store did before the marker existed: JSON in the
    // column, nothing in meta_json to say so.
    const legacy = (raw) => rowToMessage({
        id: 'm1', conversation_id: CONV, conversation_type: 'agent', role: 'user',
        content: raw, tool_name: null, meta_json: '{}', seq: 0,
    });
    assert.deepStrictEqual(
        legacy('[{"type":"text","text":"hi"}]').content,
        [{ type: 'text', text: 'hi' }],
        'multimodal turns from before the fix must still render'
    );
    assert.strictEqual(legacy('null').content, null);
    assert.strictEqual(legacy(TOOL_RESULT_JSON).content, TOOL_RESULT_JSON, 'the poisoned case is repaired on read');
    assert.strictEqual(legacy('[1,2,3]').content, '[1,2,3]', 'an array of non-blocks is not content blocks');
});
