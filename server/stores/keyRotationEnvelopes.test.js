/**
 * Pins scripts/rotate-master-key.js to the envelope schemes it rotates.
 *
 * The rotation script re-implements each key derivation (it must run against a
 * DB with the OLD master in env while deriving the NEW one, so it cannot just
 * call the store modules). If a derivation there ever drifts from its source,
 * a rotation writes ciphertext the application cannot read — and nothing fails
 * loudly: decrypt() returns null, so the damage only surfaces later as
 * "integration disconnected" for every user at once, with no way back.
 *
 * These tests round-trip real store ciphertext through the script's helpers
 * and back, which is exactly what a rotation does.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const OLD_MASTER = 'a'.repeat(64);
const NEW_MASTER = 'b'.repeat(64);

process.env.MASTER_ENCRYPTION_KEY = OLD_MASTER;

const rotate = require('../../scripts/rotate-master-key');
const orgVault = require('./orgVault');

test('orgVault: script derivation matches the store, and a rotation round-trips', () => {
    const orgId = 'org-42';
    const payload = { token: 'nc-app-password-value', scope: 'files' };

    // Sealed by the REAL store under the old master.
    const sealed = orgVault.encryptJSON(payload, orgId);
    const envelope = JSON.parse(sealed);
    assert.strictEqual(envelope._encrypted, rotate.ORG_VAULT_TAG,
        'script must look for the tag orgVault actually writes');

    // The script decrypts it with its own derivation…
    const keyOld = rotate.deriveOrgVaultKey(OLD_MASTER, orgId);
    const plaintext = rotate.tryDecrypt(envelope, keyOld);
    assert.notStrictEqual(plaintext, null, 'script could not decrypt store ciphertext');
    assert.deepStrictEqual(JSON.parse(plaintext), payload);

    // …re-seals under the new master…
    const keyNew = rotate.deriveOrgVaultKey(NEW_MASTER, orgId);
    const reSealed = rotate.encryptTagged(plaintext, keyNew, rotate.ORG_VAULT_TAG);

    // …and the REAL store can read the result once the master is promoted.
    process.env.MASTER_ENCRYPTION_KEY = NEW_MASTER;
    try {
        assert.deepStrictEqual(orgVault.decryptJSON(reSealed, orgId), payload,
            'store cannot read what the rotation wrote — rotation would be data loss');
    } finally {
        process.env.MASTER_ENCRYPTION_KEY = OLD_MASTER;
    }
});

test('orgVault: org-less rows use the same sentinel as the connection store', () => {
    const store = require('./integrationConnectionStore');
    assert.strictEqual(rotate.DEFAULT_ORG_SENTINEL, store.DEFAULT_ORG_SENTINEL,
        'a different sentinel would derive a different key for every org-less row');
    assert.strictEqual(store.resolveOrgId(''), rotate.DEFAULT_ORG_SENTINEL);
    assert.strictEqual(store.resolveOrgId(null), rotate.DEFAULT_ORG_SENTINEL);
});

test('orgVault: keys are per-org (a rotation must not cross org rows)', () => {
    const a = rotate.deriveOrgVaultKey(OLD_MASTER, 'org-a');
    const b = rotate.deriveOrgVaultKey(OLD_MASTER, 'org-b');
    assert.notDeepStrictEqual(a, b);
    const sealed = JSON.parse(orgVault.encryptJSON({ x: 1 }, 'org-a'));
    assert.strictEqual(rotate.tryDecrypt(sealed, b), null, 'org-b key must not open an org-a row');
});

test('appPassword: script derivation matches userStore v2 and upgrades v1 rows', () => {
    // v2 (domain-separated) — what userStore writes today.
    const expectedV2 = crypto.createHmac('sha256', OLD_MASTER).update('beeflow:app-password:v1').digest();
    assert.deepStrictEqual(rotate.deriveAppPwdKey(OLD_MASTER), expectedV2);

    // v1 (bare sha256) — rows written before the derivation was hardened.
    const expectedV1 = crypto.createHash('sha256').update(OLD_MASTER).digest();
    assert.deepStrictEqual(rotate.deriveLegacyAppPwdKey(OLD_MASTER), expectedV1);
    assert.notDeepStrictEqual(expectedV1, expectedV2, 'v1 and v2 must derive different keys');

    // A v1 blob (untagged) still rotates forward into the tagged v2 envelope.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', expectedV1, iv);
    const enc = Buffer.concat([cipher.update('secret-app-pw', 'utf8'), cipher.final()]);
    const legacyRow = {
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        data: enc.toString('hex'),
    };
    assert.strictEqual(rotate.tryDecrypt(legacyRow, expectedV1), 'secret-app-pw');

    const rotated = JSON.parse(rotate.encryptTagged('secret-app-pw', rotate.deriveAppPwdKey(NEW_MASTER), rotate.APP_PWD_TAG));
    assert.strictEqual(rotated._encrypted, rotate.APP_PWD_TAG,
        'rotated rows must carry the tag so the NEXT rotation can find them');
    assert.strictEqual(rotate.tryDecrypt(rotated, rotate.deriveAppPwdKey(NEW_MASTER)), 'secret-app-pw');
});

test('config-v1 derivation is unchanged (regression guard on the original pass)', () => {
    assert.deepStrictEqual(
        rotate.deriveKey(OLD_MASTER, null),
        crypto.createHmac('sha256', OLD_MASTER).update('beeflow:config-secrets:v1').digest()
    );
    assert.deepStrictEqual(
        rotate.deriveKey(OLD_MASTER, 'org-9'),
        crypto.createHmac('sha256', OLD_MASTER).update('beeflow:config-secrets:v1:org-9').digest()
    );
});

/**
 * The two columns below were sealed with orgVault and were not in the script's
 * inventory. Round-tripping them is worth something, but the test that matters
 * is the sweep at the end: this is the third time an envelope was added to the
 * product and not to the rotation, and each time it was found by reading rather
 * than by anything failing.
 */

test('orgEscrow: the org root key round-trips through a rotation', () => {
    // Not a credential — this row wraps every user DEK in the org, so a
    // rotation that skips it does not lose one integration, it loses the org's
    // whole encrypted history at once.
    const orgId = 'org-escrow-1';
    const ork = crypto.randomBytes(32).toString('base64');

    const sealed = orgVault.encrypt(ork, orgId);           // as orgEscrow writes it
    const envelope = JSON.parse(sealed);
    assert.strictEqual(envelope._encrypted, rotate.ORG_VAULT_TAG);

    const plaintext = rotate.tryDecrypt(envelope, rotate.deriveOrgVaultKey(OLD_MASTER, orgId));
    assert.strictEqual(plaintext, ork, 'the script cannot read an org root key');

    const reSealed = rotate.encryptTagged(plaintext, rotate.deriveOrgVaultKey(NEW_MASTER, orgId), rotate.ORG_VAULT_TAG);
    process.env.MASTER_ENCRYPTION_KEY = NEW_MASTER;
    try {
        assert.strictEqual(orgVault.decrypt(reSealed, orgId), ork,
            'after promotion the escrow cannot unwrap its own root key — every DEK in the org is gone');
    } finally {
        process.env.MASTER_ENCRYPTION_KEY = OLD_MASTER;
    }
});

test('voiceprints: the biometric template round-trips through a rotation', () => {
    // GDPR Art. 9 data that cannot be re-derived from anything still held —
    // losing it means every enrolled person has to record their voice again.
    const orgId = 'org-voice-1';
    const template = Buffer.from('fake-voiceprint-template-bytes').toString('base64');

    const sealed = orgVault.encrypt(template, orgId);
    const plaintext = rotate.tryDecrypt(JSON.parse(sealed), rotate.deriveOrgVaultKey(OLD_MASTER, orgId));
    assert.strictEqual(plaintext, template);

    const reSealed = rotate.encryptTagged(plaintext, rotate.deriveOrgVaultKey(NEW_MASTER, orgId), rotate.ORG_VAULT_TAG);
    process.env.MASTER_ENCRYPTION_KEY = NEW_MASTER;
    try {
        assert.strictEqual(orgVault.decrypt(reSealed, orgId), template);
    } finally {
        process.env.MASTER_ENCRYPTION_KEY = OLD_MASTER;
    }
});

test('every orgVault-sealed column in the tree is named in the rotation script', () => {
    // The inventory is prose in a comment and the passes are calls; neither
    // notices a column added elsewhere. This sweeps the tree for files that
    // seal something with orgVault and checks each one is accounted for — so a
    // fourth forgotten envelope fails here, by filename, instead of surfacing
    // as unreadable data after a rotation nobody can undo.
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const REPO = path.resolve(__dirname, '../..');

    const sealers = execFileSync('git', ['grep', '-l', 'orgVault\\.\\(encrypt\\|encryptJSON\\)', '--', 'server/'],
        { cwd: REPO, encoding: 'utf8' })
        .split('\n').filter(Boolean)
        .filter((f) => !f.includes('.test.') && !f.endsWith('stores/orgVault.js'));

    // file → the table the rotation script must name for it.
    const ROTATED_BY = new Map([
        ['server/auth/orgEscrow.js', "table: 'organizations'"],
        ['server/stores/voiceprintStore.js', "table: 'voiceprints'"],
        ['server/stores/integrationConnectionStore.js', "table: 'integration_connections'"],
        ['server/stores/automationCredentialStore.js', "table: 'automation_credentials'"],
    ]);

    // Genuinely textual: the table/column inventory is inline object literals
    // handed to rotateEnvelopeColumn(...) calls inside main(), an imperative
    // script meant to run once against a live production-shaped database —
    // there is no exported registry to check, and calling main() itself
    // would mean actually rotating a database from a unit test. Named
    // `rotateScriptSrc` (not `script`) so the many other assertions below
    // that use the word "script" in their own failure messages do not
    // accidentally collide with this variable.
    const rotateScriptSrc = fs.readFileSync(path.join(REPO, 'scripts/rotate-master-key.js'), 'utf8');
    const unaccounted = sealers.filter((f) => !ROTATED_BY.has(f));
    assert.deepStrictEqual(unaccounted, [],
        'these files seal data with orgVault and are not mapped to a rotation pass. Add the column to '
        + 'scripts/rotate-master-key.js AND to the map in this test, or a master-key rotation silently '
        + 'destroys what they wrote:\n' + unaccounted.join('\n'));

    for (const [file, needle] of ROTATED_BY) {
        if (!sealers.includes(file)) continue;   // the store was removed; the pass may stay
        assert.ok(rotateScriptSrc.includes(needle),
            `${file} seals with orgVault but scripts/rotate-master-key.js has no pass for ${needle}`);
    }
});

test('a MASTER rotation leaves ORK-wrapped keys openable — org_transcript_dek stays off the inventory', () => {
    // organizations.org_transcript_dek is wrapped by the ORG ROOT KEY, not by
    // the master. It is therefore deliberately absent from the rotation
    // script's column list, and this pins WHY that is safe: a master rotation
    // re-seals the org_root_key ENVELOPE while the ORK BYTES inside it stay
    // identical, so every key wrapped under those bytes keeps opening.
    //
    // If someone ever changes the master rotation to mint a fresh ORK instead
    // of re-sealing the existing one, this test fails — and it must, because
    // that change would silently strand every transcription in every org.
    const { wrapDEK, unwrapDEK } = require('../auth/encryption');
    const { transcriptDekAad } = require('../auth/transcriptEscrow');

    const orgId = 'org-transcripts';
    const ork = crypto.randomBytes(32);
    const transcriptDek = crypto.randomBytes(32);
    const sealedDek = JSON.stringify(wrapDEK(transcriptDek, ork, transcriptDekAad(orgId)));

    // The ORK itself is an orgVault envelope, and that IS what rotates.
    const orkEnvelope = JSON.parse(orgVault.encrypt(ork.toString('base64'), orgId));
    const keyOld = rotate.deriveOrgVaultKey(OLD_MASTER, orgId);
    const orkPlain = rotate.tryDecrypt(orkEnvelope, keyOld);
    assert.notStrictEqual(orkPlain, null, 'script could not open the ORK envelope');

    const keyNew = rotate.deriveOrgVaultKey(NEW_MASTER, orgId);
    const reSealed = rotate.encryptTagged(orkPlain, keyNew, rotate.ORG_VAULT_TAG);
    const orkAfter = Buffer.from(rotate.tryDecrypt(JSON.parse(reSealed), keyNew), 'base64');

    assert.ok(orkAfter.equals(ork), 'a master rotation must not change the ORK bytes');
    const opened = unwrapDEK(JSON.parse(sealedDek), orkAfter, transcriptDekAad(orgId));
    assert.ok(opened && opened.equals(transcriptDek),
        'the transcript DEK must still open after a master rotation — it is wrapped by the ORK, not the master');
});

test('the transcript DEK envelope is bound to its organisation', () => {
    // AAD is the reason a DEK lifted from one org's row cannot be opened
    // against another org, even by someone holding both root keys.
    const { wrapDEK, unwrapDEK } = require('../auth/encryption');
    const { transcriptDekAad } = require('../auth/transcriptEscrow');

    const ork = crypto.randomBytes(32);
    const dek = crypto.randomBytes(32);
    const sealed = wrapDEK(dek, ork, transcriptDekAad('org-a'));

    assert.ok(unwrapDEK(sealed, ork, transcriptDekAad('org-a')), 'own org must open it');
    assert.strictEqual(unwrapDEK(sealed, ork, transcriptDekAad('org-b')), null,
        'another org must not open it');
});
