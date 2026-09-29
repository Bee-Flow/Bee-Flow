// @typecheck
/**
 * Field-level envelope encryption for individual DB columns.
 *
 * One shared shape for every encrypted column (message content, meta_json,
 * pii_token_map), so all of them detect and fail identically.
 *
 * ── Wire format ─────────────────────────────────────────────────────────────
 *
 *   { "_bfenc": 1, "alg": "A256GCM", "iv": <hex>, "tag": <hex>, "ct": <hex> }
 *
 * Stored as a JSON string in a TEXT column, or as the object itself in a JSONB
 * column. Keeping it a JSON OBJECT rather than an opaque base64 string is
 * deliberate: `pii_token_map` is JSONB and its reader branches on
 * `typeof stored === 'object'`. A bare string there would fall through that
 * check silently and every [email_1]-style placeholder in stored messages
 * would become permanently unresolvable, with no error anywhere.
 *
 * ── Reading is format-driven, never mode-driven ─────────────────────────────
 *
 * decryptField() looks at the value, not at any config. Plaintext in, plaintext
 * out. Envelope in, plaintext out. That is what lets an operator turn
 * encryption on or off (or on for only some surfaces) without stranding data
 * written under the previous setting.
 *
 * ── Failure is loud ─────────────────────────────────────────────────────────
 *
 * If a value IS an envelope and we cannot open it, decryptField throws. It must
 * never degrade to `{}` or `''`. The attachment sidecars live in
 * conversation_messages.meta_json, and `mergeAttachmentSidecars` treats an
 * empty sidecar list as "the client copy is authoritative" — so a silent empty
 * result does not merely hide a user's uploads, it destroys the storageKey and
 * extractedText on their next edit or retry.
 */

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const ALG_LABEL = 'A256GCM';
const IV_LEN = 12;          // NIST SP 800-38D
const MARKER = '_bfenc';
const VERSION = 1;

class FieldDecryptError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'FieldDecryptError';
        this.code = 'FIELD_DECRYPT_FAILED';
        if (cause) this.cause = cause;
    }
}

/**
 * Is this value one of our envelopes? Accepts the parsed object or its JSON
 * string form, since TEXT and JSONB columns hand us different things.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnvelope(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value[MARKER] === VERSION && typeof /** @type {any} */ (value).ct === 'string';
    }
    if (typeof value === 'string') {
        // Cheap reject before paying for JSON.parse on every message body.
        if (value.length < 20 || value.charCodeAt(0) !== 123 /* { */) return false;
        if (!value.includes(MARKER)) return false;
        try {
            const parsed = JSON.parse(value);
            return !!parsed && parsed[MARKER] === VERSION && typeof parsed.ct === 'string';
        } catch (_) {
            return false;
        }
    }
    return false;
}

function _toObject(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Encrypt a string under `key`, binding it to `aad`.
 *
 * @param {string} plaintext
 * @param {Buffer} key    32-byte key
 * @param {string|Buffer} aad    context string, bound into the tag (a Buffer is read as its String())
 * @returns {object}      the envelope (caller decides object vs JSON string)
 */
function buildEnvelope(plaintext, key, aad) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
        [MARKER]: VERSION,
        alg: ALG_LABEL,
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        ct: ct.toString('hex'),
    };
}

/**
 * Open an envelope. Throws FieldDecryptError on any failure.
 *
 * @param {object|string} envelope
 * @param {Buffer} key
 * @param {string|Buffer} aad
 * @returns {string} plaintext
 */
function openEnvelope(envelope, key, aad) {
    let env;
    try {
        env = _toObject(envelope);
    } catch (err) {
        throw new FieldDecryptError('Envelope is not valid JSON', err);
    }
    if (!env || env[MARKER] !== VERSION) throw new FieldDecryptError('Not a field envelope');
    if (env.alg && env.alg !== ALG_LABEL) throw new FieldDecryptError(`Unsupported envelope alg: ${env.alg}`);
    if (!key) throw new FieldDecryptError('No key available to open envelope');
    try {
        const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(env.iv, 'hex'));
        decipher.setAAD(Buffer.from(String(aad), 'utf8'));
        decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
        return decipher.update(Buffer.from(env.ct, 'hex'), undefined, 'utf8') + decipher.final('utf8');
    } catch (err) {
        // Wrong key, wrong AAD, or tampered bytes — indistinguishable, and all
        // three must be loud.
        throw new FieldDecryptError('Field decryption failed (wrong key, wrong context, or corrupt data)', err);
    }
}

/**
 * Encrypt when a key is supplied AND the caller's policy says to; otherwise
 * pass the value through untouched.
 *
 * @param {string|null|undefined} plaintext
 * @param {{ key?: Buffer|null, aad?: string|Buffer, encrypt?: boolean, asObject?: boolean }} opts
 * @returns {string|object|null|undefined} storable value
 */
function encryptField(plaintext, opts = {}) {
    const { key = null, aad = '', encrypt = false, asObject = false } = opts;
    if (plaintext === null || plaintext === undefined) return plaintext;
    if (!encrypt || !key) return plaintext;
    const env = buildEnvelope(plaintext, key, aad);
    return asObject ? env : JSON.stringify(env);
}

/**
 * Decrypt if — and only if — the stored value actually is an envelope.
 * Plaintext passes straight through, which is what keeps pre-existing rows
 * readable after encryption is switched on, and post-switch-off rows readable
 * after it is switched back off.
 *
 * @param {string|object|null|undefined} stored
 * @param {{ key?: Buffer|null, aad?: string|Buffer }} opts
 * @returns {string|object|null|undefined}
 * @throws {FieldDecryptError} when the value IS an envelope but cannot be opened
 */
function decryptField(stored, opts = {}) {
    const { key = null, aad = '' } = opts;
    if (stored === null || stored === undefined) return stored;
    if (!isEnvelope(stored)) return stored;
    return openEnvelope(stored, key, aad);
}

module.exports = {
    MARKER,
    VERSION,
    FieldDecryptError,
    isEnvelope,
    buildEnvelope,
    openEnvelope,
    encryptField,
    decryptField,
};
