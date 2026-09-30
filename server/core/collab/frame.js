// @typecheck
/**
 * How co-editing bytes are stored: every Yjs update, snapshot and checkpoint
 * state is a FRAME — one header byte, then the payload — sealed with a key
 * derived from the project key.
 *
 *   0x00  plaintext      never written; refused on read (see below)
 *   0x01  AES-256-GCM v1 iv(12) || tag(16) || ciphertext
 *
 * ── Which key, and what that means ──────────────────────────────────────────
 *
 *   project key ──HKDF(salt, "beeflow:collab-doc:v1:<docId>")──▶ document key
 *
 * The project key is `auth/projectEscrow.getProjectKey`: every member, the
 * server-side materialiser, the AI and the server operator can open it — the
 * same stated trade team chats and shared threads make (header of
 * auth/projectEscrow.js). A separate salt and info string keep this hierarchy
 * from ever deriving a team-chat or conversation key.
 *
 * The AAD binds each frame to its place: `<docId>:<seq>` for an update,
 * `<docId>:snapshot:<seq>` for a snapshot, `<docId>:checkpoint:<seq>` for the
 * state kept at the last version. A frame copied onto another row, another
 * document or another slot fails its tag check instead of reading as the wrong
 * content.
 *
 * ── Never plaintext ─────────────────────────────────────────────────────────
 *
 * Reading is driven by the header, never by a setting, and a plaintext frame is
 * refused for a project-keyed document: a row that somehow holds one is
 * corrupt (or planted), not "legacy data to pass through". A key that cannot be
 * produced is a 503 for the request that needed it; nothing is written instead.
 *
 * Snapshots and checkpoint states are deflated before sealing (a Yjs state is
 * repetitive; updates are a few dozen bytes and are not). Inflation is capped,
 * so a crafted row cannot expand into a memory bomb.
 */

'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const log = require('../../telemetry/log');
const { HttpError } = require('../http/errors');

const FRAME_PLAIN = 0x00;
const FRAME_AES_GCM_V1 = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const COLLAB_HKDF_SALT = Buffer.from('beeflow:collab-doc:hkdf-salt:v1');
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const KEY_UNAVAILABLE_CODE = 'PROJECT_KEY_UNAVAILABLE';
const KEY_UNAVAILABLE_TEXT = 'Co-editing is unavailable right now because the project encryption key could not be loaded. '
    + 'Nothing was read or saved. Ask an administrator to check the server encryption settings.';

class CollabFrameError extends Error {
    /** @param {string} message @param {unknown} [cause] */
    constructor(message, cause) {
        super(message);
        this.name = 'CollabFrameError';
        this.code = 'COLLAB_FRAME_INVALID';
        if (cause) this.cause = cause;
    }
}

/**
 * The per-document key.
 * @param {Buffer} projectKey 32 bytes
 * @param {string} docId
 * @returns {Buffer}
 */
function docKey(projectKey, docId) {
    if (!Buffer.isBuffer(projectKey) || projectKey.length !== 32) throw new Error('[CollabFrame] project key must be 32 bytes');
    if (!docId) throw new Error('[CollabFrame] docId is required');
    return Buffer.from(crypto.hkdfSync('sha256', projectKey, COLLAB_HKDF_SALT, `beeflow:collab-doc:v1:${docId}`, 32));
}

const updateAad = (/** @type {string} */ docId, /** @type {number} */ seq) => `${docId}:${seq}`;
const snapshotAad = (/** @type {string} */ docId, /** @type {number} */ seq) => `${docId}:snapshot:${seq}`;
const checkpointAad = (/** @type {string} */ docId, /** @type {number} */ seq) => `${docId}:checkpoint:${seq}`;

/**
 * Seal bytes into an AES-256-GCM v1 frame.
 * @param {Uint8Array} plain @param {Buffer} key @param {string} aad
 * @returns {Buffer}
 */
function sealFrame(plain, key, aad) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([FRAME_AES_GCM_V1]), iv, cipher.getAuthTag(), ct]);
}

/**
 * Open a frame. Throws CollabFrameError for a plaintext frame (unless the
 * caller explicitly allows one), an unknown header, a short frame, or a tag
 * that does not verify.
 *
 * @param {Uint8Array} frame @param {{ key: Buffer, aad: string, allowPlain?: boolean }} opts
 * @returns {Buffer}
 */
function openFrame(frame, { key, aad, allowPlain = false }) {
    if (!frame || frame.length < 1) throw new CollabFrameError('Empty frame');
    const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const header = buf[0];
    if (header === FRAME_PLAIN) {
        if (!allowPlain) throw new CollabFrameError('A plaintext frame is not accepted for a sealed document');
        return buf.subarray(1);
    }
    if (header !== FRAME_AES_GCM_V1) throw new CollabFrameError(`Unknown frame format ${header}`);
    if (buf.length < 1 + IV_LEN + TAG_LEN) throw new CollabFrameError('Frame is too short');
    try {
        const iv = buf.subarray(1, 1 + IV_LEN);
        const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(buf.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
    } catch (err) {
        // Wrong key, wrong binding or tampered bytes are indistinguishable,
        // and all three must be loud.
        throw new CollabFrameError('Frame could not be opened (wrong key, wrong binding, or corrupt data)', err);
    }
}

/** @param {Uint8Array} frame @returns {'plain'|'aes-gcm-v1'|'unknown'} */
function frameFormat(frame) {
    if (!frame || frame.length < 1) return 'unknown';
    if (frame[0] === FRAME_PLAIN) return 'plain';
    if (frame[0] === FRAME_AES_GCM_V1) return 'aes-gcm-v1';
    return 'unknown';
}

/** @param {Uint8Array} bytes */
const deflate = (bytes) => zlib.deflateRawSync(bytes);

/** @param {Buffer} bytes */
function inflate(bytes) {
    try {
        return zlib.inflateRawSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES });
    } catch (err) {
        throw new CollabFrameError('Stored state could not be inflated', err);
    }
}

function keyUnavailable() {
    return new HttpError(503, KEY_UNAVAILABLE_CODE, KEY_UNAVAILABLE_TEXT);
}

/**
 * @param {{ getProjectKey?: (projectId: string, orgId: string|null) => Promise<Buffer> }} [deps]
 */
function makeCollabCrypto(deps = {}) {
    const getProjectKey = deps.getProjectKey
        || ((projectId, orgId) => require('../../auth/projectEscrow').getProjectKey(projectId, orgId));

    /**
     * Seal and open for one document. Throws a 503 HttpError when the key
     * cannot be produced, before anything is read or written.
     *
     * @param {{ id: string, projectId: string, orgId?: string|null, keyScope?: string }} doc
     */
    async function forDoc(doc) {
        if (!doc || !doc.id || !doc.projectId) throw new Error('[CollabFrame] a document with a project is required');
        if ((doc.keyScope || 'project') !== 'project') {
            // 'e2e' is reserved (an opaque relay, compaction on a client);
            // nothing on the server may pretend to read or write it.
            throw new HttpError(409, 'COLLAB_UNSUPPORTED', 'This document uses an encryption mode the server cannot open.');
        }
        let projectKey;
        try {
            projectKey = await getProjectKey(doc.projectId, doc.orgId ?? null);
        } catch (err) {
            log.error(`[CollabFrame] project key unavailable for ${doc.projectId}: ${err && /** @type {Error} */ (err).message}`);
            throw keyUnavailable();
        }
        if (!Buffer.isBuffer(projectKey) || projectKey.length !== 32 || !projectKey.some((b) => b !== 0)) {
            log.error(`[CollabFrame] project key for ${doc.projectId} is not a usable 32-byte key`);
            throw keyUnavailable();
        }
        const key = docKey(projectKey, doc.id);
        const docId = doc.id;
        return {
            docId,
            /** @param {number} seq @param {Uint8Array} bytes */
            sealUpdate: (seq, bytes) => sealFrame(bytes, key, updateAad(docId, seq)),
            /** @param {number} seq @param {Uint8Array} frame */
            openUpdate: (seq, frame) => openFrame(frame, { key, aad: updateAad(docId, seq) }),
            /** @param {number} seq @param {Uint8Array} bytes */
            sealSnapshot: (seq, bytes) => sealFrame(deflate(bytes), key, snapshotAad(docId, seq)),
            /** @param {number} seq @param {Uint8Array} frame */
            openSnapshot: (seq, frame) => inflate(openFrame(frame, { key, aad: snapshotAad(docId, seq) })),
            /** @param {number} seq @param {Uint8Array} bytes */
            sealCheckpoint: (seq, bytes) => sealFrame(deflate(bytes), key, checkpointAad(docId, seq)),
            /** @param {number} seq @param {Uint8Array} frame */
            openCheckpoint: (seq, frame) => inflate(openFrame(frame, { key, aad: checkpointAad(docId, seq) })),
        };
    }

    return { forDoc };
}

module.exports = {
    FRAME_PLAIN,
    FRAME_AES_GCM_V1,
    COLLAB_HKDF_SALT,
    KEY_UNAVAILABLE_CODE,
    KEY_UNAVAILABLE_TEXT,
    MAX_INFLATED_BYTES,
    CollabFrameError,
    docKey,
    updateAad,
    snapshotAad,
    checkpointAad,
    sealFrame,
    openFrame,
    frameFormat,
    makeCollabCrypto,
};
