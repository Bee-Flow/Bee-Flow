// @typecheck
'use strict';

/**
 * Envelope helpers and the pass runner of scripts/rotateMasterKey.js, moved
 * here verbatim to keep that script under the file-size budget. No database,
 * no side effects: server/stores/keyRotationEnvelopes.test.js pins every
 * derivation here against the store modules it mirrors.
 */

const crypto = require('crypto');

const ORG_KEY_PREFIX_RE = /^org_([^_]+)_/;

function inferOrgIdFromKey(key) {
    const m = key && key.match(ORG_KEY_PREFIX_RE);
    return m ? m[1] : null;
}

function deriveKey(master, orgId = null) {
    const info = orgId
        ? `beeflow:config-secrets:v1:${orgId}`
        : 'beeflow:config-secrets:v1';
    return crypto.createHmac('sha256', master).update(info).digest();
}

// ── Sibling envelope schemes ────────────────────────────────────────
// Must stay byte-identical to their source modules, or a rotation writes
// ciphertext the app can't read. Pinned by server/stores/keyRotationEnvelopes.test.js.

// server/stores/orgVault.js — integration_connections + automation_credentials.
const ORG_VAULT_TAG = 'routine-vault-v1';
const DEFAULT_ORG_SENTINEL = '__default_org__';
function deriveOrgVaultKey(master, orgId) {
    return crypto.createHmac('sha256', master)
        .update(`beeflow:routine-vault:v1:org:${orgId}`)
        .digest();
}
// What builds from 2026-10-04 until the fix derived (orgVault.js MISDERIVED_LABEL).
// Read-only: a row sealed that way is rotated onto the right label.
function deriveMisderivedOrgVaultKey(master, orgId) {
    return crypto.createHmac('sha256', master)
        .update(`beeflow:automation-vault:v1:org:${orgId}`)
        .digest();
}

// server/stores/userStore.js — users."appPassword".
const APP_PWD_TAG = 'appcred-v1';
function deriveAppPwdKey(master) {
    return crypto.createHmac('sha256', master).update('beeflow:app-password:v1').digest();
}
// Pre-domain-separation derivation, kept so v1 rows rotate straight to v2.
function deriveLegacyAppPwdKey(master) {
    return crypto.createHash('sha256').update(master).digest();
}

function encryptTagged(plaintext, key, tag) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({
        _encrypted: tag,
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        data: enc.toString('hex'),
    });
}

function tryDecrypt(envelope, key) {
    try {
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (_) {
        return null;
    }
}

function encrypt(plaintext, key, orgId = null) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const env = {
        _encrypted: 'config-v1',
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        data: enc.toString('hex'),
    };
    if (orgId) env.keyContext = orgId;
    return JSON.stringify(env);
}

// A pass that finds its table/column absent (older schema) has nothing to
// rotate and is skipped quietly. ANY other error (dropped connection, statement
// timeout, a failing UPDATE) means rows were left under the OLD master: the
// pass is counted as aborted and the script must exit non-zero, or the operator
// promotes NEW over a table split across two masters.
// pg codes: 42P01 undefined_table, 42703 undefined_column.
function isMissingSchemaError(e) {
    return !!e && (e.code === '42P01' || e.code === '42703');
}

function createPassRunner(logger = console) {
    const state = { aborted: 0, abortedLabels: [] };
    async function runPass(label, fn) {
        try {
            await fn();
        } catch (e) {
            if (isMissingSchemaError(e)) {
                logger.log(`[rotate] ${label}: not present on this schema, skipped.`);
                return;
            }
            logger.error(`[rotate] ${label} pass ABORTED mid-rotation: ${e && e.message}`);
            state.aborted++;
            state.abortedLabels.push(label);
        }
    }
    return { runPass, state };
}

module.exports = {
    inferOrgIdFromKey,
    deriveKey,
    ORG_VAULT_TAG,
    DEFAULT_ORG_SENTINEL,
    deriveOrgVaultKey,
    deriveMisderivedOrgVaultKey,
    APP_PWD_TAG,
    deriveAppPwdKey,
    deriveLegacyAppPwdKey,
    encryptTagged,
    tryDecrypt,
    encrypt,
    isMissingSchemaError,
    createPassRunner,
};
