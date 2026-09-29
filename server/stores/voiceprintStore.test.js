/**
 * Voiceprint store — encryption at rest and the read boundary.
 *
 * The two properties that matter:
 *   - the template is encrypted under the ORG's vault key (MASTER_ENCRYPTION_KEY
 *     derived), not a global one, and never returned by the metadata reader;
 *   - a template that cannot be decrypted is SKIPPED, not thrown — a botched
 *     key rotation must cost one person their name, never a whole meeting.
 *
 * ../db is stubbed with an in-memory table.
 * Run: cd server && node --test stores/voiceprintStore.test.js
 */

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-key-at-least-32-chars-long';

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Minimal in-memory stand-in: enough to exercise the UPSERT semantics and the
// SELECT-by-id path without a Postgres.
const rows = [];
const sqlLog = [];

stub('../db', {
    exec: async () => {},
    run: async (sql, params) => {
        sqlLog.push(sql);
        if (/^\s*INSERT INTO voiceprints/i.test(sql)) {
            const [id, userId, orgId, provider, ...rest] = params;
            const existing = rows.find(r => r.user_id === userId && r.provider === provider);
            const row = existing || { id, user_id: userId, provider };
            row.organization_id = orgId;
            // Which statement is this? Match the INSERT COLUMN LIST, not any
            // mention of the column — markPending's ON CONFLICT clause now
            // references voiceprint_enc inside a CASE, and a loose /voiceprint_enc/
            // test silently misread its parameters as an upsert's.
            const isUpsert = /INSERT INTO voiceprints \([^)]*\bvoiceprint_enc\b/is.test(sql);
            if (isUpsert) {
                row.model = rest[0];
                row.voiceprint_enc = rest[1];
                row.voiceprint_chars = rest[2];
                row.duration_seconds = rest[3];
                row.language = rest[4];
                row.status = 'ready';
            } else {
                row.language = rest[0];
                // Mirrors the real CASE: a retake by someone who already has a
                // working template must NOT drop them to 'pending'.
                row.status = row.voiceprint_enc ? 'ready' : 'pending';
            }
            if (!existing) rows.push(row);
            return { rowCount: 1 };
        }
        if (/^\s*UPDATE voiceprints/i.test(sql)) {
            // markFailed. Mirrors the real CASE: never clears the template.
            const [userId, provider, errorCode] = params;
            const row = rows.find(r => r.user_id === userId && r.provider === provider);
            if (!row) return { rowCount: 0 };
            row.status = row.voiceprint_enc ? 'ready' : 'failed';
            row.error_code = errorCode;
            return { rowCount: 1 };
        }
        if (/^\s*DELETE FROM voiceprints WHERE user_id/i.test(sql)) {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === params[0]) rows.splice(i, 1);
            return { rowCount: before - rows.length };
        }
        if (/^\s*DELETE FROM voiceprints WHERE organization_id/i.test(sql)) {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].organization_id === params[0]) rows.splice(i, 1);
            return { rowCount: before - rows.length };
        }
        return { rowCount: 0 };
    },
    getOne: async (sql, params) => rows.find(r => r.user_id === params[0] && r.provider === params[1]) || null,
    getAll: async (sql, params) => {
        if (/id = ANY/.test(sql)) return rows.filter(r => params[0].includes(r.id));
        return [];
    },
});

const store = require('./voiceprintStore');
const orgVault = require('./orgVault');

const CONSENT = { at: new Date(), version: 1, ip: '203.0.113.9', userAgent: 'test' };

test.beforeEach(() => { rows.length = 0; sqlLog.length = 0; });

test('the template is encrypted at rest under the org key, never stored raw', async () => {
    await store.upsertVoiceprint({
        userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'VEVNUExBVEU=', consent: CONSENT,
    });
    const stored = rows[0].voiceprint_enc;
    assert.ok(!stored.includes('VEVNUExBVEU='), 'the raw template must not be in the column');
    assert.strictEqual(orgVault.decrypt(stored, 'org-1'), 'VEVNUExBVEU=');
});

test('another org\'s key cannot decrypt it (per-org blast radius)', async () => {
    await store.upsertVoiceprint({
        userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'VEVNUExBVEU=', consent: CONSENT,
    });
    assert.strictEqual(orgVault.decrypt(rows[0].voiceprint_enc, 'org-2'), null);
});

test('getVoiceprintForUser returns metadata only — never the template', async () => {
    await store.upsertVoiceprint({
        userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'VEVNUExBVEU=', durationSeconds: 25, consent: CONSENT,
    });
    const meta = await store.getVoiceprintForUser('u1');
    assert.strictEqual(meta.status, 'ready');
    assert.strictEqual(meta.durationSeconds, 25);
    assert.ok(!('voiceprint' in meta) && !('voiceprint_enc' in meta) && !('voiceprintEnc' in meta));
    assert.ok(!JSON.stringify(meta).includes('VEVNUExBVEU='));
});

test('re-recording replaces the template rather than accumulating history', async () => {
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'Rklstw==', consent: CONSENT });
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'U0VDT05E', consent: CONSENT });
    assert.strictEqual(rows.length, 1, 'one row per (user, provider) — no biometric history to leak');
    assert.strictEqual(orgVault.decrypt(rows[0].voiceprint_enc, 'org-1'), 'U0VDT05E');
});

test('loadVoiceprintBlobs decrypts only the requested ids', async () => {
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'QUFB', consent: CONSENT });
    await store.upsertVoiceprint({ userId: 'u2', organizationId: 'org-1', voiceprintBase64: 'QkJC', consent: CONSENT });
    const wanted = rows[1].id;
    const out = await store.loadVoiceprintBlobs([wanted], 'org-1');
    assert.deepStrictEqual(out.map(o => o.voiceprint), ['QkJC']);
});

test('an undecryptable row is SKIPPED, never thrown — one lost name, not a lost meeting', async () => {
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'QUFB', consent: CONSENT });
    await store.upsertVoiceprint({ userId: 'u2', organizationId: 'org-1', voiceprintBase64: 'QkJC', consent: CONSENT });
    rows[0].voiceprint_enc = 'not-an-envelope';   // e.g. written under a rotated master key
    const out = await store.loadVoiceprintBlobs(rows.map(r => r.id), 'org-1');
    assert.deepStrictEqual(out.map(o => o.voiceprint), ['QkJC']);
});

test('markPending leaves a visible, template-free row so a crash is explainable', async () => {
    await store.markPending({ userId: 'u1', organizationId: 'org-1', consent: CONSENT });
    const meta = await store.getVoiceprintForUser('u1');
    assert.strictEqual(meta.status, 'pending');
    assert.ok(!rows[0].voiceprint_enc);
});

// ── A failed RETAKE must never cost you the profile you had ──────────

test('REGRESSION: a failed retake keeps the existing template intact', async () => {
    // This used to NULL voiceprint_enc, so a user with a working profile who
    // tapped "record again" and stopped two seconds early lost it to a plain
    // 400 — no history row, no undo.
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'R09PRA==', consent: CONSENT });

    await store.markPending({ userId: 'u1', organizationId: 'org-1', consent: CONSENT });
    await store.markFailed('u1', 'pyannote', 'too_short');

    const blobs = await store.loadVoiceprintBlobs([rows[0].id], 'org-1');
    assert.deepStrictEqual(blobs.map(b => b.voiceprint), ['R09PRA=='], 'the working template must survive');
    const meta = await store.getVoiceprintForUser('u1');
    assert.strictEqual(meta.status, 'ready', 'and the user stays enrolled, so meetings still match them');
    assert.strictEqual(meta.errorCode, 'too_short', 'while still surfacing why the retake failed');
});

test('a retake keeps you matchable while it is in flight', async () => {
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'R09PRA==', consent: CONSENT });
    await store.markPending({ userId: 'u1', organizationId: 'org-1', consent: CONSENT });
    const meta = await store.getVoiceprintForUser('u1');
    assert.strictEqual(meta.status, 'ready', 'a retake must not un-enrol you for the duration of the job');
});

test('a FIRST-TIME failure still reports failed — there is nothing to protect', async () => {
    await store.markPending({ userId: 'u2', organizationId: 'org-1', consent: CONSENT });
    await store.markFailed('u2', 'pyannote', 'too_quiet');
    const meta = await store.getVoiceprintForUser('u2');
    assert.strictEqual(meta.status, 'failed');
    assert.strictEqual(meta.errorCode, 'too_quiet');
});

test('a successful retake replaces the template', async () => {
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'T0xE', consent: CONSENT });
    await store.markPending({ userId: 'u1', organizationId: 'org-1', consent: CONSENT });
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'TkVX', consent: CONSENT });
    const blobs = await store.loadVoiceprintBlobs([rows[0].id], 'org-1');
    assert.deepStrictEqual(blobs.map(b => b.voiceprint), ['TkVX']);
});

test('an empty template is refused rather than silently stored', async () => {
    await assert.rejects(() => store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: '', consent: CONSENT }));
    await assert.rejects(() => store.upsertVoiceprint({ userId: 'u1', voiceprintBase64: 'QUFB', consent: CONSENT }), /organizationId/);
});

test('delete removes the row for a user and for a whole org', async () => {
    await store.upsertVoiceprint({ userId: 'u1', organizationId: 'org-1', voiceprintBase64: 'QUFB', consent: CONSENT });
    await store.upsertVoiceprint({ userId: 'u2', organizationId: 'org-1', voiceprintBase64: 'QkJC', consent: CONSENT });
    assert.strictEqual(await store.deleteVoiceprintForUser('u1'), true);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(await store.deleteVoiceprintsForOrg('org-1'), 1);
    assert.strictEqual(rows.length, 0);
});
