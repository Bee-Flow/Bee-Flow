// @typecheck
/**
 * Encryption for team chats: every title and message body is sealed with the
 * PROJECT key before it reaches the database, and opened after it leaves.
 *
 * ── Which key, and what that means ──────────────────────────────────────────
 *
 * The key is `auth/projectEscrow.getProjectKey(projectId, orgId)`: derived from
 * the org root key, the same key a conversation shared into the project is
 * encrypted under. Every member can read the chat, and so can the assistant
 * run and the server operator — the same stated trade the shared threads make
 * (see the header of auth/projectEscrow.js). A team chat is shared from its
 * first message, so there is no private phase to protect with a user key.
 *
 * ── Never plaintext ─────────────────────────────────────────────────────────
 *
 * Unlike the conversation store, this module does not consult the org's
 * encryption policy and has no "no key, write plaintext" branch. A key that
 * cannot be produced is a 503 (`PROJECT_KEY_UNAVAILABLE`) for the request that
 * needed it; nothing is written instead. Reading is equally strict: a stored
 * value that is not an envelope is refused, never passed through as if it
 * were the message.
 *
 * ── Key and binding ─────────────────────────────────────────────────────────
 *
 *   project key ──HKDF(salt, "beeflow:project-chat:v1:chat:<chatId>")──▶ chat key
 *
 * A separate salt and info string from the conversation hierarchy
 * (stores/agent/messageCrypto.js), so the two can never derive the same key.
 * Each field's AAD names the project, the chat, the record and the field, so a
 * ciphertext copied onto another message, another chat or the title slot fails
 * its tag check instead of reading as the wrong text.
 *
 * The AES-256-GCM envelope itself is stores/lib/fieldEnvelope.js — the same
 * wire format every other encrypted column uses.
 */

'use strict';

const crypto = require('crypto');
const log = require('../telemetry/log');
const { buildEnvelope, openEnvelope, isEnvelope, FieldDecryptError } = require('../stores/lib/fieldEnvelope');
const { HttpError } = require('../core/http/errors');
const { PROJECT_KEY_UNAVAILABLE } = require('../stores/agent/messageCrypto');

const CHAT_HKDF_SALT = Buffer.from('beeflow:project-chat:hkdf-salt:v1');

/** @param {string} [what] the feature that cannot be used without the key */
const keyUnavailableText = (what = 'Team chat') => `${what} cannot be used right now because the project encryption key could not be loaded. `
    + 'Nothing was read or saved. Ask an administrator to check the server encryption settings.';

/**
 * The per-chat key.
 * @param {Buffer} projectKey 32 bytes
 * @param {string} chatId
 * @returns {Buffer}
 */
function chatKey(projectKey, chatId) {
    if (!Buffer.isBuffer(projectKey) || projectKey.length !== 32) throw new Error('[ProjectChatCrypto] project key must be 32 bytes');
    if (!chatId) throw new Error('[ProjectChatCrypto] chatId is required');
    return Buffer.from(crypto.hkdfSync('sha256', projectKey, CHAT_HKDF_SALT, `beeflow:project-chat:v1:chat:${chatId}`, 32));
}

/**
 * @param {string} projectId
 * @param {string} chatId
 * @param {string} recordId  the message id, or the chat id for the title
 * @param {'content'|'title'} field
 */
function fieldAad(projectId, chatId, recordId, field) {
    return `bfpchat:v1:${projectId}:${chatId}:${recordId}:${field}`;
}

/** A zeroed Buffer is a cleared key, never a real one. @param {Buffer} key */
function isAllZero(key) {
    return !key.some((b) => b !== 0);
}

function keyUnavailable(what) {
    return new HttpError(503, PROJECT_KEY_UNAVAILABLE, keyUnavailableText(what));
}

/**
 * @param {{ getProjectKey?: (projectId: string, orgId: string|null) => Promise<Buffer> }} [deps]
 */
function makeChatCrypto(deps = {}) {
    const getProjectKey = deps.getProjectKey
        || ((projectId, orgId) => require('../auth/projectEscrow').getProjectKey(projectId, orgId));

    /**
     * Seal and open for one project. Throws a 503 HttpError when the key
     * cannot be produced, before anything is read or written.
     *
     * @param {{ id: string, organizationId?: string|null }} project
     * @param {{ what?: string }} [opts]  the feature named in the 503 (default: Team chat)
     */
    async function forProject(project, { what } = {}) {
        if (!project || !project.id) throw new Error('[ProjectChatCrypto] a project is required');
        let key;
        try {
            key = await getProjectKey(project.id, project.organizationId ?? null);
        } catch (err) {
            log.error(`[ProjectChatCrypto] project key unavailable for ${project.id}: ${err && err.message}`);
            throw keyUnavailable(what);
        }
        if (!Buffer.isBuffer(key) || key.length !== 32 || isAllZero(key)) {
            log.error(`[ProjectChatCrypto] project key for ${project.id} is not a usable 32-byte key`);
            throw keyUnavailable(what);
        }
        // A private copy: the per-chat keys are derived lazily, often after an
        // await, and the Buffer we were handed may be zeroed in the meantime
        // (the escrow cache clears an entry when it expires). Deriving from a
        // zeroed Buffer would seal under a key anyone can compute from the ids.
        key = Buffer.from(key);

        /** @type {Map<string, Buffer>} */
        const perChat = new Map();
        const keyFor = (chatId) => {
            let k = perChat.get(chatId);
            if (!k) { k = chatKey(key, chatId); perChat.set(chatId, k); }
            return k;
        };

        const seal = (chatId, recordId, field, plaintext) =>
            JSON.stringify(buildEnvelope(String(plaintext), keyFor(chatId), fieldAad(project.id, chatId, recordId, field)));

        const open = (chatId, recordId, field, stored) => {
            if (!isEnvelope(stored)) throw new FieldDecryptError(`Team chat ${field} is not sealed`);
            return openEnvelope(stored, keyFor(chatId), fieldAad(project.id, chatId, recordId, field));
        };

        return {
            projectId: project.id,
            /** @param {string} chatId @param {string} title */
            sealTitle: (chatId, title) => seal(chatId, chatId, 'title', title),
            /** @param {string} chatId @param {string} stored */
            openTitle: (chatId, stored) => open(chatId, chatId, 'title', stored),
            /** @param {string} chatId @param {string} messageId @param {string} text */
            sealContent: (chatId, messageId, text) => seal(chatId, messageId, 'content', text),
            /** @param {string} chatId @param {string} messageId @param {string} stored */
            openContent: (chatId, messageId, stored) => open(chatId, messageId, 'content', stored),
        };
    }

    return { forProject };
}

const defaultChatCrypto = makeChatCrypto();

module.exports = {
    CHAT_HKDF_SALT,
    KEY_UNAVAILABLE_TEXT: keyUnavailableText(),
    keyUnavailableText,
    chatKey,
    fieldAad,
    makeChatCrypto,
    forProject: defaultChatCrypto.forProject,
};
