const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    SNIPPET_CHARS, ALL_COLUMNS, PLAINTEXT_CONTEXT, columnAad,
    resolveTranscriptCrypto, keyFor, encryptRow, buildSnippet, actionCounts,
    decryptRow, readSnippet, looksLikeEnvelopeHead,
} = require('./transcriptCrypto');
const { isEnvelope } = require('./lib/fieldEnvelope');
const { SURFACES } = require('./encryptionPolicy');

const DEK = crypto.randomBytes(32);
const ON = { key: DEK, encrypt: true, tier: 'managed' };

const ROW = () => ({
    id: 't-1',
    full_text: 'Anna said the Jansen contract expires in March.',
    transcript: '[00:01] Anna: the contract expires in March',
    summary: 'Contract Jansen expires March.',
    segments: JSON.stringify([{ start: 0, text: 'hello' }]),
    speakers: JSON.stringify([{ id: 1, name: 'Anna Bakker' }]),
    attendees: JSON.stringify(['anna@example.com']),
    chapters: JSON.stringify([{ title: 'Contract Jansen' }]),
});

test('every content column round-trips', () => {
    const plain = ROW();
    const enc = encryptRow('t-1', plain, ON);
    for (const col of ALL_COLUMNS) {
        assert.ok(isEnvelope(enc[col]), `${col} must be an envelope`);
        assert.ok(!String(enc[col]).includes('Anna'), `${col} must not leak plaintext`);
    }
    const back = decryptRow({ ...enc, id: 't-1' }, ON);
    for (const col of ALL_COLUMNS) assert.strictEqual(back[col], plain[col], col);
});

test('a plaintext context leaves every column untouched', () => {
    const plain = ROW();
    const enc = encryptRow('t-1', plain, PLAINTEXT_CONTEXT);
    assert.deepStrictEqual(enc, plain);
});

test('plaintext rows still read after the surface is switched ON', () => {
    // The value decides, not the mode — otherwise turning encryption on would
    // strand everything written before it.
    const back = decryptRow({ ...ROW(), id: 't-1' }, ON);
    assert.strictEqual(back.full_text, ROW().full_text);
});

test('encrypted rows still read after the surface is switched OFF', () => {
    const enc = encryptRow('t-1', ROW(), ON);
    // Encryption is off for writing, but the key is still resolvable for reads.
    const back = decryptRow({ ...enc, id: 't-1' }, { key: DEK, encrypt: false, tier: 'managed' });
    assert.strictEqual(back.full_text, ROW().full_text);
});

test('a column cannot be moved to another row or another column', () => {
    const enc = encryptRow('t-1', ROW(), ON);
    // Same key, different transcription id.
    assert.throws(() => decryptRow({ ...enc, id: 't-2' }, ON), /FIELD_DECRYPT_FAILED|decrypt/i);
    // Same row, wrong column.
    assert.throws(
        () => decryptRow({ id: 't-1', full_text: enc.summary }, ON),
        /FIELD_DECRYPT_FAILED|decrypt/i,
    );
});

test('an unopenable column throws rather than reading empty', () => {
    // updateTranscription writes back what it read. A silent '' would overwrite
    // a meeting's transcript with nothing.
    const enc = encryptRow('t-1', ROW(), ON);
    const otherKey = { key: crypto.randomBytes(32), encrypt: true, tier: 'managed' };
    assert.throws(() => decryptRow({ ...enc, id: 't-1' }, otherKey));
});

test('columns absent from the input are not invented', () => {
    const out = encryptRow('t-1', { summary: 'x' }, ON);
    assert.deepStrictEqual(Object.keys(out), ['summary']);
    const back = decryptRow({ id: 't-1', summary: out.summary }, ON);
    assert.strictEqual(back.summary, 'x');
});

test('null and undefined columns pass through untouched', () => {
    const out = encryptRow('t-1', { summary: null, full_text: undefined }, ON);
    assert.strictEqual(out.summary, null);
    assert.strictEqual(out.full_text, undefined);
    const back = decryptRow({ id: 't-1', summary: null }, ON);
    assert.strictEqual(back.summary, null);
});

test('the snippet is capped, encrypted, and reads back', () => {
    const long = 'x'.repeat(SNIPPET_CHARS + 500);
    const snip = buildSnippet('t-1', long, ON);
    assert.ok(isEnvelope(snip));
    const got = readSnippet({ id: 't-1', full_text_snippet_enc: snip }, ON);
    assert.strictEqual(got.length, SNIPPET_CHARS);
});

test('no snippet is stored for an empty transcript', () => {
    // NULL and "an empty snippet" have to stay distinguishable: a row still
    // being transcribed has no preview yet, and a backfill needs to tell those
    // apart from rows it has already handled.
    assert.strictEqual(buildSnippet('t-1', '', ON), null);
    assert.strictEqual(buildSnippet('t-1', null, ON), null);
    assert.strictEqual(buildSnippet('t-1', undefined, ON), null);
});

test('the legacy SQL preview is used only for rows that have no encrypted one', () => {
    const legacy = 'Anna said the contract expires in March.';
    assert.strictEqual(readSnippet({ id: 't-1', full_text_snippet: legacy }, PLAINTEXT_CONTEXT), legacy);
    // …and the encrypted column wins when both are present.
    const snip = buildSnippet('t-1', 'the real preview', ON);
    assert.strictEqual(
        readSnippet({ id: 't-1', full_text_snippet: legacy, full_text_snippet_enc: snip }, ON),
        'the real preview',
    );
});

test('a truncated envelope is never shown as a preview', () => {
    // LEFT(full_text, 2000) over an encrypted row returns the head of the
    // ciphertext JSON. Showing that would put `{"_bfenc":1,"alg"...` in the UI.
    const enc = encryptRow('t-1', { full_text: 'x'.repeat(9000) }, ON);
    const truncated = String(enc.full_text).slice(0, SNIPPET_CHARS);
    assert.ok(!looksLikeEnvelopeHead('a normal transcript line'), 'plain text must pass');
    assert.ok(looksLikeEnvelopeHead(truncated), 'a truncated envelope must be recognised');
    assert.strictEqual(readSnippet({ id: 't-1', full_text_snippet: truncated }, ON), '');
});

test('an unopenable preview yields an empty string, not a thrown list', () => {
    // One bad row must not fail a whole page of meetings; the detail page still
    // throws, which is where the failure belongs.
    const snip = buildSnippet('t-1', 'preview', ON);
    const wrong = { key: crypto.randomBytes(32), encrypt: true, tier: 'managed' };
    assert.strictEqual(readSnippet({ id: 't-1', full_text_snippet_enc: snip }, wrong), '');
});

test('the SQL-merged columns are deliberately NOT in the encrypted set', () => {
    // action_items, decisions and questions are merged in SQL on write
    // (artifactColumnSql), and jsonb_array_elements cannot walk an envelope.
    // If someone adds one here without moving that merge into Node, the write
    // succeeds and the merge silently starts keeping nothing.
    for (const col of ['action_items', 'decisions', 'questions']) {
        assert.ok(!ALL_COLUMNS.includes(col),
            `${col} is merged in SQL — encrypting it breaks that merge silently`);
    }
    const out = encryptRow('t-1', { action_items: '[{"id":"a"}]' }, ON);
    assert.strictEqual(out.action_items, '[{"id":"a"}]', 'it must pass through untouched');
});

test('action counts are computed from plaintext', () => {
    assert.deepStrictEqual(actionCounts([{ done: false }, { done: true }, {}]), { total: 3, open: 2 });
    assert.deepStrictEqual(actionCounts(JSON.stringify([{ done: 'true' }, { done: 'false' }])), { total: 2, open: 1 });
    assert.deepStrictEqual(actionCounts(null), { total: 0, open: 0 });
    assert.deepStrictEqual(actionCounts('not json'), { total: 0, open: 0 });
    assert.deepStrictEqual(actionCounts({}), { total: 0, open: 0 });
});

test('keyFor derives per transcription, never the org DEK itself', () => {
    const a = keyFor(ON, 't-1');
    const b = keyFor(ON, 't-2');
    assert.ok(!a.equals(b));
    assert.ok(!a.equals(DEK));
    assert.strictEqual(keyFor(ON, null), null);
    assert.strictEqual(keyFor(PLAINTEXT_CONTEXT, 't-1'), null);
});

// ── resolveTranscriptCrypto ────────────────────────────────────────────────

function policyDeps({ enabled = true, surfaceOn = true, dek = DEK, tier = 'managed' } = {}) {
    return {
        resolvePolicy: async () => ({ enabled, tier, scope: null }),
        shouldEncrypt: (_p, surface) => {
            assert.strictEqual(surface, SURFACES.TRANSCRIPTS);
            return surfaceOn;
        },
        getTranscriptDek: async () => dek,
    };
}

test('resolves to encrypting when the org and the surface are both on', async () => {
    const ctx = await resolveTranscriptCrypto('acme', policyDeps());
    assert.strictEqual(ctx.encrypt, true);
    assert.ok(ctx.key.equals(DEK));
});

test('does not encrypt when the org has encryption off', async () => {
    const ctx = await resolveTranscriptCrypto('acme', policyDeps({ enabled: false }));
    assert.strictEqual(ctx.encrypt, false);
    assert.strictEqual(ctx.key, null);
});

test('does not encrypt when this surface is switched off', async () => {
    const ctx = await resolveTranscriptCrypto('acme', policyDeps({ surfaceOn: false }));
    assert.strictEqual(ctx.encrypt, false);
    assert.strictEqual(ctx.tier, 'managed');
});

test('falls back to plaintext — loudly — when the org wants encryption but has no key', async () => {
    const ctx = await resolveTranscriptCrypto('acme', policyDeps({ dek: null }));
    assert.strictEqual(ctx.encrypt, false);
    assert.strictEqual(ctx.key, null);
});

test('a policy failure does not fail the request', async () => {
    const ctx = await resolveTranscriptCrypto('acme', {
        resolvePolicy: async () => { throw new Error('db down'); },
    });
    assert.deepStrictEqual(ctx, PLAINTEXT_CONTEXT);
});

test('the AAD names both the transcription and the column', () => {
    const aad = columnAad('t-1', 'full_text').toString();
    assert.ok(aad.includes('t-1') && aad.includes('full_text'));
    assert.notStrictEqual(columnAad('t-1', 'summary').toString(), aad);
});

// ── the stored summary preview ─────────────────────────────────────────────

const { buildSummarySnippet, readSummarySnippet, SUMMARY_SNIPPET_CHARS } = require('./transcriptCrypto');

test('the summary preview is capped, encrypted, and reads back', () => {
    const snip = buildSummarySnippet('t-1', 'y'.repeat(SUMMARY_SNIPPET_CHARS + 300), ON);
    assert.ok(isEnvelope(snip));
    assert.strictEqual(readSummarySnippet({ id: 't-1', summary_snippet_enc: snip }, ON).length, SUMMARY_SNIPPET_CHARS);
});

test('no summary preview is stored for a note that has none yet', () => {
    assert.strictEqual(buildSummarySnippet('t-1', '', ON), null);
    assert.strictEqual(buildSummarySnippet('t-1', null, ON), null);
});

test('the summary preview does not open under another transcription id', () => {
    const snip = buildSummarySnippet('t-1', 'about the Jansen contract', ON);
    assert.strictEqual(readSummarySnippet({ id: 't-2', summary_snippet_enc: snip }, ON), '');
});

test('the summary preview and the transcript preview are not interchangeable', () => {
    // Both are built from the same per-transcription key; only the AAD keeps
    // them apart. Without it, a summary could be served as a transcript.
    const s1 = buildSummarySnippet('t-1', 'summary text', ON);
    assert.strictEqual(readSnippet({ id: 't-1', full_text_snippet_enc: s1 }, ON), '');
});

test('the legacy SQL summary preview is used only when no stored one exists', () => {
    const legacy = 'A prefix straight from LEFT(summary, 400).';
    assert.strictEqual(readSummarySnippet({ id: 't-1', summary_snippet: legacy }, PLAINTEXT_CONTEXT), legacy);
    const snip = buildSummarySnippet('t-1', 'the stored one', ON);
    assert.strictEqual(
        readSummarySnippet({ id: 't-1', summary_snippet: legacy, summary_snippet_enc: snip }, ON),
        'the stored one',
    );
});

test('a truncated envelope is never shown as a summary preview', () => {
    const enc = encryptRow('t-1', { summary: 'z'.repeat(4000) }, ON);
    const truncated = String(enc.summary).slice(0, SUMMARY_SNIPPET_CHARS);
    assert.strictEqual(readSummarySnippet({ id: 't-1', summary_snippet: truncated }, ON), '');
});

test('a legacy plaintext summary longer than the cap is still cut', () => {
    // The SQL LEFT() does the cutting for rows that have it, but a caller that
    // hands us an uncut value must not slip a whole summary onto a list row.
    const long = 'q'.repeat(2000);
    assert.strictEqual(
        readSummarySnippet({ id: 't-1', summary_snippet: long }, PLAINTEXT_CONTEXT).length,
        SUMMARY_SNIPPET_CHARS,
    );
});
