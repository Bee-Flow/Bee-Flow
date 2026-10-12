// @typecheck
/**
 * Sharing a conversation into a project, and reading a project's shared threads.
 *
 * ── Sharing re-encrypts, it does not annotate ───────────────────────────────
 *
 * A private conversation is encrypted with its owner's key; a shared one with
 * the project's (auth/projectEscrow.js). Sharing therefore has to REWRITE every
 * column the readers pick by `crypto_scope`, not just flip a flag: the
 * conversation_messages rows AND the conversation-level `meta_json` (compaction
 * summary, activated skills and tool groups). Re-keying only the first left
 * meta_json sealed under a key no reader of that row used any more, and
 * getDirectConversation turned that into an HTTP 500 for the owner and every
 * project member.
 *
 * `title` is the one encrypted column that deliberately does NOT move. It is
 * read by the per-user list endpoints, which resolve ONE owner context for a
 * whole page, so a title that changed key on sharing would render as `null` in
 * the owner's own sidebar and drop out of their search. listProjectThreads
 * therefore opens titles with each thread owner's context, not the project's.
 *
 * The alternative — remember that older rows use the old key and try both on
 * read — was rejected. `decryptField` throws by design, so "try both" means
 * catching FieldDecryptError and guessing, which is precisely the silent
 * degradation the crypto layer's guards exist to prevent, and it makes every
 * future read of every shared thread ambiguous forever. Converting once,
 * atomically, keeps `crypto_scope` an honest description of what is on disk.
 *
 * ── The consequence: only the owner can share ───────────────────────────────
 *
 * Re-encryption has to READ the existing messages first. On the `zk` tier the
 * key for that is the owner's session DEK, which exists only while they are
 * logged in. So sharing is an owner action, performed live. That is also the
 * right product rule — sharing a conversation exposes what the owner wrote —
 * but it is worth being clear that it is a technical constraint too.
 */

const { getOne, getAll, run } = require('../../db');
const convMessages = require('./conversationMessages');
const { resolveCrypto, conversationKey } = require('./messageCrypto');
const { encryptField, decryptField, isEnvelope } = require('../lib/fieldEnvelope');
const { openTitle } = require('./conversationTitle');
const { tableFor } = require('./conversationAccess');
const log = require('../../telemetry/log');

/**
 * The AAD the owning store binds its meta_json to. Fetched from that store
 * rather than re-spelled here: a second copy of the prefix would reopen the
 * cross-table replay hole the two distinct prefixes exist to close.
 */
function _metaAadFor(type, conversationId) {
    return type === 'agent'
        ? require('./agentConversations')._metaAad(conversationId)
        : require('./directConversations')._directMetaAad(conversationId);
}

/** Read key for meta_json: backgroundKey, falling back to key. Matches _parseMeta. */
function _metaReadKey(ctx, conversationId) {
    const root = (ctx && (ctx.backgroundKey || ctx.key)) || null;
    return root ? conversationKey(root, conversationId) : null;
}

/** Write key for meta_json: backgroundKey only. Matches _serialiseDirectMeta. */
function _metaWriteKey(ctx, conversationId) {
    return ctx && ctx.backgroundKey ? conversationKey(ctx.backgroundKey, conversationId) : null;
}

/**
 * Re-seal `meta_json` from one context to the other.
 *
 * meta_json follows `crypto_scope` exactly as the message rows do — it carries
 * the compaction summary, activated skills and tool groups, which is
 * conversation content — so a share that re-keyed only conversation_messages
 * left the column sealed under a key no reader of that row uses any more.
 * getDirectConversation then threw FieldDecryptError straight out into an HTTP
 * 500 for the owner AND every project member.
 *
 * `title` is deliberately NOT re-keyed: it stays on the owner's escrow key at
 * every scope, because the conversation LIST endpoints resolve one owner
 * context for a whole page. See directConversations._rowCrypto.
 *
 * Best-effort by design: a column we cannot open is LEFT ALONE. Writing `{}`
 * over it would destroy the summary, and aborting the share would strand a
 * conversation whose message rows have already been converted.
 */
async function _rekeyMeta(table, type, conversationId, fromCtx, toCtx) {
    const row = await getOne(`SELECT meta_json FROM ${table} WHERE id = $1`, [conversationId]);
    // Plaintext or absent meta needs no conversion — reads are format-driven.
    if (!row || !isEnvelope(row.meta_json)) return false;

    const aad = _metaAadFor(type, conversationId);
    let plain;
    try {
        plain = decryptField(row.meta_json, { key: _metaReadKey(fromCtx, conversationId), aad });
    } catch (err) {
        // One bounded check, not a permanent "try both": a value that already
        // opens under the TARGET key is a row left mis-keyed by the bug this
        // function fixes. It is already where we want it, so leave it.
        try {
            decryptField(row.meta_json, { key: _metaReadKey(toCtx, conversationId), aad });
            return false;
        } catch (_) { /* genuinely unreadable — fall through to the warning */ }
        log.warn(`[SharedConversations] meta_json for ${conversationId} could not be re-keyed: ${err.message}`);
        return false;
    }

    // A re-key NEVER downgrades what is already on disk. We are only here
    // because the stored value WAS an envelope, so it is re-sealed as one
    // whenever a key exists — even if the CONVERSATION_META surface has since
    // been switched off. Following the current surface flag instead meant that
    // sharing or unsharing a thread rewrote a previously encrypted compaction
    // summary (conversation content) as plaintext at rest, triggered by an
    // action that is not a meta write of the user's own and with nothing said
    // about it anywhere. Reads are format-driven (isEnvelope), so the envelope
    // is opened by exactly the same code either way; the flag governs NEW
    // values, which is where the operator's choice actually belongs.
    //
    // With no key at all — the org moved to tier `none`, so nobody holds
    // anything that could open a new envelope — sealing would emit a value
    // nobody can read, which this module never does. Plaintext is then the only
    // readable form and is that tier's stated posture, so we write it and say so.
    const writeKey = _metaWriteKey(toCtx, conversationId);
    if (!writeKey) {
        log.warn(`[SharedConversations] meta_json for ${conversationId} re-keyed to PLAINTEXT: the target context has no key (tier 'none')`);
    }
    const sealed = encryptField(plain, { key: writeKey, aad, encrypt: !!writeKey });
    await run(`UPDATE ${table} SET meta_json = $1 WHERE id = $2`, [sealed, conversationId]);
    return true;
}

/**
 * Conversations shared into a project, newest first.
 *
 * The first query in the codebase that selects conversations BY PROJECT rather
 * than by user. Everything else filters on user_id, which is why two people in
 * one project each saw only their own chats.
 *
 * Titles are decrypted HERE, with each thread OWNER's context — not the
 * project's. Sharing re-keys the message rows and meta_json; the title stays on
 * the owner's escrow key at every scope, because the per-user list endpoints
 * resolve one owner context for a whole page (see directConversations._rowCrypto).
 * Returning the column raw meant the project Threads tab rendered the
 * `{"_bfenc":1,...}` envelope as the thread's name — the `|| untitled` fallback
 * never fires, because the ciphertext string is truthy.
 *
 * One resolve per distinct owner, not per row: on `managed` each one unwraps
 * that user's escrowed DEK. A title that will not open resolves to null (see
 * openTitle) so one bad row cannot take down the listing.
 */
async function listProjectThreads(projectId, { limit = 50, offset = 0 } = {}) {
    if (!projectId) return [];
    const capped = Math.min(Math.max(1, limit), 200);

    // agent_id is part of the contract: the workspace opens an agent thread
    // through its agent, and without it no shared agent chat could be opened
    // from a project, not even by its owner.
    const rows = await getAll(`
        SELECT id, user_id, title, project_id, updated_at, created_at, NULL::text AS agent_id, 'direct' AS conv_type
          FROM direct_conversations
         WHERE project_id = $1 AND shared_scope = 'project'
        UNION ALL
        SELECT id, user_id, title, project_id, updated_at, created_at, agent_id::text AS agent_id, 'agent' AS conv_type
          FROM agent_conversations
         WHERE project_id = $1 AND shared_scope = 'project'
         ORDER BY updated_at DESC, id
         LIMIT $2 OFFSET $3
    `, [projectId, capped, Math.max(0, offset)]);

    const ctxByOwner = new Map();
    for (const r of rows) {
        if (!isEnvelope(r.title) || ctxByOwner.has(r.user_id)) continue;
        ctxByOwner.set(r.user_id, await resolveCrypto({ userId: r.user_id }));
    }

    return rows.map(r => ({
        id: r.id,
        type: r.conv_type,
        ownerId: r.user_id,
        agentId: r.conv_type === 'agent' ? (r.agent_id || null) : null,
        projectId: r.project_id,
        title: isEnvelope(r.title)
            ? openTitle(r.title, r.id, r.conv_type, ctxByOwner.get(r.user_id))
            : r.title,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
    }));
}

/**
 * Share a conversation into a project: re-encrypt, then flip the scopes.
 *
 * ORDER MATTERS. The re-key happens BEFORE the flag flips, so a crash between
 * the two leaves a conversation whose rows are project-keyed but which is still
 * marked private — recoverable, because nobody but the owner can see it and a
 * retry converges. Flipping first would publish a thread whose rows nobody with
 * the project key could open.
 *
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {'direct'|'agent'} opts.type
 * @param {string} opts.projectId    project the conversation is being shared into
 * @param {string} opts.ownerId      the conversation's owner (the only valid caller)
 * @param {string|null} opts.orgId   the PROJECT's organisation
 * @param {string|Buffer|null} opts.encryptionKey  owner's session DEK, if any
 * @returns {Promise<{shared: true, rekeyed: number}>}
 */
async function shareConversationToProject({ conversationId, type, projectId, ownerId, orgId, encryptionKey = null }) {
    const table = tableFor(type);
    const convType = type === 'agent' ? 'agent' : 'direct';

    const row = await getOne(
        `SELECT id, user_id, project_id, shared_scope, crypto_scope FROM ${table} WHERE id = $1 AND user_id = $2`,
        [conversationId, ownerId]
    );
    if (!row) throw Object.assign(new Error('Conversation not found'), { code: 'NOT_FOUND' });
    if (row.shared_scope === 'project' && row.project_id === projectId) {
        return { shared: true, rekeyed: 0 };            // idempotent
    }

    const fromCtx = await resolveCrypto({ userId: ownerId, encryptionKey });
    const toCtx = await resolveCrypto({
        userId: ownerId,
        orgId,
        projectKeyFor: { projectId, orgId },
    });

    // Only rewrite when the key actually changes. With encryption off entirely
    // both contexts are plaintext and there is nothing to convert.
    let rekeyed = 0;
    const needsRekey = (fromCtx.encryptMessages || toCtx.encryptMessages)
        && !(fromCtx.key && toCtx.key && fromCtx.key.equals(toCtx.key));
    if (needsRekey) {
        rekeyed = await convMessages.rekeyConversation(conversationId, convType, fromCtx, toCtx);
    }

    // Every column the reader picks by crypto_scope has to move when the scope
    // does, not just the message rows — otherwise crypto_scope stops being an
    // honest description of what is on disk, which is the whole premise of
    // converting once rather than guessing on read.
    const newScope = toCtx.encryptMessages ? 'project' : 'user';
    if (newScope !== (row.crypto_scope === 'project' ? 'project' : 'user')) {
        await _rekeyMeta(table, convType, conversationId, fromCtx, toCtx);
    }

    await run(
        `UPDATE ${table}
            SET project_id = $1, shared_scope = 'project', crypto_scope = $2, shared_at = NOW(), updated_at = NOW()
          WHERE id = $3 AND user_id = $4`,
        [projectId, newScope, conversationId, ownerId]
    );

    return { shared: true, rekeyed };
}

/**
 * Take a conversation back out of a project: re-key to the owner, then flip.
 *
 * `project_id` is deliberately LEFT SET. Filing a conversation under a project
 * and sharing it are two different things (see the initSchema comment), so
 * unsharing returns it to "filed here, private to me" rather than unfiling it.
 */
async function unshareConversation({ conversationId, type, ownerId, orgId, encryptionKey = null }) {
    const table = tableFor(type);
    const convType = type === 'agent' ? 'agent' : 'direct';

    const row = await getOne(
        `SELECT id, project_id, shared_scope, crypto_scope FROM ${table} WHERE id = $1 AND user_id = $2`,
        [conversationId, ownerId]
    );
    if (!row) throw Object.assign(new Error('Conversation not found'), { code: 'NOT_FOUND' });
    if (row.shared_scope !== 'project') return { shared: false, rekeyed: 0 };

    const fromCtx = row.crypto_scope === 'project'
        ? await resolveCrypto({ userId: ownerId, orgId, projectKeyFor: { projectId: row.project_id, orgId } })
        : await resolveCrypto({ userId: ownerId, encryptionKey });
    const toCtx = await resolveCrypto({ userId: ownerId, encryptionKey });

    let rekeyed = 0;
    const needsRekey = (fromCtx.encryptMessages || toCtx.encryptMessages)
        && !(fromCtx.key && toCtx.key && fromCtx.key.equals(toCtx.key));
    if (needsRekey) {
        // On zk with no session there is no owner key to convert TO, and
        // rekeyConversation would refuse rather than write plaintext. Surfacing
        // that as a clear error beats a half-converted conversation.
        if (toCtx.encryptMessages === false && fromCtx.encryptMessages === true) {
            throw Object.assign(
                new Error('Cannot unshare: the owner must be signed in so the conversation can be re-encrypted to their own key.'),
                { code: 'OWNER_KEY_REQUIRED' }
            );
        }
        rekeyed = await convMessages.rekeyConversation(conversationId, convType, fromCtx, toCtx);
    }

    // Mirror of the share path: meta_json follows crypto_scope back to the owner.
    if (row.crypto_scope === 'project') {
        await _rekeyMeta(table, convType, conversationId, fromCtx, toCtx);
    }

    await run(
        `UPDATE ${table}
            SET shared_scope = 'private', crypto_scope = 'user', shared_at = NULL, updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [conversationId, ownerId]
    );

    return { shared: false, rekeyed };
}

module.exports = {
    listProjectThreads,
    shareConversationToProject,
    unshareConversation,
};
