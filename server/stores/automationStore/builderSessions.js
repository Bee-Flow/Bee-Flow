// @typecheck
/**
 * builderSessions.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const { initDB, run, getOne, getClient } = require('./core');
const { safeParse } = require('./rowMappers');

// ── Builder session snapshot ───────────────────────────────────────────
//
// The builder loop persists a snapshot {sessionId, version, conversation,
// draft, lastValidation, summary, todos, catalogOrder, updatedAt} into
// automations.builder_session at the end of every turn. On SSE reconnect the
// client rehydrates from the latest snapshot so the chat history isn't lost
// when the connection drops, and the next turn's prompt replays `catalogOrder`
// (the app order the session's system prompt is rendered in) and `todos`.
// Unknown keys are written verbatim — adding one needs no migration.
//
// `version` is a monotonically-increasing integer used for optimistic
// locking: setBuilderSession only succeeds when the caller's expected
// version matches the persisted one. Two-tab edits get a 409 on the second
// write so the loser can refresh instead of clobbering.

const SNAPSHOT_MAX_BYTES = 64 * 1024;

// Assistant entries in `conversation` carry `toolCalls[{name, arguments,
// result}]` (chatTurnLoop.collectAssistantTurn) so a resume can rebuild the
// chat bubble. Tool RESULTS are the bulk of a snapshot and are only ever
// displayed for the latest turn, so they are the first thing to go.
function stripToolResults(msg) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.toolCalls)) return msg;
    return { ...msg, toolCalls: msg.toolCalls.map(tc => {
        if (!tc || typeof tc !== 'object' || !('result' in tc)) return tc;
        const { result, ...rest } = tc;
        return rest;
    }) };
}

function stripToolCalls(msg) {
    if (!msg || msg.role !== 'assistant' || !('toolCalls' in msg)) return msg;
    const { toolCalls, ...rest } = msg;
    return rest;
}

/**
 * Squeeze a snapshot under SNAPSHOT_MAX_BYTES by shrinking `conversation`, the
 * one key that grows without bound. Pure — exported for tests.
 *
 * Pass 1 strips tool results, then tool calls, from every assistant entry
 * except the last (the latest turn is what a resume shows). Pass 2 drops
 * messages from the HEAD in multiples of `block`. The block matters: the
 * prompt window (core/llm/historyWindow.js) evicts the conversation head in
 * the same multiples, and a client that rehydrated from a trimmed snapshot
 * then sends a history whose head sits on the same boundary — so the store's
 * trim and the prompt's window agree on where the conversation starts, and
 * the cached prompt prefix is not moved by a byte-cap trim.
 *
 * This used to trim `snapshot.messages` — a key the automation builder never
 * wrote (it persists `conversation`), so the guard was a no-op that injected
 * an empty `messages: []` and left oversized snapshots oversized.
 */
function trimSnapshot(snapshot, { block = 1 } = {}) {
    if (!snapshot) return null;
    if (JSON.stringify(snapshot).length <= SNAPSHOT_MAX_BYTES) return snapshot;
    const conversation = Array.isArray(snapshot.conversation) ? [...snapshot.conversation] : [];
    const trimmed = { ...snapshot, conversation };
    const over = () => JSON.stringify(trimmed).length > SNAPSHOT_MAX_BYTES;

    let lastAssistant = -1;
    for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i] && conversation[i].role === 'assistant') { lastAssistant = i; break; }
    }
    for (let i = 0; i < conversation.length && over(); i++) {
        if (i !== lastAssistant) conversation[i] = stripToolResults(conversation[i]);
    }
    for (let i = 0; i < conversation.length && over(); i++) {
        if (i !== lastAssistant) conversation[i] = stripToolCalls(conversation[i]);
    }

    const step = Math.max(1, Math.floor(Number(block)) || 1);
    // Keep at least the latest exchange plus one block of context so a resume
    // never shows the user an answer without its question.
    while (over() && conversation.length > step + 2) conversation.splice(0, step);
    return trimmed;
}

async function getBuilderSession(automationId, userId) {
    await initDB();
    const r = await getOne(
        'SELECT builder_session, user_id FROM automations WHERE id = $1',
        [automationId],
    );
    if (!r) return null;
    if (userId && r.user_id !== userId) return null;
    const raw = typeof r.builder_session === 'string' ? safeParse(r.builder_session, null) : (r.builder_session ?? null);
    return raw;
}

/**
 * Persist a builder-session snapshot. When `expectedVersion` is provided,
 * the write only succeeds if the persisted snapshot's version matches —
 * mismatches return { ok: false, conflict: true, current }. When omitted,
 * the write is unconditional and the version increments by 1.
 *
 * `trimBlock` is the head-eviction granularity for an oversized conversation
 * (see trimSnapshot); the builder passes its prompt window's block.
 */
async function setBuilderSession(automationId, userId, snapshot, { expectedVersion = null, trimBlock = 1 } = {}) {
    await initDB();
    const trimmed = trimSnapshot(snapshot, { block: trimBlock }) || {};
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            'SELECT user_id, builder_session FROM automations WHERE id = $1 FOR UPDATE',
            [automationId],
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, notFound: true };
        }
        if (userId && cur.rows[0].user_id !== userId) {
            await client.query('ROLLBACK');
            return { ok: false, forbidden: true };
        }
        const currentSnap = (typeof cur.rows[0].builder_session === 'string'
            ? safeParse(cur.rows[0].builder_session, null)
            : (cur.rows[0].builder_session ?? null)) || {};
        const currentVersion = Number.isFinite(currentSnap.version) ? currentSnap.version : 0;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, current: currentSnap };
        }
        const next = { ...trimmed, version: currentVersion + 1 };
        await client.query(
            `UPDATE automations SET builder_session = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(next), automationId],
        );
        await client.query('COMMIT');
        return { ok: true, snapshot: next };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function clearBuilderSession(automationId, userId) {
    await initDB();
    if (userId) {
        await run(
            `UPDATE automations SET builder_session = NULL WHERE id = $1 AND user_id = $2`,
            [automationId, userId],
        );
    } else {
        await run(`UPDATE automations SET builder_session = NULL WHERE id = $1`, [automationId]);
    }
}

module.exports = { getBuilderSession, setBuilderSession, clearBuilderSession, trimSnapshot, SNAPSHOT_MAX_BYTES };
