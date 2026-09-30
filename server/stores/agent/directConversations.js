// @typecheck
/**
 * Direct Conversations - Chat without an agent (direct LLM access)
 *
 * Phase 4: Dual-write architecture (same pattern as agentConversations.js).
 *   - Reads prefer conversation_messages table; fall back to messages_json blob.
 *   - Writes go to both; blob kept for rollback safety.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const convMessages = require('./conversationMessages');
const { decryptMessages } = require('./messageEncryption');
const { resolveCrypto, conversationKey } = require('./messageCrypto');
const { encryptField, decryptField, isEnvelope } = require('../lib/fieldEnvelope');
const { sealTitle, openTitle, openTitles } = require('./conversationTitle');
const { parseJSON } = require('../lib/json');
const { buildUpdate } = require('../lib/sqlBuilder');
// kbIdList, NOT kbSelection: the policy module pulls in the knowledge-base
// store (and through it server/db.js), and this store is deliberately cut off
// from the database at the require seam in its own tests. Shape only here;
// the access decision belongs to the caller.
const { normaliseKbIds } = require('../../core/kb/kbIdList');
const log = require('../../telemetry/log');

/**
 * Error thrown when a write reached zero rows.
 *
 * Every write here ends `AND user_id = $n` and returns `rowCount > 0`, and the
 * four call sites in directChat.js ignore that boolean. While conversations
 * were single-owner nothing could hit it. The moment a second person can post
 * into a thread, the failure mode is a fully streamed answer that was NEVER
 * PERSISTED, with no error anywhere — the user watches it appear and it is gone
 * on reload. Throwing makes that impossible to miss.
 */
class ConversationWriteDenied extends Error {
    constructor(id) {
        super(`Conversation ${id} is not writable by this caller`);
        this.name = 'ConversationWriteDenied';
        this.code = 'CONVERSATION_WRITE_DENIED';
    }
}

/**
 * Who owns this conversation, and which key opens it.
 *
 * Returns the OWNER's id, which is what every `user_id = $n` predicate in this
 * file is really keyed on — not the caller's. For a private conversation the
 * two are the same. For a project-shared one they are not, and using the
 * caller's id is exactly the bug that made a member's post silently write
 * nothing.
 *
 * The crypto context likewise comes from the ROW (`crypto_scope`), never from
 * the caller: member B writing with B's own key would re-encrypt A's whole
 * thread under a key A does not have.
 *
 * @returns {Promise<{ownerId, ctx, isShared, projectId}|null>} null = no access
 */
async function _resolveWriteContext(id, callerUserId, { encryptionKey = null } = {}) {
    let row;
    try {
        row = await getOne(
            'SELECT user_id, project_id, shared_scope, crypto_scope FROM direct_conversations WHERE id = $1',
            [id]
        );
    } catch (err) {
        // Pre-migration installs have no shared_scope/crypto_scope columns, and
        // on those every conversation is private by definition.
        if (!/column .* does not exist/i.test(err.message)) throw err;
        row = await getOne('SELECT user_id, project_id FROM direct_conversations WHERE id = $1', [id]);
        if (row) { row.shared_scope = 'private'; row.crypto_scope = 'user'; }
    }
    if (!row) return null;

    const isOwner = row.user_id === callerUserId;
    const isShared = row.shared_scope === 'project' && !!row.project_id;
    if (!isOwner) {
        if (!isShared) return null;
        const { hasProjectRole } = require('../../auth/projectAccess');
        if (!await hasProjectRole(callerUserId, row.project_id, 'editor')) return null;
    }

    const ctx = await _rowCrypto(row, encryptionKey);

    return { ownerId: row.user_id, ctx, isShared, projectId: row.project_id || null };
}

/**
 * Which key opens which column — the rule, in one place.
 *
 * SCOPED columns (`conversation_messages` rows and `meta_json`) follow the
 * row's `crypto_scope`: the project key once the conversation is shared,
 * because sharedConversations re-keys them at that moment. `_rowCrypto` is that
 * context. Resolving the owner key instead meant two writers sealing the SAME
 * meta_json under two different keys and each reader rejecting the other's
 * envelope — skill activations that silently stopped persisting, or a thread
 * that 500s for the owner and every project member.
 *
 * `title` does NOT follow crypto_scope, and must not. Titles are read by LIST
 * endpoints that resolve ONE context for a whole page — listDirectConversations
 * and searchDirectConversations both use the owner's — so a title that changed
 * key on sharing would render as `null` in the owner's own sidebar and drop out
 * of their search. Every title writer (createDirectConversation,
 * updateDirectConversationTitle) already seals with the owner's escrow key on
 * every tier; only this read path had drifted. See conversationTitle.js on why
 * titles ride ctx.backgroundKey rather than any session key.
 *
 * Note this decides the KEY only. It grants nobody access — the callers keep
 * their own `user_id = $n` / hasProjectRole predicates.
 */
function _rowCrypto(row, encryptionKey = null) {
    return row.crypto_scope === 'project' && row.project_id
        ? resolveCrypto({ userId: row.user_id, projectKeyFor: { projectId: row.project_id } })
        : resolveCrypto({ userId: row.user_id, encryptionKey });
}

/**
 * The OWNER's context — what `title` is sealed under, whatever the row's scope.
 *
 * The caller's session DEK is only forwarded when the caller IS the owner. On
 * `managed` that key doubles as the seed for a user's first escrow, so handing
 * a project member's DEK to resolveCrypto({ userId: <the owner> }) could mint
 * the OWNER's escrow from a key that is not theirs.
 */
function _ownerCrypto(row, callerUserId, encryptionKey = null) {
    return resolveCrypto({
        userId: row.user_id,
        encryptionKey: row.user_id === callerUserId ? encryptionKey : null,
    });
}

/**
 * Owner-scoped fetch of the columns the meta helpers need, tolerating a
 * pre-migration install that has no crypto_scope column (same fallback as
 * _resolveWriteContext — on those every conversation is private by definition).
 */
async function _getMetaRow(id, userId) {
    try {
        return await getOne(
            'SELECT meta_json, user_id, project_id, crypto_scope FROM direct_conversations WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
    } catch (err) {
        if (!/column .* does not exist/i.test(err.message)) throw err;
        const row = await getOne('SELECT meta_json, user_id FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
        if (row) { row.project_id = null; row.crypto_scope = 'user'; }
        return row;
    }
}

/**
 * Read a conversation the caller does not own but may see through a project.
 *
 * Returns null for anything private, so a member's own chats stay invisible to
 * the rest of the project even when they are filed under it — filing and
 * sharing are separate acts (see the shared_scope/crypto_scope note in
 * initSchema.js).
 */
async function _readSharedRow(id, viewerId) {
    if (!viewerId) return null;
    let row;
    try {
        row = await getOne(
            `SELECT * FROM direct_conversations
              WHERE id = $1 AND shared_scope = 'project' AND project_id IS NOT NULL`,
            [id]
        );
    } catch (err) {
        // Pre-migration install: no shared conversations can exist.
        if (/column .* does not exist/i.test(err.message)) return null;
        throw err;
    }
    if (!row) return null;
    const { hasProjectRole } = require('../../auth/projectAccess');
    if (!await hasProjectRole(viewerId, row.project_id, 'viewer')) return null;
    return row;
}

/**
 * AAD for the conversation-level meta_json blob on direct_conversations.
 *
 * Distinct from the agent side's `bfconvmeta:v1:` prefix on purpose: the two
 * tables have independent id spaces, and a shared AAD would let a meta blob
 * from one be replayed onto a same-id row in the other.
 */
function _directMetaAad(conversationId) {
    return `bfdirectmeta:v1:${conversationId}`;
}

/**
 * Parse direct meta_json, decrypting when the stored value is an envelope.
 *
 * meta_json carries conversation-scoped state (activatedSkillIds, the
 * compaction summary). This side was left on bare JSON.parse while the agent
 * side was wired, so the `conversationMeta` surface reported itself as
 * implemented and silently did nothing here.
 *
 * A decrypt failure THROWS rather than yielding `{}` — updateDirectConversationMeta
 * does a read-merge-write, so an empty read would overwrite the real meta with a
 * partial one and destroy whatever was in it.
 */
function _parseDirectMeta(metaJson, conversationId = null, ctx = null) {
    let raw = metaJson;
    if (conversationId && isEnvelope(raw)) {
        // backgroundKey, not key — see agentConversations._parseMeta.
        const root = (ctx && (ctx.backgroundKey || ctx.key)) || null;
        raw = decryptField(raw, {
            key: root ? conversationKey(root, conversationId) : null,
            aad: _directMetaAad(conversationId),
        });
    }
    try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

/** Serialise direct meta_json, encrypting when the policy says to. */
function _serialiseDirectMeta(metaObj, conversationId, ctx) {
    return encryptField(JSON.stringify(metaObj), {
        key: ctx && ctx.backgroundKey ? conversationKey(ctx.backgroundKey, conversationId) : null,
        aad: _directMetaAad(conversationId),
        encrypt: !!(ctx && ctx.encryptConversationMeta),
    });
}
// Replace [email_N] / [phone_N] etc. tokens with the real values stored in
// the per-message tokenMap. Idempotent — messages without a tokenMap pass
// through unchanged. Only used on the UI-display read path; the LLM
// history loader passes restore=false so Claude keeps seeing tokens.
// Lazy-require inside the function: same circular-dep reason as
// piiDetection.js→aiAgent — capturing a destructure at module load
// can grab a stale snapshot of the cycle's partial exports.
function _restoreTokensInMessages(messages, convTokenMap = null) {
    if (!Array.isArray(messages)) return messages;
    const restoreTokens = require('../../core/privacy/piiDetection').restoreTokens;
    if (typeof restoreTokens !== 'function') return messages;
    const convMapHasEntries = convTokenMap && typeof convTokenMap === 'object' && Object.keys(convTokenMap).length > 0;
    return messages.map(m => {
        if (!m || typeof m.content !== 'string') return m;
        // User messages: use the per-message tokenMap (existing behaviour).
        // Each user turn captured the message-level tokens at the moment it
        // was tokenised — that's a stable, self-contained mapping.
        if (m.role === 'user' && m.tokenMap && Object.keys(m.tokenMap).length > 0) {
            try {
                return { ...m, content: restoreTokens(m.content, m.tokenMap) };
            } catch (e) { /* fall through with original */ }
        }
        // Assistant messages: use the conversation-level token map. Assistant
        // tokens come from attachment scans + cross-turn message PII and are
        // not stashed per-message. Without this branch, an assistant response
        // referencing `[person_N]` would be displayed as raw placeholders on
        // a conversation reload.
        if (m.role === 'assistant' && convMapHasEntries) {
            try {
                return { ...m, content: restoreTokens(m.content, convTokenMap) };
            } catch (e) { /* fall through with original */ }
        }
        return m;
    });
}

/**
 * True when Postgres is telling us `knowledge_base_ids` has not landed yet.
 * The column arrives on the first boot AFTER a deploy, so every statement that
 * names it has to survive the window before that boot — the same
 * `column … does not exist` fallback the shared-scope columns use above.
 */
function _missingKbColumn(err) {
    return /column .* does not exist/i.test(err?.message || '');
}

/**
 * ATTACHED KNOWLEDGE BASES ARE AN AUTHORISED LIST, AND THIS STORE DOES NOT
 * AUTHORISE.
 *
 * Callers MUST have run the list through `core/kb/kbSelection.resolveUsableKbIds`
 * (or its request-shaped wrapper `support/kbAccess.usableKbIdsForRequest`)
 * first. What the store guarantees is only that it never WIDENS what it is
 * handed: non-strings, blanks and duplicates are dropped and the list is
 * capped, so an unreadable input becomes an EMPTY list rather than a
 * passed-through one.
 *
 * The reason the store cannot be the gate: the answer depends on WHO is
 * asking, which is a request-level fact (org ids, group membership,
 * org-admin status) the store has no access to.
 */

/**
 * @param {string} userId
 * @param {string} [modelTier]
 * @param {string[]} [knowledgeBaseIds] ALREADY-AUTHORISED ids — see the note above.
 */
async function createDirectConversation(userId, modelTier = 'fast', knowledgeBaseIds = []) {
    await initDB();
    const id = uuidv4();
    const ctx = await resolveCrypto({ userId });
    const title = sealTitle('New Chat', id, 'direct', ctx);
    const kbIds = normaliseKbIds(knowledgeBaseIds);
    try {
        await run("INSERT INTO direct_conversations (id, user_id, title, messages_json, model_tier, knowledge_base_ids, created_at, updated_at) VALUES ($1,$2,$3,'[]',$4,$5::jsonb,NOW(),NOW())",
            [id, userId, title, modelTier, JSON.stringify(kbIds)]);
        return { id, title: 'New Chat', messages: [], model_tier: modelTier, knowledgeBaseIds: kbIds };
    } catch (err) {
        // Pre-migration install: create the conversation anyway, without the
        // attachment. Losing the chat because a column has not landed yet
        // would be a far worse failure than starting it with no bases — and
        // reporting the empty list back keeps the caller honest about it.
        if (!_missingKbColumn(err)) throw err;
        await run("INSERT INTO direct_conversations (id, user_id, title, messages_json, model_tier, created_at, updated_at) VALUES ($1,$2,$3,'[]',$4,NOW(),NOW())",
            [id, userId, title, modelTier]);
        return { id, title: 'New Chat', messages: [], model_tier: modelTier, knowledgeBaseIds: [] };
    }
}

/**
 * Replace the knowledge bases attached to a conversation. THE OWNER ONLY.
 *
 * `AND user_id = $n`, like every other write in this file, and here that
 * predicate is the whole access decision. A conversation shared into a project
 * may be POSTED into by any editor (_resolveWriteContext), but which knowledge
 * bases it may search is `canManage` territory — the same line the workspace
 * draws (see updateDirectConversationWorkspace): the owner may be able to read
 * a base the editor cannot, so letting an editor rewrite this list would let
 * them point the owner's thread at bases nobody authorised for THEM.
 *
 * `userId` is REQUIRED and this throws when it is missing rather than falling
 * back to an unscoped UPDATE — a scoping parameter that degrades to "no scope"
 * is not a scope.
 *
 * @param {string} id
 * @param {string[]} knowledgeBaseIds ALREADY-AUTHORISED ids.
 * @param {string} userId the CALLER; must be the owner for the write to land.
 * @returns {Promise<boolean>} false when nothing was written — meaning the
 *   caller is not the owner, or there is no such conversation. A missing
 *   column THROWS `KB_COLUMN_MISSING` instead of returning false: those are
 *   different failures and a route that reports "you are not the owner" for a
 *   schema that has not migrated yet is telling the user something untrue.
 */
async function setDirectConversationKnowledgeBases(id, knowledgeBaseIds, userId) {
    if (typeof userId !== 'string' || !userId) {
        throw Object.assign(
            new TypeError('setDirectConversationKnowledgeBases requires the caller userId — attached knowledge bases are owner-only and there is no unscoped form'),
            { code: 'CALLER_USER_ID_REQUIRED' }
        );
    }
    await initDB();
    const kbIds = normaliseKbIds(knowledgeBaseIds);
    try {
        const { rowCount } = await run(
            'UPDATE direct_conversations SET knowledge_base_ids = $1::jsonb WHERE id = $2 AND user_id = $3',
            [JSON.stringify(kbIds), id, userId]
        );
        return rowCount > 0;
    } catch (err) {
        if (!_missingKbColumn(err)) throw err;
        log.warn('[DirectConversations] knowledge_base_ids column not present yet — attachment not stored');
        throw Object.assign(
            new Error('direct_conversations.knowledge_base_ids has not been migrated yet'),
            { code: 'KB_COLUMN_MISSING' }
        );
    }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.restore=true]
 * @param {string|null} [options.encryptionKey] the caller's session DEK.
 *   REQUIRED on the `zk` tier: there is no escrow to fall back on, so without
 *   it `resolveCrypto` yields no key, `decryptField` refuses to open the
 *   envelope, and the read throws instead of returning the conversation. Every
 *   route that loads a direct conversation must pass `encryptionOpts(req)`.
 */
async function getDirectConversation(id, userId, options = {}) {
    await initDB();
    // `restore` defaults to true: most callers (UI render, listings, search)
    // expect tokens already mapped back to real values. The LLM-history
    // loader in directChat.js passes `restore: false` so Claude continues
    // to see [email_N] tokens on follow-up turns.
    const restore = options.restore !== false;
    const encryptionKey = options.encryptionKey || null;
    // Owner path first — a single index lookup, and the overwhelmingly common
    // case. A project member falls through to the shared read below.
    let row = await getOne('SELECT * FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) {
        row = await _readSharedRow(id, userId);
        if (!row) return null;
    }
    // A project member's own session key is never offered to the OWNER's
    // crypto context (see _ownerCrypto): on `managed` it could seed the
    // owner's escrow, and it opens nothing of theirs anyway. A shared row
    // written under the owner's key (shared while encryption was off) is then
    // read with the owner's escrow, as a background job would read it.
    const readerKey = row.user_id === userId ? encryptionKey : null;
    // Resolved once and shared: on `managed` each call unwraps the escrowed
    // DEK, so resolving separately per surface would double that work on every
    // conversation load.
    //
    // For a project-shared conversation the key belongs to the PROJECT — the
    // reader's own key would fail the envelope, which the read path surfaces as
    // an empty conversation rather than an error.
    const ctx = await _rowCrypto(row, readerKey);
    // Titles are owner-keyed on every tier and every scope — see _rowCrypto.
    // Reusing `ctx` here opened a shared thread's title with the PROJECT key and
    // openTitle swallowed the failure, so every shared thread lost its name.
    const titleCtx = row.crypto_scope === 'project' && row.project_id
        ? await _ownerCrypto(row, userId, encryptionKey)
        : ctx;
    const meta = _parseDirectMeta(row.meta_json, row.id, ctx);
    let messages = await _readDirectMessages(row, readerKey, ctx);
    if (restore) {
        // The conversation-level pii_token_map covers assistant tokens that
        // span turns (attachment scans + cross-turn message PII). User
        // messages still consult their per-row tokenMap inside the helper.
        messages = _restoreTokensInMessages(messages, row.pii_token_map || null);
    }
    // `title` after the meta spread: meta must not be able to shadow it.
    //
    // `knowledgeBaseIds` is here for exactly the same reason. meta_json is
    // caller-supplied state (skill activations, compaction summaries) and it is
    // spread AFTER the row, so a meta key of this name would quietly replace
    // the column that says which knowledge bases this conversation may search.
    // Restored last, from the column, always.
    //
    // NOTE FOR CALLERS: this is the STORED list — authorised when it was
    // written, which is not the same as authorised now. A base can be
    // unpublished, moved out of a group or deleted afterwards. Anything that
    // hands these ids to retrieval, or shows them to a person, MUST re-run
    // core/kb/kbSelection.resolveUsableKbIds over them first.
    return {
        ...row, messages, meta, ...meta,
        title: openTitle(row.title, row.id, 'direct', titleCtx),
        knowledgeBaseIds: normaliseKbIds(parseJSON(row.knowledge_base_ids, [])),
    };
}

/**
 * Read ONLY the conversation's meta (no message load). Used by directChat to
 * restore conversation-scoped state (e.g. activatedSkillIds) before tool
 * assembly.
 */
async function getDirectConversationMeta(id, userId, options = {}) {
    await initDB();
    const row = await _getMetaRow(id, userId);
    if (!row) return null;
    // The key comes from the ROW, not the caller — a project-shared thread's
    // meta_json is sealed under the project key by updateDirectConversation and
    // opened under it by getDirectConversation.
    const ctx = await _rowCrypto(row, options.encryptionKey || null);
    return _parseDirectMeta(row.meta_json, id, ctx);
}

async function updateDirectConversationMeta(id, userId, partial, options = {}) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0) return false;
    await initDB();
    const existing = await _getMetaRow(id, userId);
    if (!existing) return false;
    const ctx = await _rowCrypto(existing, options.encryptionKey || null);
    const merged = { ..._parseDirectMeta(existing.meta_json, id, ctx), ...partial };
    const { rowCount } = await run('UPDATE direct_conversations SET meta_json = $1 WHERE id = $2 AND user_id = $3',
        [_serialiseDirectMeta(merged, id, ctx), id, userId]);
    return rowCount > 0;
}

async function listDirectConversations(userId) {
    await initDB();
    const rows = await getAll('SELECT id, title, model_tier, project_id, shared_scope, pinned, labels_json, created_at, updated_at FROM direct_conversations WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return openTitles(rows, 'direct', await resolveCrypto({ userId }));
}

async function searchDirectConversations(userId, query, filters = {}, encryptionKey) {
    await initDB();

    const likeQuery = `%${query}%`;
    const lowerQuery = query.toLowerCase();

    const filterParams = [userId];
    let filterClauses = '';
    let filterIdx = 2;
    if (filters.startDate) { filterClauses += ` AND c.updated_at >= $${filterIdx++}`; filterParams.push(filters.startDate); }
    if (filters.endDate) { filterClauses += ` AND c.updated_at <= $${filterIdx++}`; filterParams.push(filters.endDate); }
    const likeIdx = filterIdx;

    // Strategy A: title OR migrated message content
    const stratA = await getAll(`
        SELECT DISTINCT
            c.id, c.user_id, c.title, c.updated_at, c.model_tier,
            c.messages_migrated
        FROM direct_conversations c
        LEFT JOIN conversation_messages cm
            ON cm.conversation_id = c.id
           AND cm.conversation_type = 'direct'
           AND c.messages_migrated = TRUE
        WHERE c.user_id = $1
          AND (c.title ILIKE $${likeIdx} OR cm.content ILIKE $${likeIdx})
          ${filterClauses}
        ORDER BY c.updated_at DESC
        LIMIT 50
    `, [...filterParams, likeQuery]);

    const results = [...stratA];
    const matchedIds = new Set(results.map(r => r.id));

    // Strategy A2: migrated conversations whose content is ENCRYPTED.
    // `cm.content ILIKE` above matches nothing against ciphertext (and the GIN
    // trigram index on that column is equally useless), so without this pass
    // conversation search would silently degrade to title-only the moment the
    // messages surface is switched on. Decrypt a bounded candidate set in the
    // app instead — the same approach the legacy encrypted branch below uses.
    const searchCtx = await resolveCrypto({ userId, encryptionKey });
    if (searchCtx.encryptMessages || searchCtx.encryptTitle) {
        const encCandidates = await getAll(`
            SELECT c.id, c.user_id, c.title, c.updated_at, c.model_tier, c.messages_migrated
            FROM direct_conversations c
            WHERE c.user_id = $1
              ${searchCtx.encryptMessages ? 'AND c.messages_migrated = TRUE' : ''}
              ${filterClauses}
            ORDER BY c.updated_at DESC
            LIMIT 200
        `, filterParams);
        let added = 0;
        for (const conv of encCandidates) {
            if (matchedIds.has(conv.id)) continue;
            try {
                const title = openTitle(conv.title, conv.id, 'direct', searchCtx);
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
                // One unreadable conversation must not fail the whole search.
                log.error('[DirectConversations] Search decrypt error for', conv.id, '-', e.message);
            }
        }
    }

    if (!encryptionKey) {
        const stratB = await getAll(`
            SELECT
                c.id, c.user_id, c.title, c.updated_at, c.model_tier,
                c.messages_migrated
            FROM direct_conversations c
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
        const encCandidates = await getAll(`
            SELECT
                c.id, c.user_id, c.title, c.updated_at, c.model_tier,
                c.messages_json, c.messages_migrated
            FROM direct_conversations c
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
                log.error('[DirectConversations] Search decrypt error:', e);
            }
        }
    }

    return openTitles(results, 'direct', searchCtx)
        .sort((a, b) => /** @type {any} */ (new Date(b.updated_at)) - /** @type {any} */ (new Date(a.updated_at)))
        .slice(0, 50)
        .map(r => ({
            id: r.id,
            user_id: r.user_id,
            title: r.title,
            updated_at: r.updated_at,
            model_tier: r.model_tier,
            kind: 'direct',
            agent_name: 'Direct Chat',
            agent_avatar: null,
        }));
}

async function pinDirectConversation(id, pinned, userId) {
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET pinned = $1 WHERE id = $2 AND user_id = $3', [!!pinned, id, userId]);
    return rowCount > 0;
}

async function setDirectConversationLabels(id, labels, userId) {
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET labels_json = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(labels), id, userId]);
    return rowCount > 0;
}

/**
 * Append only the messages the caller has that the DB does not.
 *
 * Callers hand us the FULL conversation array — that is the shape the chat
 * routes have always built. For a shared thread we cannot write that array
 * wholesale, so we diff it against what is stored and append the tail.
 *
 * If the caller's array is SHORTER than what is stored, that is not a stale
 * read — it is an edit, a retry, or a compaction deliberately truncating
 * history. Those legitimately rewrite, so they fall back to replace.
 */
async function _appendNewMessages(id, type, messages, ctx) {
    const stored = await convMessages.getMessages(id, ctx).catch(() => null);
    const storedCount = Array.isArray(stored) ? stored.length : 0;

    if (!Array.isArray(messages) || messages.length < storedCount) {
        return convMessages.replaceMessages(id, type, messages || [], ctx);
    }
    const tail = messages.slice(storedCount);
    if (tail.length === 0) return;
    return convMessages.appendMessages(id, type, tail, ctx);
}

/**
 * Phase 4 dual-write: write to conversation_messages (new) + messages_json blob (legacy).
 */
async function updateDirectConversation(id, messages, userId, meta = null, options = {}) {
    await initDB();

    // Owner + key come from the ROW, not the caller — see _resolveWriteContext.
    const access = await _resolveWriteContext(id, userId, options);
    if (!access) throw new ConversationWriteDenied(id);
    const { ownerId, ctx, isShared } = access;

    // ── New table write (Phase 4) ────────────────────────────────────────────
    // Reads prefer this table once migrated, so it is the copy that carries the
    // encryption.
    //
    // SHARED threads APPEND rather than replace. replaceMessages is a full
    // DELETE + re-INSERT of the array the caller happens to be holding, and in
    // a shared thread that array can already be stale — if Alice posted while
    // Bob had the thread open, Bob's write would delete her message outright.
    // Appending only what is new makes the stored rows the source of truth.
    // A private conversation keeps the replace path unchanged.
    const writeMessages = isShared
        ? () => _appendNewMessages(id, 'direct', messages, ctx)
        : () => convMessages.replaceMessages(id, 'direct', messages, ctx);
    await writeMessages().catch(err =>
        log.error('[DirectConversations] conversation_messages write error:', err.message)
    );

    // ── Legacy blob ───────────────────────────────────────────────────────────
    // The blob was a rollback path for the Phase-4 migration and was written
    // with a bare JSON.stringify — a COMPLETE PLAINTEXT COPY of the whole
    // conversation, on every tier, sitting beside the encrypted table. Whatever
    // conversation_messages protects, this column handed straight back.
    //
    // Once `messages_migrated` is true the blob is never read (see
    // _readDirectMessages), so it is pure leak. Stop writing it; blankMessageBlobs()
    // clears what is already there.
    // Every predicate below keys on the OWNER. Passing the caller's id worked
    // only while the two were always the same person.
    const migrated = await _isMigrated(id, ownerId);
    const blobSql = migrated ? null : JSON.stringify(messages);

    let rowCount;
    if (meta && Object.keys(meta).length > 0) {
        const existing = await getOne('SELECT meta_json FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, ownerId]);
        const merged = { ..._parseDirectMeta(existing?.meta_json, id, ctx), ...meta };
        const storedMeta = _serialiseDirectMeta(merged, id, ctx);
        ({ rowCount } = migrated
            ? await run('UPDATE direct_conversations SET meta_json = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
                [storedMeta, id, ownerId])
            : await run('UPDATE direct_conversations SET messages_json = $1, meta_json = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
                [blobSql, storedMeta, id, ownerId]));
    } else {
        ({ rowCount } = migrated
            ? await run('UPDATE direct_conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [id, ownerId])
            : await run('UPDATE direct_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [blobSql, id, ownerId]));
    }

    // Reaching zero rows here means the conversation vanished between the
    // access check and the write. Returning false would let the caller stream a
    // complete answer that was never saved.
    if (rowCount === 0) throw new ConversationWriteDenied(id);
    return true;
}

/**
 * Has this conversation been migrated to conversation_messages?
 *
 * Read straight from the parent row rather than trusting a caller-supplied
 * flag: this decides whether the plaintext blob gets written, and defaulting
 * the wrong way would silently reinstate the leak.
 */
async function _isMigrated(id, userId) {
    const row = await getOne('SELECT messages_migrated FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    return !!row?.messages_migrated;
}

async function updateDirectConversationTitle(id, title, userId) {
    await initDB();
    const ctx = await resolveCrypto({ userId });
    const { rowCount } = await run('UPDATE direct_conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [sealTitle(title, id, 'direct', ctx), id, userId]);
    return rowCount > 0;
}

async function updateDirectConversationModelTier(id, modelTier, userId) {
    if (!modelTier) return false;
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET model_tier = $1 WHERE id = $2 AND user_id = $3', [modelTier, id, userId]);
    return rowCount > 0;
}

/**
 * Delete a conversation the caller OWNS.
 *
 * The ownership check comes FIRST, before any destructive statement. The
 * message wipe below keys on the conversation id alone — there is no user_id on
 * conversation_messages to scope it with — so running it ahead of the scoped
 * parent delete let anyone who merely knew an id destroy the owner's messages
 * and their DLP token map, then receive a 404 as if nothing had happened. Ids
 * of project-shared threads are handed to every project VIEWER by
 * GET /api/projects/:id/threads, so that was a low-privilege cross-tenant
 * destructive write, silent and (on the zk tier) unrecoverable.
 *
 * Same load-and-verify-then-delete order as notebookStore.deleteNotebook and
 * webpageStore.deleteWebpage.
 */
async function deleteDirectConversation(id, userId) {
    await initDB();
    const owned = await getOne('SELECT id FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!owned) return false;

    await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [id]).catch(() => {});
    const { rowCount } = await run('DELETE FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    // Drop any cached DLP state for this conversation. Also unscoped by id (it
    // nulls pii_token_map on BOTH conversation tables), hence likewise gated on
    // the ownership check above.
    try { require('../../core/dlp/dlpRunner').clearConversationState(id); } catch (_) { /* module not loaded yet */ }
    return rowCount > 0;
}

/** Same cap the agent twin's route enforces (routes/agents/conversations.js:28). */
const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024;

const WORKSPACE_COLUMNS = { content: 'workspace_content', notebookId: 'workspace_notebook_id' };

/**
 * Write a conversation's workspace. THE OWNER ONLY.
 *
 * `userId` is the caller's id and it is REQUIRED — it becomes the same
 * `AND user_id = $n` predicate every other write in this file carries, so the
 * statement matches only when the caller IS the owner. The workspace is
 * `canManage` territory (conversationAccess.js: canPost is editor+, canManage
 * is the owner only), and the route that reaches here gates on
 * getDirectConversation, which deliberately admits any project VIEWER of a
 * shared thread. Without the predicate a read-only member overwrote the owner's
 * workspace_content and repointed workspace_notebook_id, with no audit trail.
 *
 * It THROWS when the caller id is missing rather than falling back to an
 * unscoped UPDATE. An earlier revision made the argument optional "so the store
 * could land ahead of its caller"; the caller never changed, so every real
 * request kept taking the unscoped branch while the tests — which passed the
 * argument — reported the hole closed. A scoping parameter that degrades to
 * "no scope" is not a scope. The one production caller,
 * routes/ai/directChat.js:4639 (PUT /direct/conversations/:id/workspace), must
 * pass `req.session.user.id`; until it does, that endpoint 500s instead of
 * quietly writing another user's row.
 *
 * The type/size checks are the ones the agent twin does at its route
 * (routes/agents/conversations.js:205-210) and the direct route does not: they
 * belong on the write itself, not on one of two call paths.
 *
 * @returns {Promise<boolean>} false when the caller does not own the row.
 */
async function updateDirectConversationWorkspace(id, content, notebookId = null, userId = undefined) {
    if (typeof userId !== 'string' || !userId) {
        throw Object.assign(
            new TypeError('updateDirectConversationWorkspace requires the caller userId — the workspace is owner-only and there is no unscoped form'),
            { code: 'CALLER_USER_ID_REQUIRED' }
        );
    }
    const body = content === null || content === undefined ? '' : content;
    if (typeof body !== 'string') {
        throw Object.assign(new TypeError('workspace content must be a string'), { code: 'INVALID_WORKSPACE_CONTENT' });
    }
    if (body.length > MAX_WORKSPACE_BYTES) {
        throw Object.assign(
            new RangeError(`workspace content exceeds ${MAX_WORKSPACE_BYTES} bytes`),
            { code: 'WORKSPACE_CONTENT_TOO_LARGE' }
        );
    }

    await initDB();
    const built = buildUpdate({
        table: 'direct_conversations',
        // `null` is this signature's "leave the pointer alone"; only a real id
        // (or the caller's own undefined) reaches the column.
        updates: { content: body, notebookId: notebookId === null ? undefined : notebookId },
        columnMap: WORKSPACE_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'user_id', value: userId }],
    });
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

async function getDirectConversationWorkspace(id) {
    await initDB();
    const row = await getOne('SELECT workspace_content, workspace_notebook_id FROM direct_conversations WHERE id = $1', [id]);
    return row ? { content: row.workspace_content || '', notebookId: row.workspace_notebook_id || null } : null;
}

/**
 * Resolve the owner of a conversation id WITHOUT scoping to a caller, across
 * both conversation tables.
 *
 * Used to tell "this id doesn't exist yet" (fine — a new conversation) apart
 * from "this id exists and belongs to someone else" (an attempt to borrow
 * another user's conversation, which the notebook tools would then resolve).
 * Returns `null` when no such conversation exists anywhere.
 */
async function getConversationOwnerId(id) {
    await initDB();
    if (!id) return null;
    const agent = await getOne('SELECT user_id FROM agent_conversations WHERE id = $1', [id]);
    if (agent) return agent.user_id || null;
    const direct = await getOne('SELECT user_id FROM direct_conversations WHERE id = $1', [id]);
    return direct ? (direct.user_id || null) : null;
}

// ── Internal: read from new table first, lazy-migrate from blob if needed ────

async function _readDirectMessages(row, encryptionKey = null, sharedCtx = null) {
    const ctx = sharedCtx || await resolveCrypto({ userId: row.user_id, encryptionKey });

    // Phase 7a: row.messages_migrated is already fetched on the parent SELECT *,
    // so we check the flag directly — no extra SELECT LIMIT 1 round-trip.
    if (row.messages_migrated) {
        try {
            return await convMessages.getMessages(row.id, ctx);
        } catch (e) {
            // Never fall through to the blob on a decrypt failure — the lazy
            // migration below would then overwrite good ciphertext with a
            // stale copy.
            if (e && e.code === 'FIELD_DECRYPT_FAILED') {
                log.error('[DirectConversations] Message decryption failed for', row.id, '-', e.message);
                throw e;
            }
            log.warn('[DirectConversations] New table read failed, using blob fallback:', e.message);
        }
    }

    // Legacy blob fallback
    const messages = JSON.parse(row.messages_json || '[]');

    // Lazy migration (non-blocking). ctx must be passed or the migration would
    // write the decrypted blob into the new table as plaintext.
    convMessages.migrateConversationIfNeeded(row.id, 'direct', messages, ctx).catch(err =>
        log.error('[DirectConversations] Lazy migration error:', err.message)
    );

    return messages;
}

module.exports = {
    createDirectConversation, getDirectConversation, listDirectConversations,
    updateDirectConversation, updateDirectConversationTitle, updateDirectConversationModelTier, pinDirectConversation, setDirectConversationLabels, setDirectConversationKnowledgeBases, deleteDirectConversation,
    updateDirectConversationWorkspace, getDirectConversationWorkspace, getConversationOwnerId,
    searchDirectConversations, updateDirectConversationMeta, getDirectConversationMeta,
    // Exposed so agentConversations.js can reuse the same restore logic.
    _restoreTokensInMessages,
    // Shared-thread plumbing, reused by agentConversations.js and asserted on
    // by the chat routes (they map the code onto an SSE error frame).
    ConversationWriteDenied,
    _resolveWriteContext,
    _appendNewMessages,
    // sharedConversations re-keys meta_json when crypto_scope flips, and must
    // bind the SAME AAD this table uses. Exported rather than copied — a second
    // copy of the prefix would open the replay hole _directMetaAad exists to close.
    _directMetaAad,
};
