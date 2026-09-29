// @typecheck
/**
 * Notebook Conversation Store — persistent, encrypted chat history for the
 * in-notebook AI chat.
 *
 * Why a dedicated table instead of reusing agent_/direct_conversations:
 *   - `agent_conversations.agent_id` is NOT NULL with an FK to `agents`, so a
 *     notebook (which has no agent) can't own a row without a fake agent.
 *   - `direct_conversations` and the `conversation_messages` table both store
 *     message content in PLAINTEXT. The user asked for audit-grade, encrypted
 *     persistence (Dutch-law legal drafting record), so we persist an
 *     AES-256-GCM envelope here via the shared messageEncryption module.
 *
 * One row per (notebook_id, user_id). Messages are stored as a single
 * encrypted JSON blob, re-encrypted on each turn. This mirrors how
 * agent_conversations keeps its encrypted legacy blob, and keeps the schema
 * trivial.
 *
 * ── Under the encryption policy (was not, until now) ────────────────────────
 *
 * This store used to encrypt whenever a session DEK happened to be present and
 * not otherwise — so it ignored the org's tier completely. An org on tier
 * `none` still got encrypted notebooks (surprising, and it made "encryption is
 * off" untrue), while every keyless caller wrote plaintext into a `managed` org
 * that believed itself covered. WRITES now follow `notebookMessages` in the
 * policy, like every other surface.
 *
 * READS deliberately do NOT consult the policy — they try every key that could
 * plausibly have written the blob, oldest scheme first. Blobs written under the
 * old always-on behaviour are still openable with the session DEK, and blobs
 * written on `managed` open with the escrow key. A read that consulted the
 * current policy would strand whichever set the last toggle didn't match.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { encryptMessages, tryDecryptMessages } = require('./agent/messageEncryption');
const { resolveCrypto } = require('./agent/messageCrypto');
const log = require('../telemetry/log');

/**
 * Every key that might open this user's blobs, most-likely first.
 *
 * Order matters: the session DEK wrote everything before this change and
 * everything on `zk`, so it is tried first; the escrow key covers `managed`
 * writes and any keyless writer.
 *
 * @returns {Promise<{ read: string[], write: string|null, ctx: object }>}
 */
async function _keys(userId, sessionKey) {
    const ctx = await resolveCrypto({ userId, encryptionKey: sessionKey });
    const session = sessionKey ? String(sessionKey) : null;
    const escrow = ctx.key ? ctx.key.toString('base64') : null;

    const read = [];
    for (const k of [session, escrow]) if (k && !read.includes(k)) read.push(k);

    // The write key is policy-gated: null means "store plaintext".
    const write = ctx.encryptNotebookMessages ? (escrow || session) : null;
    return { read, write, ctx };
}

/** Decode a blob by trying each candidate key. Returns { messages, ok }. */
function _decodeWithKeys(row, readKeys, userId) {
    if (!row) return { messages: [], ok: true };
    const raw = row.messages_json || '[]';
    if (!_isEnvelope(raw)) {
        try {
            const arr = JSON.parse(raw);
            return { messages: Array.isArray(arr) ? arr : [], ok: true };
        } catch (_) { return { messages: [], ok: true }; }
    }
    for (const key of readKeys) {
        const attempt = tryDecryptMessages(raw, key, row.id, userId);
        if (attempt.ok) {
            try {
                const arr = JSON.parse(attempt.json);
                return { messages: Array.isArray(arr) ? arr : [], ok: true };
            } catch (_) { return { messages: [], ok: true }; }
        }
    }
    // An envelope no available key opens. Never present this as an empty
    // history: the callers below would then overwrite recoverable ciphertext.
    return { messages: [], ok: false };
}

const initDB = makeStoreInit('NotebookConversationStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS notebook_conversations (
            id            TEXT PRIMARY KEY,
            notebook_id   TEXT NOT NULL,
            user_id       TEXT NOT NULL,
            messages_json TEXT NOT NULL DEFAULT '[]',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (notebook_id, user_id)
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_notebook_conv_nb_user ON notebook_conversations(notebook_id, user_id)`);
    // Migration: denormalized message counter for the overview cards. The blob
    // is encrypted at rest, so the count can't be derived in SQL — writers keep
    // it in sync (pre-existing rows self-heal on their next turn).
    // Via runDdl: een échte fout wordt luid gerapporteerd i.p.v. stil ingeslikt.
    await runDdl('notebookConversationStore', [
        `ALTER TABLE notebook_conversations ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0`,
    ]);
}

async function _getRow(notebookId, userId) {
    await initDB();
    return getOne('SELECT * FROM notebook_conversations WHERE notebook_id = $1 AND user_id = $2', [notebookId, userId]);
}

/**
 * Return the conversation row for (notebook, user), creating it on first use.
 * The INSERT is ON CONFLICT DO NOTHING so two concurrent tabs racing the first
 * message can't create duplicate rows.
 */
async function getOrCreate(notebookId, userId) {
    await initDB();
    let row = await _getRow(notebookId, userId);
    if (!row) {
        const id = uuidv4();
        await run(
            `INSERT INTO notebook_conversations (id, notebook_id, user_id, messages_json)
             VALUES ($1, $2, $3, '[]')
             ON CONFLICT (notebook_id, user_id) DO NOTHING`,
            [id, notebookId, userId],
        );
        row = await _getRow(notebookId, userId);
    }
    return row;
}

/**
 * Decrypted message history for (notebook, user). [] when none yet.
 */
async function getMessages(notebookId, userId, encryptionKey = null) {
    const row = await _getRow(notebookId, userId);
    if (!row) return [];
    const { read } = await _keys(userId, encryptionKey);
    return _decodeWithKeys(row, read, userId).messages;
}

// The AES-GCM envelope messageEncryption produces: JSON with a truthy
// `_encrypted` marker (true for v1, 'v2' for HKDF+AAD). Plaintext blobs are
// bare JSON arrays, so this cleanly tells the two apart.
function _isEnvelope(raw) {
    try {
        const parsed = JSON.parse(raw);
        return !!(parsed && typeof parsed === 'object' && parsed._encrypted);
    } catch (_) {
        return false;
    }
}

/**
 * getMessages plus a `locked` flag: true when the stored blob is an encryption
 * envelope but decode fell back to empty (no or wrong session DEK), so the UI
 * can say "history unavailable" instead of silently showing an empty chat.
 * An encrypted-but-genuinely-empty history also reads as locked — harmless,
 * there is nothing to show either way.
 */
async function getMessagesWithMeta(notebookId, userId, encryptionKey = null) {
    const row = await _getRow(notebookId, userId);
    if (!row) return { messages: [], locked: false };
    const { read } = await _keys(userId, encryptionKey);
    const { messages, ok } = _decodeWithKeys(row, read, userId);
    // `locked` now means what it says — no key opened the envelope — rather
    // than "decoded to empty", which also caught genuinely empty histories.
    return { messages, locked: !ok };
}

/**
 * Append a completed turn (one or more messages) to the conversation and
 * persist the re-encrypted blob. Returns the full merged array.
 */
async function appendMessages(notebookId, userId, encryptionKey, newMessages) {
    if (!Array.isArray(newMessages) || newMessages.length === 0) return null;
    const row = await getOrCreate(notebookId, userId);
    if (!row) return null;
    // Locked-history guard — MUST run before any write. When the stored blob is
    // an envelope no available key opens, the merge-UPDATE would (a) replace the
    // still-recoverable ciphertext with only the new turn and (b) re-store it
    // PLAINTEXT (encryptMessages with a null key passes through). Refuse
    // instead; an encrypted-but-genuinely-empty blob is fine.
    const { read, write } = await _keys(userId, encryptionKey);
    const decoded = _decodeWithKeys(row, read, userId);
    if (!decoded.ok) {
        const err = new Error('Conversation history is locked: encrypted blob cannot be opened with this session key');
        err.code = 'HISTORY_LOCKED';
        throw err;
    }
    const merged = [...decoded.messages, ...newMessages];
    const stored = encryptMessages(JSON.stringify(merged), write, row.id, userId);
    // message_count is set ABSOLUTELY to what we persist — self-healing for
    // pre-existing rows whose encrypted blob could never be backfilled.
    const { rowCount } = await run(
        'UPDATE notebook_conversations SET messages_json = $1, message_count = $2, updated_at = NOW() WHERE id = $3',
        [stored, merged.length, row.id],
    );
    if (!rowCount) {
        // Row vanished between read and write (deleted notebook) — surface it so
        // a silent persist failure can't masquerade as success.
        log.warn(`[NotebookConversationStore] append found no row for notebook ${notebookId} / user ${userId}`);
        return null;
    }
    return merged;
}

/**
 * Overwrite the full history (used when the client reconciles a truncated/edited
 * conversation). Returns the stored array.
 * INTENTIONALLY DESTRUCTIVE: replaces whatever is stored, even a locked
 * envelope — callers explicitly mean "discard the old history".
 */
async function replaceMessages(notebookId, userId, encryptionKey, messages) {
    const safe = Array.isArray(messages) ? messages : [];
    const row = await getOrCreate(notebookId, userId);
    if (!row) return null;
    const { write } = await _keys(userId, encryptionKey);
    const stored = encryptMessages(JSON.stringify(safe), write, row.id, userId);
    await run(
        'UPDATE notebook_conversations SET messages_json = $1, message_count = $2, updated_at = NOW() WHERE id = $3',
        [stored, safe.length, row.id],
    );
    return safe;
}

/**
 * Clear/delete the conversation for a notebook. Called when a notebook (or a
 * legal matter) is deleted, and from the "clear chat" affordance.
 */
async function deleteForNotebook(notebookId, userId = null) {
    await initDB();
    if (userId) {
        await run('DELETE FROM notebook_conversations WHERE notebook_id = $1 AND user_id = $2', [notebookId, userId]);
    } else {
        await run('DELETE FROM notebook_conversations WHERE notebook_id = $1', [notebookId]);
    }
}

module.exports = {
    initDB,
    getOrCreate,
    getMessages,
    getMessagesWithMeta,
    appendMessages,
    replaceMessages,
    deleteForNotebook,
};
