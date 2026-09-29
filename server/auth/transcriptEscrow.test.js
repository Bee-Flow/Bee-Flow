const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'c'.repeat(64);

const {
    transcriptDekAad, getTranscriptDek, transcriptionKey,
    rewrapForRotation, invalidateTranscriptKeyCache,
} = require('./transcriptEscrow');
const { wrapDEK, unwrapDEK } = require('./encryption');

const ORK = crypto.randomBytes(32);

/** A stand-in for the organizations row plus the db helpers that reach it. */
function db(initialDek = null) {
    const state = { dek: initialDek, updates: [] };
    return {
        state,
        getOne: async () => ({ dek: state.dek }),
        run: async (sql, params) => {
            // Mirror the `AND col IS NULL` guard the real UPDATE carries.
            if (sql.includes('IS NULL') && state.dek) return;
            state.dek = params[0];
            state.updates.push(params[0]);
        },
        getOrgRootKey: async () => ORK,
    };
}

test('mints and stores a DEK on first use, then reuses it', async () => {
    invalidateTranscriptKeyCache();
    const d = db();
    const first = await getTranscriptDek('acme', d);
    assert.ok(Buffer.isBuffer(first) && first.length === 32);
    assert.strictEqual(d.state.updates.length, 1, 'exactly one mint');

    invalidateTranscriptKeyCache();
    const second = await getTranscriptDek('acme', d);
    assert.ok(second.equals(first), 'the stored DEK must be reused, not replaced');
    assert.strictEqual(d.state.updates.length, 1, 'a second call must not mint again');
});

test('the stored envelope is openable with the org root key and its AAD', async () => {
    invalidateTranscriptKeyCache();
    const d = db();
    const dek = await getTranscriptDek('acme', d);
    const opened = unwrapDEK(JSON.parse(d.state.dek), ORK, transcriptDekAad('acme'));
    assert.ok(opened.equals(dek));
});

test('returns null — and never mints a replacement — when the stored DEK will not open', async () => {
    // Minting here would be the worst possible response: every existing
    // transcription becomes permanently unreadable while the org sees no error.
    invalidateTranscriptKeyCache();
    const wrongOrk = crypto.randomBytes(32);
    const d = db(JSON.stringify(wrapDEK(crypto.randomBytes(32), wrongOrk, transcriptDekAad('acme'))));
    const before = d.state.dek;
    const out = await getTranscriptDek('acme', d);
    assert.strictEqual(out, null);
    assert.strictEqual(d.state.dek, before, 'the unopenable envelope must be left exactly as it was');
    assert.strictEqual(d.state.updates.length, 0);
});

test('returns null when the org has no root key', async () => {
    invalidateTranscriptKeyCache();
    const d = db();
    d.getOrgRootKey = async () => null;
    assert.strictEqual(await getTranscriptDek('acme', d), null);
    assert.strictEqual(d.state.updates.length, 0);
});

test('returns null without an org id', async () => {
    for (const bad of [null, undefined, '', '   ', 0]) {
        assert.strictEqual(await getTranscriptDek(bad, db()), null, `for ${JSON.stringify(bad)}`);
    }
});

test('returns null rather than throwing when the read fails', async () => {
    invalidateTranscriptKeyCache();
    const d = db();
    d.getOne = async () => { throw new Error('db down'); };
    assert.strictEqual(await getTranscriptDek('acme', d), null);
});

test('a concurrent mint adopts the winner, never its own losing key', async () => {
    // Two workers mint at once; only one UPDATE survives the `IS NULL` guard.
    // Writing under the key that LOST would produce ciphertext the winner
    // cannot open — so the loser must re-read and adopt the stored one.
    invalidateTranscriptKeyCache();
    const winnerDek = crypto.randomBytes(32);
    const winnerEnvelope = JSON.stringify(wrapDEK(winnerDek, ORK, transcriptDekAad('acme')));
    const d = db();
    let reads = 0;
    d.getOne = async () => {
        reads += 1;
        // First read: empty, so this caller mints. Its UPDATE is swallowed by
        // the IS NULL guard because the other worker got there first.
        return reads === 1 ? { dek: null } : { dek: winnerEnvelope };
    };
    d.run = async () => { /* lost the race — the guard rejected it */ };
    const got = await getTranscriptDek('acme', d);
    assert.ok(got && got.equals(winnerDek), 'must adopt the stored key, not the one it minted');
});

test('per-transcription keys differ, and are stable for the same id', () => {
    const dek = crypto.randomBytes(32);
    const a1 = transcriptionKey(dek, 't-1');
    const a2 = transcriptionKey(dek, 't-1');
    const b = transcriptionKey(dek, 't-2');
    assert.ok(a1.equals(a2), 'same id must derive the same key');
    assert.ok(!a1.equals(b), 'a leaked per-transcription key must not open the archive');
    assert.ok(!a1.equals(dek), 'the org DEK must never be used directly');
});

test('rewrapForRotation moves the DEK to the new root key without changing its value', async () => {
    invalidateTranscriptKeyCache();
    const d = db();
    const dek = await getTranscriptDek('acme', d);
    const newOrk = crypto.randomBytes(32);

    const sealed = await rewrapForRotation('acme', ORK, newOrk, d);
    assert.ok(typeof sealed === 'string');
    const opened = unwrapDEK(JSON.parse(sealed), newOrk, transcriptDekAad('acme'));
    assert.ok(opened.equals(dek), 'the DEK value must survive a rotation');
    assert.strictEqual(unwrapDEK(JSON.parse(sealed), ORK, transcriptDekAad('acme')), null,
        'the old root key must no longer open it');
});

test('rewrapForRotation returns null when there is nothing to rewrap', async () => {
    const d = db();
    assert.strictEqual(await rewrapForRotation('acme', ORK, crypto.randomBytes(32), d), null);
});

test('rewrapForRotation THROWS when the DEK will not open', async () => {
    // The caller (orgEscrow.rotateOrgRootKey) aborts the whole rotation on
    // this. Returning null instead would let the rotation proceed and strand
    // every transcription in the organisation.
    const d = db(JSON.stringify(wrapDEK(crypto.randomBytes(32), crypto.randomBytes(32), transcriptDekAad('acme'))));
    await assert.rejects(
        () => rewrapForRotation('acme', ORK, crypto.randomBytes(32), d),
        /could not be rewrapped/,
    );
});

test('rotateOrgRootKey aborts the whole rotation when the transcript DEK is stranded', async () => {
    // Pins the wiring, not just the helper: the throw has to reach the caller
    // BEFORE the new ORK is written, or the org rotates into an unreadable
    // transcription archive.
    const whole = require('fs').readFileSync(require('path').join(__dirname, 'orgEscrow.js'), 'utf8');
    // Scope to the rotation function: `SET "org_root_key"` also appears
    // elsewhere in this file, and measuring against that occurrence would make
    // this test pass no matter where the rewrap sat.
    const start = whole.indexOf('async function rotateOrgRootKey');
    assert.ok(start > 0, 'rotateOrgRootKey must exist');
    const body = whole.slice(start);
    const rewrapAt = body.indexOf('rewrapForRotation');
    const orkWriteAt = body.indexOf('SET \"org_root_key\"');
    assert.ok(rewrapAt > 0, 'rotateOrgRootKey must rewrap the transcript DEK');
    assert.ok(orkWriteAt > 0, 'rotateOrgRootKey must write the new org root key');
    assert.ok(rewrapAt < orkWriteAt,
        'the transcript DEK must be rewrapped BEFORE the new org root key is written');
});
