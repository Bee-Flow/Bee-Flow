// @typecheck
/**
 * Conversation Messages Store — Phase 5 Performance Fix
 *
 * Replaces the messages_json TEXT blob anti-pattern.
 * Each message is stored as an individual row, so appending a message
 * is O(1) instead of O(n) (read full blob → deserialise → append → serialise → write).
 *
 * Schema:
 *   conversation_messages
 *     id               TEXT PRIMARY KEY
 *     conversation_id  TEXT NOT NULL
 *     conversation_type TEXT NOT NULL  ('agent' | 'direct')
 *     role             TEXT NOT NULL   ('user' | 'assistant' | 'tool' | 'system')
 *     content          TEXT
 *     tool_name        TEXT
 *     meta_json        TEXT DEFAULT '{}'   -- arbitrary per-message metadata
 *     seq              INTEGER NOT NULL    -- ordinal, for deterministic ordering
 *     created_at       TIMESTAMPTZ DEFAULT NOW()
 *
 * Migration (lazy): on first read of an old conversation, messages_json is
 * copied into this table and messages_migrated is set on the parent row; a
 * migrated conversation's blob is not read.
 *
 * Writes are one multi-row INSERT per 500 rows (the PG parameter limit), and
 * every write that touches a conversation's rows runs in one transaction
 * under that conversation's row lock (./conversationOrder.mts): a crashed
 * write never leaves a conversation message-less, and seq stays unique.
 */

const { randomUUID } = require('crypto');
const { run, getOne, getAll, exec, withTransaction } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const { encryptField, decryptField, isEnvelope } = require('../lib/fieldEnvelope');
const { conversationKey, messageAad, PLAINTEXT_CONTEXT } = require('./messageCrypto');
const { fallback } = require('../../utils/bestEffort');
// The one read order, and the per-conversation write lock that keeps seq unique.
const { READ_ORDER, lockConversation: _lockConversation } = require('./conversationOrder.mts');

const initMessagesTable = makeStoreInit('ConversationMessages', _initMessagesTable);

async function _initMessagesTable() {
    await exec(`
        CREATE TABLE IF NOT EXISTS conversation_messages (
            id               TEXT PRIMARY KEY,
            conversation_id  TEXT NOT NULL,
            conversation_type TEXT NOT NULL DEFAULT 'agent',
            role             TEXT NOT NULL,
            content          TEXT,
            tool_name        TEXT,
            meta_json        TEXT DEFAULT '{}',
            seq              INTEGER NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_seq
        ON conversation_messages(conversation_id, seq ASC)
    `);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_type
        ON conversation_messages(conversation_id, conversation_type)
    `);
    // Migration flag columns on the parent tables —
    // added lazily so this is safe on existing databases.
    // Via runDdl (stores/lib/_ddl.js): each statement's failure is reported on its own.
    await runDdl('conversationMessages', [
        `ALTER TABLE agent_conversations
            ADD COLUMN IF NOT EXISTS messages_migrated BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE direct_conversations
            ADD COLUMN IF NOT EXISTS messages_migrated BOOLEAN DEFAULT FALSE`,
    ]);

    // ── Shared-thread columns ────────────────────────────────────────────────
    //
    // author_user_id: with several humans in one thread, `role = 'user'` no
    //   longer says WHO spoke. It is a first-class column rather than a
    //   meta_json field on purpose — meta_json is encrypted, and the thread list
    //   has to render authors without holding a key. NULL means "the
    //   conversation owner", which is correct for every pre-existing row, so no
    //   backfill is needed.
    //
    // client_msg_id: idempotency. Two tabs, a retry, or a reconnect mid-send
    //   would otherwise post the same message twice into a shared thread where
    //   everyone can see it happen.
    // turn_id / turn_asked_at: the turn that wrote the row and when it was asked
    //   (./conversationTurns.js orders overlapping turns by it). NULL: unknown.
    await runDdl('conversationMessages', [
        `ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS turn_id TEXT`,
        `ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS turn_asked_at TIMESTAMPTZ`,
        `ALTER TABLE conversation_messages
            ADD COLUMN IF NOT EXISTS author_user_id TEXT`,
        `ALTER TABLE conversation_messages
            ADD COLUMN IF NOT EXISTS client_msg_id TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_messages_client_msg
            ON conversation_messages(conversation_id, client_msg_id)
            WHERE client_msg_id IS NOT NULL`,
    ]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Meta key recording that `content` was JSON-encoded on the way in.
 *
 * THE WRITER RECORDS THE ENCODING; THE READER MUST NOT GUESS IT. Without this
 * marker the two halves of the round-trip were not each other's inverse: a
 * string went into the column verbatim, and the reader JSON.parsed everything
 * and kept whatever was not a string. Any message whose text happened to BE
 * valid JSON for a non-string value therefore came back as that value — and
 * that is exactly what a tool result is. `buildLLMToolContent` serializes an
 * object result to `'{"sent":true,…}'`, which read back as an OBJECT, and every
 * later turn of that conversation 400'd on the OpenAI-compatible providers
 * ("Invalid type for 'messages[N].content' … got an object instead"). On Claude
 * it did not even fail loudly — normalizeContent re-stringifies objects — so the
 * history was quietly mangled instead.
 *
 * Written on EVERY row, `true` or `false` — not only when it is `true`. A
 * marker that is merely usually there cannot be trusted when it is missing:
 * absence would mean both "this row predates the marker" and "this row holds a
 * plain string", so a user message reading exactly `null` or `[1,2]` would
 * still be decoded by the legacy shape check. Present-and-false says
 * "definitely a raw string" and costs ~20 bytes in an already-encrypted blob.
 *
 * Stripped from `meta` before the spread below: it describes the row, not the
 * message.
 */
const CONTENT_JSON_META_KEY = '_contentJson';

/**
 * Legacy read: rows written before CONTENT_JSON_META_KEY existed carry no
 * marker, so the shape has to be recognised rather than assumed. Accept ONLY
 * the two non-string shapes this codebase has ever persisted:
 *
 *   - literal `null`   — an assistant turn that is nothing but tool_calls
 *                        (chatStream.js: `content: contentBuffer || null`);
 *   - a content-block array — multimodal turns from the BFSF-307 era, where the
 *                        LLM-shaped array was persisted as history.
 *
 * Everything else stays the raw string, which is what it always was. That is
 * the whole fix for already-stored conversations: the column text is correct,
 * only the reading of it was wrong, so no migration or backfill is needed.
 * @param {string} raw
 */
function _parseLegacyContent(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return raw; }
    if (parsed === null) return null;
    if (Array.isArray(parsed) && parsed.every(b => b && typeof b === 'object' && typeof b.type === 'string')) {
        return parsed;
    }
    return raw;
}

/**
 * Convert a full messages array (from the legacy blob) into rows for bulk insert.
 * @param {string} conversationId
 * @param {string} type
 * @param {Readonly<CryptoContext>} [ctx]
 * @param {number} [startSeq]
 */
function messagesToRows(conversationId, type, messages, ctx = PLAINTEXT_CONTEXT, startSeq = 0) {
    const c = ctx || PLAINTEXT_CONTEXT;
    const convKey = c.key ? conversationKey(c.key, conversationId) : null;

    return messages.map((m, idx) => {
        const contentIsString = typeof m.content === 'string';
        const content = contentIsString
            ? m.content
            : JSON.stringify(m.content ?? null);

        // Everything that is not a first-class column rides in meta_json —
        // including `attachments`, which carries storageKey and up to 8 000
        // chars of extracted document text. This is content, not metadata.
        const meta = JSON.stringify(
            Object.fromEntries([
                ...Object.entries(m).filter(([k]) =>
                    !['id', 'role', 'content', 'tool_name', 'toolName', CONTENT_JSON_META_KEY].includes(k)
                ),
                [CONTENT_JSON_META_KEY, !contentIsString],
            ])
        );

        return {
            id: m.id || randomUUID(),
            conversation_id: conversationId,
            conversation_type: type,
            role: m.role || 'user',
            content: encryptField(content, {
                key: convKey,
                aad: messageAad(conversationId, type, 'content'),
                encrypt: c.encryptMessages,
            }),
            tool_name: m.tool_name || m.toolName || null,
            meta_json: encryptField(meta, {
                key: convKey,
                aad: messageAad(conversationId, type, 'meta'),
                encrypt: c.encryptMeta,
            }),
            seq: startSeq + idx,
            // Plaintext by design — see the column comment in initMessagesTable.
            author_user_id: m.authorUserId || m.author_user_id || null,
            client_msg_id: m.clientMsgId || m.client_msg_id || null,
        };
    });
}

/**
 * Reconstruct a message object from a DB row.
 *
 * Decryption is driven by the VALUE, not by the current policy: a row written
 * while encryption was on stays readable after it is switched off, and a row
 * written before it was switched on needs no migration. That is what makes the
 * toggle safe in both directions.
 *
 * A field that IS an envelope but will not open throws. It must never degrade
 * to `{}` — `meta_json` holds the attachment sidecars, and
 * mergeAttachmentSidecars treats an empty sidecar list as "the slim client
 * copy wins", so a silent empty read does not merely hide a user's uploads, it
 * destroys their storageKey and extractedText on the next edit or retry.
 * @param {Readonly<CryptoContext>} [ctx]
 */
function rowToMessage(row, ctx = PLAINTEXT_CONTEXT) {
    const c = ctx || PLAINTEXT_CONTEXT;
    const convKey = c.key ? conversationKey(c.key, row.conversation_id) : null;
    const type = row.conversation_type || 'agent';

    const rawMeta = decryptField(row.meta_json, {
        key: convKey,
        aad: messageAad(row.conversation_id, type, 'meta'),
    });
    let meta = {};
    // Only a malformed-JSON plaintext meta is tolerated here (that was always
    // survivable). A decrypt failure has already thrown above.
    try { meta = JSON.parse(rawMeta || '{}'); } catch (e) { fallback('stores/agent/conversationMessages:rowToMessage', e); /* ignore */ }

    const rawContent = decryptField(row.content, {
        key: convKey,
        aad: messageAad(row.conversation_id, type, 'content'),
    });
    // Marked rows are unambiguous; unmarked ones predate the marker and fall
    // back to the shape check. See CONTENT_JSON_META_KEY.
    let content;
    if (CONTENT_JSON_META_KEY in meta) {
        if (meta[CONTENT_JSON_META_KEY]) {
            try { content = JSON.parse(rawContent); }
            catch (e) { content = rawContent; }
        } else {
            content = rawContent;
        }
        delete meta[CONTENT_JSON_META_KEY];
    } else {
        content = _parseLegacyContent(rawContent);
    }

    return {
        id: row.id,
        role: row.role,
        content,
        ...(row.tool_name ? { tool_name: row.tool_name } : {}),
        // NULL means "the conversation owner" — see the column comment. Only
        // surfaced when set, so a private conversation's message shape is
        // byte-identical to what it was before shared threads existed.
        ...(row.author_user_id ? { authorUserId: row.author_user_id } : {}),
        ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}),
        ...meta,
    };
}

// ── Phase 5: Bulk INSERT helper ───────────────────────────────────────────────

/**
 * Insert an array of message rows in one (or a few) SQL statements.
 *
 * PostgreSQL supports at most 65535 bound parameters per query.
 * With 8 columns per row that is ~8191 rows. We chunk at 500 rows
 * (4000 params) to stay well within the limit and keep individual
 * statements fast.
 *
 * @param {any[]} rows       - Output of messagesToRows()
 * @param {any}   client     - PG client (from getClient()) for transaction, or null to use pool
 * @param {string}   onConflict - Optional "ON CONFLICT ..." clause
 */
const COLS = 10;          // + author_user_id, client_msg_id
const CHUNK_SIZE = 500;   // max rows per INSERT — keeps pg params < 5000

/**
 * @param {PoolClient | null} client
 * @param {string} [onConflict]
 */
async function _bulkInsert(rows, client, onConflict = '') {
    if (!rows || rows.length === 0) return;

    const query = client
        ? (sql, params) => client.query(sql, params)
        : (sql, params) => run(sql, params);

    // Process in chunks to respect PG parameter limit
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        /** @type {string[]} */
        const valueClauses = [];
        const params = [];
        let idx = 1;

        for (const r of chunk) {
            valueClauses.push(
                `($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9})`
            );
            params.push(
                r.id,
                r.conversation_id,
                r.conversation_type,
                r.role,
                r.content,
                r.tool_name,
                r.meta_json,
                r.seq,
                r.author_user_id ?? null,
                r.client_msg_id ?? null
            );
            idx += COLS;
        }

        await query(
            `INSERT INTO conversation_messages
                (id, conversation_id, conversation_type, role, content, tool_name, meta_json, seq,
                 author_user_id, client_msg_id)
             VALUES ${valueClauses.join(',')}
             ${onConflict}`,
            params
        );
    }
}


// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Migrate a legacy messages_json blob into the conversation_messages table.
 * Safe to call multiple times — checks messages_migrated flag first.
 * Returns true if migration happened, false if already migrated or nothing to do.
 * @param {string} conversationId
 * @param {string} type
 * @param {CryptoContext | Readonly<CryptoContext>} [ctx]
 */
async function migrateConversationIfNeeded(conversationId, type, messagesArray, ctx = PLAINTEXT_CONTEXT) {
    await initMessagesTable();
    if (!messagesArray || messagesArray.length === 0) return false;

    const parentTable = type === 'direct' ? 'direct_conversations' : 'agent_conversations';

    // Check if already migrated
    const existing = await getOne(
        'SELECT id FROM conversation_messages WHERE conversation_id = $1 LIMIT 1',
        [conversationId]
    );
    if (existing) {
        // Heal the stuck messages_migrated flag. The Phase-4
        // dual-write (replaceMessages) populates this table on every message,
        // so rows existing here doesn't mean the flag was ever set — leaving
        // recent conversations permanently flagged unmigrated and excluded
        // from search Strategy A. Only flip the flag when the table provably
        // mirrors the blob (exact row-count match); on any mismatch do
        // nothing and retry on a later read — self-converging, never destructive.
        const countRow = await getOne(
            'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1',
            [conversationId]
        );
        if (countRow && countRow.n === messagesArray.length) {
            await run(
                `UPDATE ${parentTable} SET messages_migrated = TRUE WHERE id = $1`,
                [conversationId]
            );
        }
        return false; // already has rows
    }

    const rows = messagesToRows(conversationId, type, messagesArray, ctx);

    // Checked again under the lock: a turn's write landing in between would
    // otherwise sit beside the blob's rows on the same seq numbers.
    const inserted = await withTransaction(async (client) => {
        await _lockConversation(client, type, conversationId);
        const { rows: present } = await client.query(
            'SELECT id FROM conversation_messages WHERE conversation_id = $1 LIMIT 1',
            [conversationId]
        );
        if (present.length > 0) return false;
        await _bulkInsert(rows, client, 'ON CONFLICT (id) DO NOTHING');
        return true;
    });
    if (!inserted) return false;
    await run(
        `UPDATE ${parentTable} SET messages_migrated = TRUE WHERE id = $1`,
        [conversationId]
    );

    return true;
}

/**
 * Get all messages for a conversation, in READ_ORDER.
 * Returns raw message objects ready for use by the AI runtime.
 * @param {CryptoContext | Readonly<CryptoContext>} [ctx]
 * @param {string} conversationId
 */
async function getMessages(conversationId, ctx = PLAINTEXT_CONTEXT) {
    await initMessagesTable();
    const rows = await getAll(
        `SELECT * FROM conversation_messages WHERE conversation_id = $1 ${READ_ORDER}`,
        [conversationId]
    );
    return rows.map(r => rowToMessage(r, ctx));
}

/**
 * Replace all messages for a conversation (mirrors the old updateConversation behaviour).
 * Deletes existing rows and inserts the new full array atomically inside a transaction.
 * This is called by the dual-write shim in agentConversations / directConversations.
 * A failed write leaves the old messages intact (ROLLBACK).
 * @param {string} conversationId
 * @param {string} type
 * @param {Readonly<CryptoContext>} [ctx]
 */
async function replaceMessages(conversationId, type, messagesArray, ctx = PLAINTEXT_CONTEXT) {
    await initMessagesTable();
    await _refuseSilentDowngrade(conversationId, ctx);

    return withTransaction(async (client) => {
        // 0. One writer per conversation at a time (./conversationOrder.mts).
        await _lockConversation(client, type, conversationId);
        // 1. Wipe existing rows for this conversation
        await client.query(
            'DELETE FROM conversation_messages WHERE conversation_id = $1',
            [conversationId]
        );

        // 2. Bulk insert new rows (no-op if empty)
        if (messagesArray && messagesArray.length > 0) {
            const rows = messagesToRows(conversationId, type, messagesArray, ctx);
            await _bulkInsert(rows, client);
        }

    });
}

/**
 * Append messages WITHOUT touching the ones already there.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 *
 * `replaceMessages` is the only write path this store had, and it is a full
 * DELETE + re-INSERT of the array the caller happens to be holding. For a
 * single-owner conversation that is merely wasteful. For a SHARED one it is
 * data loss: if Alice and Bob both post, each writes the history they started
 * from, and whoever commits second deletes the other's message outright. No
 * error, no conflict — the message is simply gone.
 *
 * So shared threads append, and `seq` is allocated HERE rather than taken from
 * an array index. `SELECT ... FOR UPDATE` on the parent row serialises
 * concurrent writers on the same conversation (`_lockConversation`), which is
 * what makes `MAX(seq)+1` safe. There is NO unique index on
 * (conversation_id, seq) behind it: rows from before the lock may share a
 * seq, so readers break ties themselves (`READ_ORDER`).
 *
 * Messages carrying a `clientMsgId` are idempotent: a retry, a double-submit
 * from two tabs, or a reconnect mid-send resolves to one row.
 *
 * @param {string} conversationId
 * @param {'agent'|'direct'} type
 * @param {any[]} messagesArray  messages to APPEND, in order
 * @param {any} ctx  crypto context — for a shared thread this MUST be the
 *                      project context, never the posting user's
 * @returns {Promise<{appended: number, firstSeq: number|null, lastSeq: number|null}>}
 */
async function appendMessages(conversationId, type, messagesArray, ctx = PLAINTEXT_CONTEXT) {
    await initMessagesTable();
    if (!messagesArray || messagesArray.length === 0) {
        return { appended: 0, firstSeq: null, lastSeq: null };
    }
    // Appending under a keyless context does not rewrite history the way
    // replaceMessages would, but it would still leave a plaintext message
    // sitting in an otherwise-encrypted thread. Same refusal.
    await _refuseSilentDowngrade(conversationId, ctx);

    return withTransaction(async (client) => {
        // Serialise appenders on this conversation. Without the row lock two
        // concurrent appends compute the same MAX(seq)+1 and both rows land on
        // that seq (there is no unique index on (conversation_id, seq)).
        await _lockConversation(client, type, conversationId);

        const { rows: seqRows } = await client.query(
            'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM conversation_messages WHERE conversation_id = $1',
            [conversationId]
        );
        const startSeq = Number(seqRows[0]?.next ?? 0);

        const rows = messagesToRows(conversationId, type, messagesArray, ctx, startSeq);
        // A duplicate clientMsgId means "already delivered" — keep the original.
        await _bulkInsert(rows, client, 'ON CONFLICT DO NOTHING');

        return {
            appended: rows.length,
            firstSeq: startSeq,
            lastSeq: startSeq + rows.length - 1,
        };
    });
}

/**
 * Re-encrypt an entire conversation under a different key.
 *
 * Used when a conversation is shared into a project (owner key → project key)
 * and when it is unshared (project key → owner key). Read with the OLD context,
 * write with the NEW one, in one transaction.
 *
 * There is deliberately no "try the other key on failure" read path. The
 * alternative to re-encrypting is carrying two possible keys forever and
 * catching FieldDecryptError to decide between them — which is the silent
 * degradation this module's guards exist to prevent, and it makes every future
 * read ambiguous. Converting once, atomically, keeps `crypto_scope` an honest
 * description of what is on disk.
 *
 * If the read fails, nothing is written: a conversation that cannot be opened
 * with the key its `crypto_scope` claims is a bug to surface, not to paper over.
 *
 * @param {string} conversationId
 * @param {'agent'|'direct'} type
 * @param {Readonly<import("./messageCrypto").CryptoContext>} fromCtx crypto context the rows were written under
 * @param {Readonly<import("./messageCrypto").CryptoContext>} toCtx   crypto context to rewrite them under
 * @returns {Promise<number>} messages converted
 */
async function rekeyConversation(conversationId, type, fromCtx, toCtx) {
    await initMessagesTable();

    // Read outside the transaction: a decrypt failure must abort before any
    // write happens, and it tells us the source context was wrong.
    const existing = await getAll(
        `SELECT * FROM conversation_messages WHERE conversation_id = $1 ${READ_ORDER}`,
        [conversationId]
    );
    if (existing.length === 0) return 0;

    const decoded = existing.map(r => ({
        ...rowToMessage(r, fromCtx),
        // rowToMessage folds these into the message; keep them explicit so the
        // rewrite preserves authorship, idempotency keys and ordering exactly.
        authorUserId: r.author_user_id || null,
        clientMsgId: r.client_msg_id || null,
        _seq: r.seq,
    }));

    return withTransaction(async (client) => {
        await _lockConversation(client, type, conversationId);
        await client.query('DELETE FROM conversation_messages WHERE conversation_id = $1', [conversationId]);

        const rows = messagesToRows(conversationId, type, decoded, toCtx);
        // Preserve the original ordinals rather than renumbering from 0 — ids
        // referenced elsewhere (edit/retry anchors, citations) stay valid.
        rows.forEach((row, i) => { row.seq = decoded[i]._seq; });
        await _bulkInsert(rows, client);

        return rows.length;
    });
}

/**
 * Refuse to rewrite an encrypted conversation as plaintext.
 *
 * replaceMessages is a full DELETE + re-INSERT, so a caller holding a keyless
 * context does not merely fail to encrypt the new turn — it rewrites the ENTIRE
 * conversation in the clear, in one statement, with no error. Every plaintext
 * surface found in this audit reached production the same way: silently.
 *
 * The read path throws first today (rowToMessage cannot open an envelope
 * without a key), so this is unreachable on current callers. It is here for the
 * next one: a caller that swallows a read failure and writes anyway would
 * otherwise be indistinguishable from normal operation.
 *
 * Turning encryption OFF is a legitimate downgrade, so `tier: 'none'` is
 * allowed through — that is the operator asking for it explicitly.
 * @param {string} conversationId
 * @param {Readonly<CryptoContext>} ctx
 */
async function _refuseSilentDowngrade(conversationId, ctx) {
    const c = ctx || PLAINTEXT_CONTEXT;
    if (c.encryptMessages || c.tier === 'none') return;

    const existing = await getOne(
        `SELECT content FROM conversation_messages WHERE conversation_id = $1 ${READ_ORDER} LIMIT 1`,
        [conversationId]
    );
    if (!existing || !isEnvelope(existing.content)) return;

    const err = new Error(
        `[ConversationMessages] Refusing to overwrite encrypted conversation ${conversationId} with plaintext. ` +
        `The caller resolved no message key on tier '${c.tier}' — on zk that means no session DEK was threaded through. ` +
        'Writing here would destroy the ciphertext for the whole conversation.'
    );
    err.code = 'ENCRYPTION_DOWNGRADE_REFUSED';
    throw err;
}

/**
 * Clear the legacy messages_json blob on conversations that have been migrated.
 *
 * The blob was the rollback path for the Phase-4 migration. It is no longer
 * written (see updateConversation / updateDirectConversation) and no longer
 * read once `messages_migrated` is true — but rows written before that change
 * still hold a complete plaintext copy of the conversation, which defeats
 * whatever encryption conversation_messages carries.
 *
 * Only touches rows the new table demonstrably covers: `messages_migrated` AND
 * at least one row in conversation_messages. A blob is only ever cleared when
 * the data provably exists elsewhere.
 *
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{ agent: number, direct: number }>} rows affected
 */
async function blankMessageBlobs({ dryRun = false } = {}) {
    await initMessagesTable();
    const out = /** @type {{ agent: number, direct: number }} */ ({});
    for (const [key, table] of [['agent', 'agent_conversations'], ['direct', 'direct_conversations']]) {
        const sql = `
            FROM ${table} c
            WHERE c.messages_migrated = TRUE
              AND c.messages_json IS NOT NULL
              AND c.messages_json NOT IN ('', '[]')
              AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)`;
        if (dryRun) {
            const row = await getOne(`SELECT COUNT(*)::int AS n ${sql}`);
            out[key] = row?.n || 0;
        } else {
            const res = await run(
                `UPDATE ${table} SET messages_json = '[]' WHERE id IN (SELECT c.id ${sql})`
            );
            out[key] = res?.rowCount ?? 0;
        }
    }
    return out;
}

/**
 * Check if a conversation has been migrated to the new table.
 */
async function isMigrated(conversationId) {
    await initMessagesTable();
    const row = await getOne(
        'SELECT id FROM conversation_messages WHERE conversation_id = $1 LIMIT 1',
        [conversationId]
    );
    return !!row;
}

module.exports = {
    initMessagesTable,
    migrateConversationIfNeeded,
    getMessages, replaceMessages,
    // Shared threads append; replaceMessages stays for edit/retry/compaction,
    // where rewriting the whole array IS the intent.
    appendMessages,
    rekeyConversation,
    isMigrated, blankMessageBlobs,
    // The two encryption chokepoints. Exported so the round-trip — especially
    // the attachment sidecar surviving intact — is unit-testable without a DB.
    messagesToRows,
    rowToMessage,
    // A finished turn's write (./conversationTurns.js) inserts and guards as replaceMessages does.
    _bulkInsert, _refuseSilentDowngrade,
    // Awaitbare init-ingang voor migrateDb.
    initDB: initMessagesTable,
};

/** @typedef {import('./messageCrypto').CryptoContext} CryptoContext */

/** @typedef {import('pg').PoolClient} PoolClient */

/** @typedef {import('./normalizeStoredMessages').StoredMessage} StoredMessage */

/** @typedef {{ id: string, conversation_id: string, conversation_type?: string | null, role: string, content: string, meta_json: string | null, tool_name?: string | null, author_user_id?: string | null, client_msg_id?: string | null }} MessageRow */
