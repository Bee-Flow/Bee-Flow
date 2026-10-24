// @typecheck
/**
 * stores/studioApp/builderSession.js — the AI builder's session snapshot on
 * studio_apps.builder_session: trimming, read, optimistic write, clear.
 */

const { dep } = require('./deps');
const { parseJSONObject: parseJSON } = require('../lib/json');
const { initDB } = require('./schema');
const { guardOf } = require('./shared');
const { rollback } = require('../../txRollback');

const { run, getOne } = dep('db');

// ── Builder session snapshot ────────────────────────────────────────
//
// The AI builder loop persists a small snapshot {sessionId, version,
// messages, ...} into studio_apps.builder_session after every mutation so a
// dropped SSE connection can rehydrate the chat. Same mechanics as
// automationStore/builderSessions.js: a monotonically-increasing `version`
// gives optimistic locking — two-tab edits get {conflict:true} on the second
// write so the loser can refresh instead of clobbering.

const SNAPSHOT_MAX_BYTES = 64 * 1024;

// Top-level snapshot keys that must survive trimming INTACT — plan-first UX
// state the builder rehydrates from (pendingPlan/approvedPlan), checkpoint
// bookkeeping, and continuation state. Names frozen here (Wave 2C); future
// snapshot writers add to this list, and trimSnapshot may only ever squeeze
// the `messages` array — never these.
const PINNED_SNAPSHOT_KEYS = Object.freeze([
    'pendingPlan', 'approvedPlan', 'checkpoints', 'continueToken', 'lastTier',
]);

// Appended to `summary` (once) when messages were dropped, so a rehydrated
// session knows its history is partial.
const SNAPSHOT_TRIM_MARKER = '(older messages trimmed)';

function trimSnapshot(snapshot, { block = 1 } = {}) {
    if (!snapshot) return null;
    let payload = JSON.stringify(snapshot);
    if (payload.length <= SNAPSHOT_MAX_BYTES) return snapshot;
    // Drop oldest messages until we fit — ONLY the messages array is ever
    // trimmed. Keep the most recent turns intact so resume always shows the
    // user the latest model output.
    //
    // In multiples of `block` when the caller asks (the builder route passes
    // its history-window block): the model's prompt is [prefix…][history…],
    // and evicting one message at a time moves the first kept message on
    // every save, shifting every later byte the llama.cpp prefix cache could
    // have reused. Whole blocks keep the prefix stable between evictions.
    // Never below block + 2 messages, so a resume still shows the latest turn.
    const step = Number.isInteger(block) && block > 1 ? block : 1;
    const trimmed = { ...snapshot, messages: Array.isArray(snapshot.messages) ? [...snapshot.messages] : [] };
    let dropped = 0;
    while (trimmed.messages.length > Math.max(2, step + 2)) {
        trimmed.messages.splice(0, Math.min(step, trimmed.messages.length - 2));
        dropped += 1;
        payload = JSON.stringify(trimmed);
        if (payload.length <= SNAPSHOT_MAX_BYTES) break;
    }
    if (dropped > 0) {
        const summary = typeof trimmed.summary === 'string' ? trimmed.summary : '';
        if (!summary.includes(SNAPSHOT_TRIM_MARKER)) {
            trimmed.summary = summary ? `${summary} ${SNAPSHOT_TRIM_MARKER}` : SNAPSHOT_TRIM_MARKER;
        }
    }
    // Belt-and-braces: whatever future trimming strategies do, the pinned keys
    // ride through byte-identical.
    for (const k of PINNED_SNAPSHOT_KEYS) {
        if (snapshot[k] !== undefined) trimmed[k] = snapshot[k];
    }
    return trimmed;
}

async function getBuilderSession(appId, userId) {
    await initDB();
    const r = await getOne(`SELECT builder_session, user_id FROM studio_apps WHERE id = $1`, [appId]);
    if (!r) return null;
    if (userId && r.user_id !== userId) return null;
    return typeof r.builder_session === 'string'
        ? parseJSON(r.builder_session, null)
        : (r.builder_session ?? null);
}

/**
 * Persist a builder-session snapshot. When `expectedVersion` is provided,
 * the write only succeeds if the persisted snapshot's version matches —
 * mismatches return { ok: false, conflict: true, current }. When omitted,
 * the write is unconditional and the version increments by 1.
 */
async function setBuilderSession(io, appId, userId, snapshot, { expectedVersion = null, trimBlock = 1, managedWrite = null } = {}) {
    await io.ready();
    const trimmed = trimSnapshot(snapshot, { block: trimBlock }) || {};
    return io.db.withTransaction(async (client) => {
        const cur = await client.query(
            `SELECT user_id, builder_session, project_id FROM studio_apps WHERE id = $1 FOR UPDATE`,
            [appId]
        );
        if (cur.rows.length === 0) {
            return rollback({ ok: false, notFound: true });
        }
        if (userId && cur.rows[0].user_id !== userId) {
            return rollback({ ok: false, forbidden: true });
        }
        // An app of a Solution stage has no AI builder session (changed in Dev, deployed).
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null, changedKeys: ['builderSession'], managedWrite, client,
        });
        const currentSnap = (typeof cur.rows[0].builder_session === 'string'
            ? parseJSON(cur.rows[0].builder_session, null)
            : (cur.rows[0].builder_session ?? null)) || {};
        const currentVersion = Number.isFinite(currentSnap.version) ? currentSnap.version : 0;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            return rollback({ ok: false, conflict: true, current: currentSnap });
        }
        const next = { ...trimmed, version: currentVersion + 1 };
        await client.query(
            `UPDATE studio_apps SET builder_session = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(next), appId]
        );
        return { ok: true, snapshot: next };
    });
}

async function clearBuilderSession(appId, userId) {
    await initDB();
    if (userId) {
        await run(`UPDATE studio_apps SET builder_session = NULL WHERE id = $1 AND user_id = $2`, [appId, userId]);
    } else {
        await run(`UPDATE studio_apps SET builder_session = NULL WHERE id = $1`, [appId]);
    }
}

module.exports = {
    SNAPSHOT_MAX_BYTES,
    PINNED_SNAPSHOT_KEYS,
    SNAPSHOT_TRIM_MARKER,
    getBuilderSession,
    setBuilderSession,
    clearBuilderSession,
};
