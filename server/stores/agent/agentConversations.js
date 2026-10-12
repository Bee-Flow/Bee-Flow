// @typecheck
/**
 * Agent Conversations - CRUD, search, multi-conversation support for agent chat
 *
 * Phase 4: Dual-write architecture.
 *   - Reads: try conversation_messages table first (new); fall back to messages_json blob (legacy).
 *   - Writes: write to both conversation_messages (new) AND messages_json (legacy backup).
 *   - Old conversations are lazily migrated on first read.
 *
 * Rolling back is safe: old code still reads messages_json which stays in sync.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { encryptMessages, decryptMessages } = require('./messageEncryption');
const { resolveCrypto, conversationKey } = require('./messageCrypto');
const { encryptField, decryptField, isEnvelope } = require('../lib/fieldEnvelope');
const { sealTitle, openTitle, openTitles } = require('./conversationTitle');
const convMessages = require('./conversationMessages');
const log = require('../../telemetry/log');
// Shared-thread helpers live on the direct side; both tables have identical
// shared_scope / crypto_scope semantics, so duplicating them would only create
// two things to keep in step. Required lazily inside the functions below to
// avoid a module cycle (directConversations already requires from here).

/**
 * Agent-table twin of directConversations._resolveWriteContext.
 *
 * @returns {Promise<{ownerId, ctx, isShared, projectId}|null>} null = no access
 */
async function _resolveAgentWriteContext(conversationId, callerUserId, encryptionKey) {
    let row;
    try {
        row = await getOne(
            'SELECT user_id, project_id, shared_scope, crypto_scope FROM agent_conversations WHERE id = $1',
            [conversationId]
        );
    } catch (err) {
        if (!/column .* does not exist/i.test(err.message)) throw err;
        row = await getOne('SELECT user_id, project_id FROM agent_conversations WHERE id = $1', [conversationId]);
        if (row) { row.shared_scope = 'private'; row.crypto_scope = 'user'; }
    }
    if (!row) return null;

    const isShared = row.shared_scope === 'project' && !!row.project_id;
    // A null caller is a background job (compaction, an automation) acting on behalf
    // of the conversation itself — it has no identity to check, and the key it
    // gets is the row's either way.
    if (callerUserId && row.user_id !== callerUserId) {
        if (!isShared) return null;
        const { hasProjectRole } = require('../../auth/projectAccess');
        if (!await hasProjectRole(callerUserId, row.project_id, 'editor')) return null;
    }

    const ctx = row.crypto_scope === 'project' && row.project_id
        ? await resolveCrypto({ userId: row.user_id, projectKeyFor: { projectId: row.project_id } })
        : await resolveCrypto({ userId: row.user_id || callerUserId, encryptionKey });

    return { ownerId: row.user_id, ctx, isShared, projectId: row.project_id || null };
}

/**
 * Which key opens which column — the same rule as directConversations._rowCrypto.
 *
 * SCOPED columns (message rows, `meta_json`) follow the row's `crypto_scope`,
 * because sharedConversations re-keys exactly those when a conversation is
 * shared. `title` does NOT: listConversations, listAllConversations and
 * searchConversations each resolve ONE owner context for a whole page, so a
 * title that changed key on sharing would render null in the owner's own list.
 */
function _rowCrypto(row, encryptionKey = null) {
    return row.crypto_scope === 'project' && row.project_id
        ? resolveCrypto({ userId: row.user_id, projectKeyFor: { projectId: row.project_id } })
        : resolveCrypto({ userId: row.user_id, encryptionKey });
}

/**
 * Fetch the columns the meta helpers need, tolerating a pre-migration install
 * with no shared_scope/crypto_scope columns (there, everything is private).
 */
async function _getMetaRow(conversationId) {
    try {
        return await getOne(
            'SELECT meta_json, user_id, project_id, crypto_scope FROM agent_conversations WHERE id = $1',
            [conversationId]
        );
    } catch (err) {
        if (!/column .* does not exist/i.test(err.message)) throw err;
        const row = await getOne('SELECT meta_json, user_id FROM agent_conversations WHERE id = $1', [conversationId]);
        if (row) { row.project_id = null; row.crypto_scope = 'user'; }
        return row;
    }
}

const ConversationWriteDenied = class ConversationWriteDenied extends Error {
    constructor(id) {
        super(`Conversation ${id} is not writable by this caller`);
        this.name = 'ConversationWriteDenied';
        this.code = 'CONVERSATION_WRITE_DENIED';
    }
};

/** See directConversations._appendNewMessages — same diff-and-append reasoning. */
async function _appendNewMessages(id, type, messages, ctx) {
    const { _appendNewMessages: impl } = require('./directConversations');
    return impl(id, type, messages, ctx);
}

// ============ Basic Conversation CRUD ============

async function getConversation(agentId, userId, encryptionKey = null) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE agent_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1', [agentId, userId]);
    if (!row) return null;
    // Passing an owner-derived ctx in as `sharedCtx` short-circuited
    // _readMessages' crypto_scope branch, so a project-shared conversation was
    // read with the OWNER's key against project-key ciphertext and threw
    // FIELD_DECRYPT_FAILED — a 500 on the owner's own history. Let _readMessages
    // pick the key from the row, exactly as getConversationById does.
    const messages = await _readMessages(row, encryptionKey);
    const meta = _parseMeta(row.meta_json, row.id, await _rowCrypto(row, encryptionKey));
    const titleCtx = await resolveCrypto({ userId: row.user_id, encryptionKey });
    return { ...row, messages, meta, title: openTitle(row.title, row.id, 'agent', titleCtx) };
}

/**
 * AAD for the conversation-level meta_json blob.
 * Bound to the conversation so a meta blob cannot be replayed onto another.
 */
function _metaAad(conversationId) {
    return `bfconvmeta:v1:${conversationId}`;
}

/**
 * Parse conversation meta_json, decrypting when the stored value is an
 * envelope.
 *
 * meta_json holds `conversationSummary` — the LLM's précis of everything that
 * was compacted out of the history. That is the substance of the conversation,
 * condensed, and it was stored in plaintext even on the legacy encrypted path.
 *
 * A decrypt failure THROWS rather than yielding `{}`. Returning an empty object
 * would let updateConversationMeta's read-merge-write overwrite the real meta
 * with a partial one, destroying the summary and anything else stored there —
 * the same silent-then-destructive pattern as the attachment sidecars.
 */
function _parseMeta(metaJson, conversationId = null, ctx = null) {
    let raw = metaJson;
    if (conversationId && isEnvelope(raw)) {
        // backgroundKey, not key: conversation meta is written by compaction,
        // which runs with no session in scope. On `zk` that means the org
        // escrow; on `managed` the two are the same key anyway.
        const root = ctx && ctx.backgroundKey ? ctx.backgroundKey : (ctx && ctx.key) || null;
        raw = decryptField(raw, {
            key: root ? conversationKey(root, conversationId) : null,
            aad: _metaAad(conversationId),
        });
    }
    try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

/**
 * Merge partial fields into the conversation's meta_json. Used to persist
 * conversation-scoped state (e.g. compactionSummary). Safe against
 * concurrent writers because the merge uses a single UPDATE ... jsonb
 * read-modify-write round-trip; collisions overwrite last-writer-wins,
 * which is acceptable for this data.
 */
async function updateConversationMeta(conversationId, partial) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0) return;
    await initDB();
    const existing = await _getMetaRow(conversationId);
    if (!existing) return;

    // This function is called with no key by design (compaction runs from the
    // agent runtime with only a conversation id), so the key comes from the
    // policy layer — the escrow on the managed tier, the PROJECT key once the
    // conversation is shared, nothing on `none`.
    const ctx = await _rowCrypto(existing);
    const merged = { ..._parseMeta(existing.meta_json, conversationId, ctx), ...partial };

    const stored = encryptField(JSON.stringify(merged), {
        key: ctx.backgroundKey ? conversationKey(ctx.backgroundKey, conversationId) : null,
        aad: _metaAad(conversationId),
        encrypt: ctx.encryptConversationMeta,
    });
    await run('UPDATE agent_conversations SET meta_json = $1 WHERE id = $2', [stored, conversationId]);
}

/**
 * Read ONLY the conversation's meta_json (no message load/decrypt). Used by
 * the agent runtime to restore conversation-scoped state (e.g.
 * activatedSkillIds) before tool assembly. Same crypto resolution as
 * updateConversationMeta; a decrypt failure propagates (callers treat the
 * read as best-effort).
 */
async function getConversationMeta(conversationId, options) {
    await initDB();

    // THE READ GATE, and it has to be here. This function selects on `id` alone
    // — there is no user_id predicate of its own — and the key below comes from
    // the ROW. Those two together are fail-open: while the key came from the
    // CALLER, someone else's thread simply refused to open
    // (FIELD_DECRYPT_FAILED); row-keyed and ungated, the same caller gets the
    // owner's meta decrypted for them. The reachable path is
    // core/agentRuntime/chatStream.js:223, whose conversationId comes straight
    // from client-supplied messageMetadata. Row-derived key PLUS an
    // owner/project predicate is the only shape that is both correct on a
    // shared thread and closed on somebody else's.
    //
    // Two call shapes, and the difference is deliberate:
    //
    //   getConversationMeta(id)               a trusted in-process caller with
    //                                         no identity to check — the read
    //                                         twin of updateConversationMeta,
    //                                         which compaction invokes holding
    //                                         nothing but a conversation id.
    //                                         Same null-caller convention as
    //                                         _resolveAgentWriteContext.
    //
    //   getConversationMeta(id, { userId })   a request is behind it, so the
    //                                         identity is MANDATORY and a blank
    //                                         one THROWS. Dropping the
    //                                         predicate for a missing value is
    //                                         how a scoped call silently
    //                                         becomes an unscoped one.
    //
    // The bar is canRead (conversationAccess.js): the owner, or viewer+ on the
    // project a shared thread lives in.
    const requestScoped = options !== undefined && options !== null;
    const { userId = null, encryptionKey = null } = options || {};
    let isOwner = true;

    if (requestScoped) {
        if (typeof userId !== 'string' || !userId) {
            throw Object.assign(
                new TypeError('getConversationMeta was given a caller context with no userId — pass the caller id, or call it with no options at all for a system read'),
                { code: 'CALLER_USER_ID_REQUIRED' }
            );
        }
        const { resolveConversationAccess } = require('./conversationAccess');
        const access = await resolveConversationAccess(conversationId, userId, 'agent');
        if (!access) return null;      // absent or unreadable, indistinguishable
        isOwner = access.isOwner;
    }

    const row = await _getMetaRow(conversationId);
    if (!row) return null;
    // Key from the ROW, matching updateConversationMeta. The caller's session
    // DEK is forwarded only when the caller IS the owner: on `managed` that key
    // can seed a user's first escrow, so handing a project member's DEK to
    // resolveCrypto({ userId: <the owner> }) could mint the OWNER's escrow from
    // a key that is not theirs (same rule as directConversations._ownerCrypto).
    const ctx = await _rowCrypto(row, isOwner ? encryptionKey : null);
    return _parseMeta(row.meta_json, conversationId, ctx);
}

async function getOrCreateConversation(agentId, userId, encryptionKey = null) {
    let conv = await getConversation(agentId, userId, encryptionKey);
    if (!conv) {
        const id = uuidv4();
        await run("INSERT INTO agent_conversations (id, agent_id, user_id, messages_json, created_at, updated_at) VALUES ($1,$2,$3,'[]',NOW(),NOW())", [id, agentId, userId]);
        conv = { id, agent_id: agentId, user_id: userId, messages: [] };
    }
    return conv;
}

async function createNewConversation(agentId, userId) {
    await initDB();
    const id = uuidv4();
    await run("INSERT INTO agent_conversations (id, agent_id, user_id, messages_json, created_at, updated_at) VALUES ($1,$2,$3,'[]',NOW(),NOW())", [id, agentId, userId]);
    return { id, agent_id: agentId, user_id: userId, messages: [] };
}

/**
 * Phase 4 dual-write: persist messages to conversation_messages table (new, fast) AND
 * keep messages_json updated as a backup for rollback safety.
 */
async function updateConversation(conversationId, messages, encryptionKey = null, userId = null) {
    await initDB();

    // ── New table write (Phase 4) ────────────────────────────────────────────
    // This table is what reads actually prefer once a conversation is migrated,
    // so it is the one that has to carry the encryption. It previously took no
    // key at all, which is why enabling encryption encrypted only the legacy
    // backup blob while every message stayed readable here.
    //
    // The key and the owner come from the ROW, not from whoever is asking. In a
    // shared thread the requester is routinely NOT the owner, and using their
    // key would re-encrypt the whole conversation under a key the owner does
    // not hold. See directConversations._resolveWriteContext.
    const access = await _resolveAgentWriteContext(conversationId, userId, encryptionKey);
    if (!access) throw new ConversationWriteDenied(conversationId);
    const { ctx, isShared } = access;

    // Shared threads append; a stale full array from one member would otherwise
    // delete another's message. Private conversations keep the replace path.
    const writeMessages = isShared
        ? () => _appendNewMessages(conversationId, 'agent', messages, ctx)
        : () => convMessages.replaceMessages(conversationId, 'agent', messages, ctx);
    await writeMessages().catch(err =>
        log.error('[AgentConversations] conversation_messages write error:', err.message)
    );

    // ── Legacy blob ───────────────────────────────────────────────────────────
    // Rollback path for the Phase-4 migration, and a leak once encryption is on:
    // encryptMessages() passes the value straight through when the key is null,
    // so every escrow-only writer (automations, compaction — they hold no session
    // DEK) laid down a full PLAINTEXT copy of the conversation next to the
    // encrypted table.
    //
    // Once `messages_migrated` is true the blob is never read (see _readMessages),
    // so skip it entirely rather than trying to encrypt a copy nobody consults.
    const migratedRow = await getOne('SELECT messages_migrated FROM agent_conversations WHERE id = $1', [conversationId]);
    if (migratedRow?.messages_migrated) {
        await run('UPDATE agent_conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
        return;
    }
    const messagesJson = JSON.stringify(messages);
    const storedData = encryptMessages(messagesJson, encryptionKey, conversationId, userId);
    await run('UPDATE agent_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2', [storedData, conversationId]);
}

async function clearConversation(agentId, userId) {
    await initDB();
    const rows = await getAll('SELECT id FROM agent_conversations WHERE agent_id = $1 AND user_id = $2', [agentId, userId]);
    for (const row of rows) {
        await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [row.id]).catch(() => {});
    }
    await run('DELETE FROM agent_conversations WHERE agent_id = $1 AND user_id = $2', [agentId, userId]);
}

async function updateConversationWorkspace(conversationId, content, notebookId = null) {
    await initDB();
    if (notebookId !== null) {
        await run('UPDATE agent_conversations SET workspace_content = $1, workspace_notebook_id = $2, updated_at = NOW() WHERE id = $3', [content, notebookId, conversationId]);
    } else {
        await run('UPDATE agent_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, conversationId]);
    }
}

async function getConversationWorkspace(conversationId) {
    await initDB();
    const row = await getOne('SELECT workspace_content, workspace_notebook_id FROM agent_conversations WHERE id = $1', [conversationId]);
    return row ? { content: row.workspace_content || '', notebookId: row.workspace_notebook_id || null } : null;
}

// ============ Multi-Conversation ============

async function listConversations(agentId, userId) {
    await initDB();
    const rows = await getAll('SELECT id, agent_id, user_id, title, project_id, shared_scope, pinned, labels_json, created_at, updated_at FROM agent_conversations WHERE agent_id = $1 AND user_id = $2 ORDER BY updated_at DESC', [agentId, userId]);
    // One resolve for the whole page: every row belongs to the same user, and
    // on `managed` each resolve unwraps the escrowed DEK.
    return openTitles(rows, 'agent', await resolveCrypto({ userId }));
}

async function listAllConversations(userId) {
    await initDB();
    const rows = await getAll(`SELECT c.id, c.agent_id, c.user_id, c.title, c.project_id, c.pinned, c.labels_json, c.created_at, c.updated_at,
        a.name as agent_name, a.avatar as agent_avatar
        FROM agent_conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        WHERE c.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT 50`, [userId]);
    return openTitles(rows, 'agent', await resolveCrypto({ userId }));
}

async function searchConversations(userId, query, filters = {}, encryptionKey) {
    await initDB();

    // ── Phase 6: SQL-side search ──────────────────────────────────────────────
    // Old approach: load every conversation + messages into Node.js, then do
    //   JS string matching (O(n) queries + O(n) memory).
    //
    // New approach — three strategies, applied in priority order:
    //
    //  Strategy A (SQL JOIN — zero extra queries):
    //    For title matches AND migrated-conversation content matches.
    //    One query with LEFT JOIN on conversation_messages finds both in one shot.
    //
    //  Strategy B (SQL ILIKE on blob — no encryption):
    //    If no encryption key, the messages_json blob is plain text, so we can
    //    search it directly in SQL for non-migrated conversations.
    //
    //  Strategy C (JS fallback — encrypted blobs only):
    //    Only reached when encryptionKey is set AND conversations aren't migrated
    //    yet. Bounded to 200 rows max (vs. the old unbounded loop).
    // ─────────────────────────────────────────────────────────────────────────

    const likeQuery = `%${query}%`;
    const lowerQuery = query.toLowerCase();

    // Base filter params (userId is always $1)
    const filterParams = [userId];
    let filterClauses = '';
    let filterIdx = 2;
    if (filters.agentId) { filterClauses += ` AND c.agent_id = $${filterIdx++}`; filterParams.push(filters.agentId); }
    if (filters.startDate) { filterClauses += ` AND c.updated_at >= $${filterIdx++}`; filterParams.push(filters.startDate); }
    if (filters.endDate) { filterClauses += ` AND c.updated_at <= $${filterIdx++}`; filterParams.push(filters.endDate); }

    // likeQuery is the next param after the filter params
    const likeIdx = filterIdx; // e.g. $2 if no filters, $3 if agentId, etc.

    // ── Strategy A: title OR migrated message content (single JOIN query) ────
    const stratA = await getAll(`
        SELECT DISTINCT
            c.id, c.agent_id, c.user_id, c.title, c.updated_at,
            c.messages_migrated,
            a.name AS agent_name, a.avatar AS agent_avatar
        FROM agent_conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        LEFT JOIN conversation_messages cm
            ON cm.conversation_id = c.id AND c.messages_migrated = TRUE
        WHERE c.user_id = $1
          AND (c.title ILIKE $${likeIdx} OR cm.content ILIKE $${likeIdx})
          ${filterClauses}
        ORDER BY c.updated_at DESC
        LIMIT 50
    `, [...filterParams, likeQuery]);

    const results = [...stratA];
    const matchedIds = new Set(results.map(r => r.id));

    // ── Strategy A2: migrated conversations whose content or TITLE is ENCRYPTED ──
    // Strategy A's `cm.content ILIKE` / `c.title ILIKE` match nothing against
    // ciphertext, and the GIN trigram index on content becomes dead weight, so
    // without this pass search silently returns fewer results once either
    // surface is enabled. Decrypt a bounded candidate set in the app.
    const searchCtx = await resolveCrypto({ userId, encryptionKey });
    if (searchCtx.encryptMessages || searchCtx.encryptTitle) {
        const encMigrated = await getAll(`
            SELECT c.id, c.agent_id, c.user_id, c.title, c.updated_at,
                   c.messages_migrated,
                   a.name AS agent_name, a.avatar AS agent_avatar
            FROM agent_conversations c
            LEFT JOIN agents a ON c.agent_id = a.id
            WHERE c.user_id = $1
              ${searchCtx.encryptMessages ? 'AND c.messages_migrated = TRUE' : ''}
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 200
        `, filterParams);
        let added = 0;
        for (const conv of encMigrated) {
            if (matchedIds.has(conv.id)) continue;
            try {
                const title = openTitle(conv.title, conv.id, 'agent', searchCtx);
                let hit = !!title && String(title).toLowerCase().includes(lowerQuery);
                if (!hit && searchCtx.encryptMessages && conv.messages_migrated) {
                    const msgs = await convMessages.getMessages(conv.id, searchCtx);
                    hit = JSON.stringify(msgs).toLowerCase().includes(lowerQuery);
                }
                if (hit) {
                    results.push({ ...conv, title });
                    matchedIds.add(conv.id);
                    if (++added >= 50) break;
                }
            } catch (e) {
                log.error('[AgentConversations] Search decrypt error for', conv.id, '-', e.message);
            }
        }
    }

    if (!encryptionKey) {
        // ── Strategy B: non-migrated blobs, no encryption — search in SQL ──
        const stratB = await getAll(`
            SELECT
                c.id, c.agent_id, c.user_id, c.title, c.updated_at,
                c.messages_migrated,
                a.name AS agent_name, a.avatar AS agent_avatar
            FROM agent_conversations c
            LEFT JOIN agents a ON c.agent_id = a.id
            WHERE c.user_id = $1
              AND c.messages_migrated = FALSE
              AND c.messages_json ILIKE $${likeIdx}
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 50
        `, [...filterParams, likeQuery]);

        for (const r of stratB) {
            if (!matchedIds.has(r.id)) { results.push(r); matchedIds.add(r.id); }
        }
    } else {
        // ── Strategy C: non-migrated encrypted blobs — bounded JS fallback ──
        const encCandidates = await getAll(`
            SELECT
                c.id, c.agent_id, c.user_id, c.title, c.updated_at,
                c.messages_json, c.messages_migrated,
                a.name AS agent_name, a.avatar AS agent_avatar
            FROM agent_conversations c
            LEFT JOIN agents a ON c.agent_id = a.id
            WHERE c.user_id = $1
              AND c.messages_migrated = FALSE
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 200
        `, filterParams);

        let cAdded = 0;
        for (const conv of encCandidates) {
            if (matchedIds.has(conv.id)) continue;
            try {
                const decrypted = decryptMessages(conv.messages_json || '[]', encryptionKey, conv.id, userId);
                if (decrypted.toLowerCase().includes(lowerQuery)) {
                    results.push({ ...conv, messages_json: decrypted });
                    matchedIds.add(conv.id);
                    if (++cAdded >= 50) break;
                }
            } catch (e) {
                log.error('[AgentConversations] Search decrypt error:', e);
            }
        }
    }

    // Return unified results sorted by recency, capped at 50. openTitles is a
    // no-op for rows A2 already decrypted and for plaintext rows from A/B/C.
    return openTitles(
        results.sort((a, b) => /** @type {any} */ (new Date(b.updated_at)) - /** @type {any} */ (new Date(a.updated_at))).slice(0, 50),
        'agent',
        searchCtx,
    );
}

async function getConversationById(conversationId, encryptionKey = null, options = {}) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE id = $1', [conversationId]);
    if (!row) return null;
    let messages = await _readMessages(row, encryptionKey);
    // Restore Privacy Shield tokens for UI render paths. `options.restore=false`
    // is reserved for the LLM history loader (so Claude keeps seeing tokens).
    const restore = options.restore !== false;
    if (restore && row.pii_token_map) {
        const { _restoreTokensInMessages } = require('./directConversations');
        if (typeof _restoreTokensInMessages === 'function') {
            messages = _restoreTokensInMessages(messages, row.pii_token_map);
        }
    }

    const meta = _parseMeta(row.meta_json, row.id, await _rowCrypto(row, encryptionKey));
    // Repair conversations damaged by BFSF-307 (the compacted LLM prompt was
    // persisted as history). Gated on the SAME `restore` flag as token
    // restoration: hiding compaction's synthetic turns from the LLM history
    // loader would silently undo compaction and re-inflate the prompt.
    let compaction;
    if (restore) {
        const { normalizeStoredMessages } = require('./normalizeStoredMessages');
        const wasCompacted = !!(meta && (meta.conversationSummary || meta.summaryUpTo > 0));
        const norm = normalizeStoredMessages(messages, { wasCompacted });
        messages = norm.messages;
        if (norm.hiddenCount > 0 || norm.repairedCount > 0) {
            // A read-time mask nobody can measure is how you end up here twice.
            log.info(`[AgentConversations] conv ${row.id}: hid ${norm.hiddenCount} compaction synthetic(s), flattened ${norm.repairedCount} block-content message(s)`);
        }
        if (norm.summarised || norm.hiddenCount > 0) {
            compaction = { summarised: norm.summarised, hiddenCount: norm.hiddenCount };
        }
    }

    return {
        ...row, messages, meta,
        title: openTitle(row.title, row.id, 'agent', await resolveCrypto({ userId: row.user_id, encryptionKey })),
        ...(compaction ? { compaction } : {}),
        threadTitles: JSON.parse(row.thread_titles_json || '{}'),
    };
}

async function createConversation(agentId, userId, title = 'New Chat') {
    await initDB();
    const id = uuidv4();
    const ctx = await resolveCrypto({ userId });
    await run("INSERT INTO agent_conversations (id, agent_id, user_id, title, messages_json, created_at, updated_at) VALUES ($1,$2,$3,$4,'[]',NOW(),NOW())",
        [id, agentId, userId, sealTitle(title, id, 'agent', ctx)]);
    // The caller gets the readable title back, not what went to disk.
    return { id, agent_id: agentId, user_id: userId, title, messages: [], threadTitles: {} };
}

async function updateConversationTitle(conversationId, title) {
    await initDB();
    // No key is threaded in: the auto-title pass runs after a turn completes,
    // from the runtime rather than a request. That is exactly why titles use
    // the escrow key (ctx.backgroundKey) rather than the session DEK.
    const row = await getOne('SELECT user_id FROM agent_conversations WHERE id = $1', [conversationId]);
    if (!row) return;
    const ctx = await resolveCrypto({ userId: row.user_id });
    await run('UPDATE agent_conversations SET title = $1 WHERE id = $2', [sealTitle(title, conversationId, 'agent', ctx), conversationId]);
}

async function pinConversation(conversationId, pinned) {
    await initDB();
    await run('UPDATE agent_conversations SET pinned = $1 WHERE id = $2', [!!pinned, conversationId]);
}

async function setConversationLabels(conversationId, labels) {
    await initDB();
    await run('UPDATE agent_conversations SET labels_json = $1 WHERE id = $2', [JSON.stringify(labels), conversationId]);
}

async function updateThreadTitles(conversationId, threadTitles) {
    await initDB();
    await run('UPDATE agent_conversations SET thread_titles_json = $1 WHERE id = $2', [JSON.stringify(threadTitles), conversationId]);
}

async function deleteConversationById(conversationId) {
    await initDB();
    await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [conversationId]).catch(() => {});
    await run('DELETE FROM agent_conversations WHERE id = $1', [conversationId]);
    // Drop any DLP token map / remembered choice for this conversation so a new
    // conversation reusing the same ID (unlikely but possible) starts clean.
    try { require('../../core/dlp/dlpRunner').clearConversationState(conversationId); } catch (_) { /* module not loaded yet */ }
}

// ── Internal: read messages, preferring new table, lazy-migrating from blob ──

async function _readMessages(row, encryptionKey, sharedCtx = null) {
    // A project-shared conversation is opened with the PROJECT's key. Resolving
    // from the reader (or even from the owner's session key) would fail the
    // envelope, and the read path turns a decrypt failure into an empty
    // conversation — data loss presented as an empty chat.
    const ctx = sharedCtx || (row.crypto_scope === 'project' && row.project_id
        ? await resolveCrypto({ userId: row.user_id, projectKeyFor: { projectId: row.project_id } })
        : await resolveCrypto({ userId: row.user_id, encryptionKey }));

    // Phase 7a: Use the messages_migrated flag already present on the fetched row
    // instead of calling isMigrated() which fires an extra SELECT LIMIT 1 per read.
    if (row.messages_migrated) {
        try {
            return await convMessages.getMessages(row.id, ctx);
        } catch (e) {
            // A decrypt failure must NOT fall through to the blob and then
            // re-migrate — that path would overwrite good ciphertext with a
            // stale or empty copy. Only a genuine table/read error may fall back.
            if (e && e.code === 'FIELD_DECRYPT_FAILED') {
                log.error('[AgentConversations] Message decryption failed for', row.id, '-', e.message);
                throw e;
            }
            log.warn('[AgentConversations] New table read failed, using blob fallback:', e.message);
        }
    }

    // Legacy blob fallback (row not yet migrated, or new-table read failed)
    const messagesJson = decryptMessages(row.messages_json || '[]', encryptionKey, row.id, row.user_id);
    const messages = JSON.parse(messagesJson);

    // Kick off lazy migration in background — does not block the response.
    // Passing ctx matters: without it the migration would copy the decrypted
    // blob into the new table as plaintext, silently undoing encryption for
    // every conversation that gets read.
    convMessages.migrateConversationIfNeeded(row.id, 'agent', messages, ctx).catch(err =>
        log.error('[AgentConversations] Lazy migration error:', err.message)
    );

    return messages;
}

module.exports = {
    getConversation, getOrCreateConversation, createNewConversation,
    updateConversation, clearConversation, updateConversationWorkspace, getConversationWorkspace,
    listConversations, listAllConversations, searchConversations,
    getConversationById, createConversation,
    updateConversationTitle, pinConversation, setConversationLabels, updateThreadTitles, deleteConversationById,
    updateConversationMeta, getConversationMeta,
    // sharedConversations re-keys meta_json when crypto_scope flips and must
    // bind the SAME AAD this table uses — exported rather than copied.
    _metaAad,
};
