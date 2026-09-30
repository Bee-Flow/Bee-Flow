// @typecheck
/**
 * Encryption for comment threads: the anchor of every thread (the quoted
 * passage with its context) and the body of every comment are sealed with the
 * PROJECT key before they reach the database, and opened after they leave.
 *
 * ── Which key ───────────────────────────────────────────────────────────────
 *
 * `auth/projectEscrow.getProjectKey(projectId, orgId)`, the key team chats and
 * shared threads use. Every member can read the comments, and so can the AI
 * answer run and the server operator — the trade the header of
 * auth/projectEscrow.js states. A comment is written for the project from the
 * start, so there is no private phase to protect with a user key.
 *
 *   project key ──HKDF(salt, "beeflow:project-comment:v1:thread:<threadId>")──▶ thread key
 *
 * Its own salt and info string, so a comment key can never equal a team chat
 * key or a conversation key derived from the same project key. Each field's
 * AAD names the project, the thread, the record and the field: a ciphertext
 * copied onto another comment, another thread or into the anchor slot fails
 * its tag check instead of reading as the wrong text.
 *
 * ── Never plaintext ─────────────────────────────────────────────────────────
 *
 * No "no key, store it readable" branch: a key that cannot be produced is a 503
 * (`PROJECT_KEY_UNAVAILABLE`) for the request that needed it, and nothing is
 * written instead. A stored value that is not an envelope is refused on read,
 * never passed through as if it were the comment.
 *
 * The envelope itself is stores/lib/fieldEnvelope.js (AES-256-GCM), the wire
 * format every other encrypted column uses.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { buildEnvelope, openEnvelope, isEnvelope, FieldDecryptError } = require('../../stores/lib/fieldEnvelope');
const { HttpError } = require('../../core/http/errors');
const { PROJECT_KEY_UNAVAILABLE } = require('../../stores/agent/messageCrypto');

const COMMENT_HKDF_SALT = Buffer.from('beeflow:project-comment:hkdf-salt:v1');
const KEY_BYTES = 32;

const UNAVAILABLE_TEXT = 'Comments are unavailable right now because the project encryption key could not be loaded. '
    + 'Nothing was read or saved. Ask an administrator to check the server encryption settings.';

/**
 * The per-thread key.
 * @param {Buffer} projectKey 32 bytes
 * @param {string} threadId
 * @returns {Buffer}
 */
function threadKey(projectKey, threadId) {
    if (!Buffer.isBuffer(projectKey) || projectKey.length !== KEY_BYTES) throw new Error('[ProjectComments] project key must be 32 bytes');
    if (!threadId) throw new Error('[ProjectComments] threadId is required');
    const info = `beeflow:project-comment:v1:thread:${threadId}`;
    return Buffer.from(crypto.hkdfSync('sha256', projectKey, COMMENT_HKDF_SALT, info, KEY_BYTES));
}

/**
 * @param {string} projectId
 * @param {string} threadId
 * @param {string} recordId  the comment id, or the thread id for the anchor
 * @param {'content'|'anchor'} field
 */
function commentAad(projectId, threadId, recordId, field) {
    return ['bfpcomment', 'v1', projectId, threadId, recordId, field].join(':');
}

/**
 * @param {{ getProjectKey?: (projectId: string, orgId: string|null) => Promise<Buffer> }} [deps]
 */
function makeCommentCrypto(deps = {}) {
    const getProjectKey = deps.getProjectKey
        || ((projectId, orgId) => require('../../auth/projectEscrow').getProjectKey(projectId, orgId));

    const unavailable = () => new HttpError(503, PROJECT_KEY_UNAVAILABLE, UNAVAILABLE_TEXT);

    /**
     * Seal and open for one project. Throws a 503 HttpError when the key
     * cannot be produced, before anything is read or written.
     *
     * @param {{ id: string, organizationId?: string|null }} project
     */
    async function forProject(project) {
        if (!project || !project.id) throw new Error('[ProjectComments] a project is required');
        /** @type {Buffer|null} */
        let projectKey = null;
        try {
            projectKey = await getProjectKey(project.id, project.organizationId ?? null);
        } catch (err) {
            log.error(`[ProjectComments] project key unavailable for ${project.id}: ${err && err.message}`);
            throw unavailable();
        }
        if (!Buffer.isBuffer(projectKey) || projectKey.length !== KEY_BYTES || !projectKey.some((b) => b !== 0)) {
            log.error(`[ProjectComments] project key for ${project.id} is not a usable 32-byte key`);
            throw unavailable();
        }
        // A private copy: thread keys are derived lazily, often after an await,
        // and the Buffer we were handed may be zeroed in the meantime (the
        // escrow cache clears an entry when it expires). Deriving from a zeroed
        // Buffer would seal under a key anyone can compute from the ids.
        const rootKey = Buffer.from(projectKey);

        /** @type {Map<string, Buffer>} */
        const keys = new Map();
        function keyOf(threadId) {
            if (!keys.has(threadId)) keys.set(threadId, threadKey(rootKey, threadId));
            return /** @type {Buffer} */ (keys.get(threadId));
        }

        /** @param {string} threadId @param {string} recordId @param {'content'|'anchor'} field @param {string} text */
        function seal(threadId, recordId, field, text) {
            const envelope = buildEnvelope(String(text), keyOf(threadId), commentAad(project.id, threadId, recordId, field));
            return JSON.stringify(envelope);
        }

        /** @param {string} threadId @param {string} recordId @param {'content'|'anchor'} field @param {string} stored */
        function open(threadId, recordId, field, stored) {
            if (!isEnvelope(stored)) throw new FieldDecryptError(`Comment ${field} is not sealed`);
            return openEnvelope(stored, keyOf(threadId), commentAad(project.id, threadId, recordId, field));
        }

        return {
            projectId: project.id,
            /**
             * The anchor object as one sealed value (null stays null: a
             * comment on the whole item).
             * @param {string} threadId @param {object|null} anchor
             */
            sealAnchor: (threadId, anchor) => (anchor ? seal(threadId, threadId, 'anchor', JSON.stringify(anchor)) : null),
            /** @param {string} threadId @param {string|null} stored @returns {object|null} */
            openAnchor: (threadId, stored) => (stored ? JSON.parse(open(threadId, threadId, 'anchor', stored)) : null),
            /** @param {string} threadId @param {string} commentId @param {string} text */
            sealContent: (threadId, commentId, text) => seal(threadId, commentId, 'content', text),
            /** @param {string} threadId @param {string} commentId @param {string} stored */
            openContent: (threadId, commentId, stored) => open(threadId, commentId, 'content', stored),
        };
    }

    return { forProject };
}

const defaultCommentCrypto = makeCommentCrypto();

module.exports = {
    COMMENT_HKDF_SALT,
    UNAVAILABLE_TEXT,
    threadKey,
    commentAad,
    makeCommentCrypto,
    forProject: defaultCommentCrypto.forProject,
};
