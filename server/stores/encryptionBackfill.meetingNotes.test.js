/**
 * The meeting-notes surface of stores/encryptionBackfill.js ("transcripts"), sealed through the
 * module's stores/transcriptCrypto.js. Moved out of encryptionBackfill.test.js unchanged: it
 * needs the module's file (without the module the surface is skipped).
 *
 * Run: cd server && node --test stores/encryptionBackfill.meetingNotes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const { backfillOrg } = require('./encryptionBackfill');
const { decryptField, isEnvelope } = require('./lib/fieldEnvelope');
const { fakeDeps } = require('./encryptionBackfill.testkit');

test('transcripts: columns and previews sealed via transcriptCrypto, jsonb CAS', async () => {
    const tc = require('./transcriptCrypto');
    const orgKey = crypto.randomBytes(32);
    const tctx = { key: orgKey, encrypt: true, tier: 'managed' };
    const deps = fakeDeps({ tables: { transcriptions: [{
        id: 't1', full_text: 'we fire Jansen', transcript: 'x', summary: 'sum', segments: [{ t: 1 }],
        speakers: [], attendees: ['Jansen'], chapters: [], full_text_snippet_enc: null, summary_snippet_enc: 'sum',
    }] } });
    deps.resolveTranscriptCrypto = async () => tctx;
    const res = await backfillOrg('o1', { surfaces: ['transcripts'], deps });
    assert.deepStrictEqual(res.surfaces.transcripts, { encrypted: 1, skipped: 0, noKey: 0, failed: 0 });
    const u = deps.updates[0];
    assert.match(u.sql, /segments = \$\d+::jsonb/);
    assert.match(u.sql, /segments IS NOT DISTINCT FROM \$\d+::jsonb/);
    assert.doesNotMatch(u.sql, /speakers =/); // empty array: nothing to protect
    assert.doesNotMatch(u.sql, /action_items/);
    const idx = (col) => u.sql.match(new RegExp(`${col} = \\$(\\d+)`))[1] - 1;
    const full = u.params[idx('full_text')];
    assert.strictEqual(decryptField(full, { key: tc.keyFor(tctx, 't1'), aad: tc.columnAad('t1', 'full_text') }), 'we fire Jansen');
    const snip = u.params[idx('full_text_snippet_enc')];
    assert.strictEqual(tc.readSnippet({ id: 't1', full_text_snippet_enc: snip }, tctx), 'we fire Jansen');
    assert.ok(isEnvelope(u.params[idx('summary_snippet_enc')])); // plaintext preview sealed too
});

test('transcripts: org without a usable key reports noKey for every row', async () => {
    const deps = fakeDeps({ tables: { transcriptions: [{ id: 't1' }, { id: 't2' }] } });
    deps.resolveTranscriptCrypto = async () => ({ key: null, encrypt: false, tier: 'managed' });
    const res = await backfillOrg('o1', { surfaces: ['transcripts'], deps });
    assert.strictEqual(res.surfaces.transcripts.noKey, 2);
    assert.strictEqual(deps.updates.length, 0);
});
