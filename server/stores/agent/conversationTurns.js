// @typecheck strict
/**
 * Saving one finished chat turn: its own rows, right after the last stored
 * message the turn read as its history (the anchor), under the conversation's
 * row lock, deleting nothing another turn stored.
 *
 * A turn reads the conversation when it starts and saves when it ends. Saving
 * that history plus its own rows as a full replace deleted every turn that
 * finished on the same conversation in between: a second tab or device, the
 * Nextcloud embed next to the web app, a question asked again after a dropped
 * stream while the server was still answering. Here a turn only inserts its
 * rows and moves the rows after its anchor down; the rule for where they go is
 * placeTurnRows (./conversationOrder.mts), shared by direct and agent chat.
 *
 * Edit, regenerate and delete rewrite the history on purpose and keep the full
 * replace (agentConversations.updateConversation /
 * directConversations.updateDirectConversation), which takes the same lock.
 *
 * A turn saves more than once (an agent turn after every tool round, then at
 * its end), so every row carries an id that stays the same across those
 * saves; a save replaces the rows of the same ids.
 */

const { run, withTransaction } = require('../../db');
const { initDB } = require('./initSchema');
const convMessages = require('./conversationMessages');
const agentConversations = require('./agentConversations');
const directConversations = require('./directConversations');
const { randomUUID } = require('crypto');
const { writeTurnRows, placeTurnRows, markOf } = require('./conversationOrder.mts');
const { PLAINTEXT_CONTEXT } = require('./messageCrypto');
const log = require('../../telemetry/log');

/** @typedef {import('./messageCrypto').CryptoContext} CryptoContext */
/** @typedef {import('./normalizeStoredMessages').StoredMessage} StoredMessage */
/**
 * @typedef {{ rows: StoredMessage[], anchorId: string | null, turnId?: string, askedAt?: string }} TurnRows
 *   a turn's own rows in order, the last stored message it was asked on, and
 *   the turn's id and the server time it was asked (turnMark) that order it
 *   among other turns asked on the same history
 */

/**
 * A new turn's id and the time it is asked. Take it when the turn STARTS:
 * overlapping turns are stored in the order they were asked, not finished.
 * @returns {{ turnId: string, askedAt: string }}
 */
function turnMark() {
    return { turnId: randomUUID(), askedAt: new Date().toISOString() };
}

/** @param {TurnRows} turn @returns {import('./conversationOrder.mts').TurnMark | null} */
const markOfTurn = (turn) => markOf({ turnId: turn.turnId, turnAskedAt: turn.askedAt });

/**
 * The rows of one turn into conversation_messages, placed after `anchorId`.
 * A row without an id gets a fresh one (and can then not be replaced later).
 *
 * @param {string} conversationId
 * @param {'agent' | 'direct'} type
 * @param {TurnRows} turn
 * @param {Readonly<CryptoContext>} [ctx]
 * @returns {Promise<boolean>} false: the conversation still reads from its
 *   legacy blob and nothing was written; the caller writes the whole array.
 */
async function placeTurnMessages(conversationId, type, turn, ctx = PLAINTEXT_CONTEXT) {
    const { rows, anchorId } = turn;
    await convMessages.initMessagesTable();
    if (!Array.isArray(rows) || rows.length === 0) return true;
    // A keyless write into an encrypted conversation is refused, as for replaceMessages.
    await convMessages._refuseSilentDowngrade(conversationId, ctx);
    const withIds = rows.map((m) => (m.id ? m : { ...m, id: randomUUID() }));
    return withTransaction((client) => writeTurnRows(client, {
        type, conversationId, anchorId, mark: markOfTurn(turn),
        turnIds: withIds.map((m) => String(m.id)),
        insertRows: (startSeq) => convMessages._bulkInsert(
            convMessages.messagesToRows(conversationId, type, withIds, ctx, startSeq), client),
    }));
}

/**
 * The turn write, its failure logged: a failed write is logged and the turn
 * goes on, as with the full replace, and never falls back to one.
 * @param {string} conversationId
 * @param {'agent' | 'direct'} type
 * @param {TurnRows} turn
 * @param {Readonly<CryptoContext>} ctx
 */
function placeOrLog(conversationId, type, turn, ctx) {
    return placeTurnMessages(conversationId, type, turn, ctx).catch((err) => {
        log.error(`[ConversationTurns] ${type} turn write error:`, /** @type {Error} */ (err).message);
        return true;
    });
}

/**
 * The turn write; a conversation still on its legacy blob is first migrated
 * into conversation_messages (under the row lock, migrateConversationIfNeeded)
 * from what a reader sees now, then written. False: still not migrated (the
 * table and the blob disagree); the caller writes the whole array.
 * @param {string} conversationId
 * @param {'agent' | 'direct'} type
 * @param {TurnRows} turn
 * @param {Readonly<CryptoContext>} ctx
 * @param {() => Promise<StoredMessage[]>} readStored  the conversation as a reader sees it now
 */
async function placeAfterMigrating(conversationId, type, turn, ctx, readStored) {
    if (await placeOrLog(conversationId, type, turn, ctx)) return true;
    await convMessages.migrateConversationIfNeeded(conversationId, type, await readStored(), ctx);
    return placeOrLog(conversationId, type, turn, ctx);
}

/**
 * Save one finished agent-chat turn (streaming and non-streaming agent chat).
 *
 * A shared thread, or a conversation that still reads from its legacy blob,
 * takes the whole-array write (updateConversation), built on what is stored
 * NOW with the turn placed by the same rule. A shared thread appends: its
 * turn lock orders the AI turns and its store write diffs the tail.
 *
 * @param {string} conversationId
 * @param {TurnRows} turn
 * @param {string | null} [encryptionKey]
 * @param {string | null} [userId]
 * @returns {Promise<void>}
 */
async function saveConversationTurn(conversationId, turn, encryptionKey = null, userId = null) {
    await initDB();
    const access = await agentConversations._resolveAgentWriteContext(conversationId, /** @type {string} */ (userId), encryptionKey);
    if (!access) throw new agentConversations.ConversationWriteDenied(conversationId);

    const read = () => agentConversations.getConversationById(conversationId, encryptionKey ?? null, { restore: false })
        .then((c) => /** @type {StoredMessage[]} */ (c?.messages || []));
    if (!access.isShared && await placeAfterMigrating(conversationId, 'agent', turn, access.ctx, read)) {
        await run('UPDATE agent_conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
        return;
    }
    const own = new Set(turn.rows.map((m) => m.id));
    const base = (await read()).filter((m) => !own.has(m.id));
    await agentConversations.updateConversation(conversationId,
        placeTurnRows(base, turn.rows, access.isShared ? null : turn.anchorId, markOfTurn(turn)), encryptionKey, userId);
}

/**
 * Save one finished direct-chat turn (a regular turn, an interrupted one, a
 * Swarm turn), with the conversation meta it carries.
 *
 * Returns false, writing nothing, for a shared thread (it appends by tail diff
 * under its turn lock) and for a conversation that still reads from its legacy
 * blob: the caller then writes the whole array with updateDirectConversation.
 *
 * @param {string} id
 * @param {TurnRows} turn
 * @param {string} userId
 * @param {Record<string, unknown> | null} [meta]
 * @param {{ encryptionKey?: string | null }} [options]
 * @returns {Promise<boolean>}
 */
async function placeDirectConversationTurn(id, turn, userId, meta = null, options = {}) {
    await initDB();
    const access = await directConversations._resolveWriteContext(id, userId, options);
    if (!access) throw new directConversations.ConversationWriteDenied(id);
    const read = () => directConversations.getDirectConversation(id, userId, { ...options, restore: false })
        .then((c) => /** @type {StoredMessage[]} */ (c?.messages || []));
    if (access.isShared || !await placeAfterMigrating(id, 'direct', turn, access.ctx, read)) return false;

    if (meta && Object.keys(meta).length > 0) {
        await directConversations.updateDirectConversationMeta(id, access.ownerId, meta, options);
    }
    const { rowCount } = await run('UPDATE direct_conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [id, access.ownerId]);
    // Zero rows: the conversation vanished between the access check and the
    // write. Reporting success would let the caller stream an answer that was never saved.
    if (rowCount === 0) throw new directConversations.ConversationWriteDenied(id);
    return true;
}

module.exports = { placeTurnMessages, saveConversationTurn, placeDirectConversationTurn, turnMark };
