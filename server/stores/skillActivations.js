// @typecheck
/**
 * Skill activations — "when was this skill last used, and by which agent"
 * (Bee Flow Builder redesign, Sep 2026, Track S1).
 *
 * The Skills overview shows a "Laatste keer" column and the Used-by tab a
 * last-used time per agent. Until now nothing wrote anything back when a
 * skill was used: neither buildSkillInjection's static path nor the
 * activate_skill tool. This table is that write, and `skills.last_used_at`
 * is its denormalised summary.
 *
 *   skill_activations(id, skill_id, agent_id, conversation_id, user_id, source, at)
 *     source: 'static'        — injected into the system prompt for a turn
 *             'activate_skill'— the model called the tool
 *             'ai_step'       — a routine AI step applied it (Track R2)
 *             'test'          — a Test-tab run (Track S3)
 *
 * ── ONE ROW PER USE, NOT PER TURN ────────────────────────────────────
 * The static path fires on EVERY chat turn, so a naive insert would write a
 * row per turn per skill and the table would outgrow the skills it
 * describes. The natural key is therefore (skill, conversation, agent,
 * source) with an UPSERT that refreshes `at`: a 40-turn chat is one row,
 * and its timestamp still says when the skill was last used. `agent_id` and
 * `conversation_id` are '' rather than NULL so that key is a plain UNIQUE
 * index (NULLs would not collide, and the flooding would come back through
 * the ephemeral-chat path); reads map '' back to null.
 *
 * On top of that a small in-process TTL cache skips the round-trip entirely
 * for a key already written in the last ACTIVATION_TTL_MS — the write is
 * idempotent, so per-replica caches are safe and the hot chat path pays
 * nothing after the first turn.
 *
 * `user_id` is who was chatting — kept so a future "who used it" can be
 * answered, and never sent anywhere.
 *
 * Every write is fire-and-forget from the caller's point of view: a
 * failure here must never cost a chat turn, so `recordActivations` swallows
 * and logs.
 */

'use strict';

const { run, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const SOURCES = Object.freeze(['static', 'activate_skill', 'ai_step', 'test']);
const RETENTION_DAYS = 180;
/** How long a (skill, conversation, agent, source) write is remembered in-process. */
const ACTIVATION_TTL_MS = 10 * 60 * 1000;
const ACTIVATION_CACHE_MAX = 5000;

const initDB = makeStoreInit('SkillActivations', async () => {
    await exec(`
        CREATE TABLE IF NOT EXISTS skill_activations (
            id BIGSERIAL PRIMARY KEY,
            skill_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            conversation_id TEXT NOT NULL DEFAULT '',
            user_id TEXT,
            source TEXT NOT NULL DEFAULT 'static',
            at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_skill_activations_skill_at ON skill_activations(skill_id, at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_activations_agent ON skill_activations(agent_id, skill_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_activations_key
            ON skill_activations(skill_id, conversation_id, agent_id, source);
    `);
});

// key → epoch ms of the last write. Bounded; cleared wholesale when full.
const _recent = new Map();

function _seenRecently(key, now) {
    const at = _recent.get(key);
    if (at !== undefined && now - at < ACTIVATION_TTL_MS) return true;
    if (_recent.size >= ACTIVATION_CACHE_MAX) _recent.clear();
    _recent.set(key, now);
    return false;
}

/** Test seam: forget the in-process TTL cache. */
function _resetCache() { _recent.clear(); }

/**
 * Record that `skillIds` were active. Upserts one row per
 * (skill, conversation, agent, source) with a refreshed `at`, stamps
 * `skills.last_used_at`, and prunes rows older than RETENTION_DAYS for
 * those skills. Never throws.
 *
 * @param {{ skillIds: string[], agentId?: string|null, conversationId?: string|null, userId?: string|null, source?: string }} p
 * @returns {Promise<number>} rows written (0 when everything was already fresh)
 */
async function recordActivations({ skillIds, agentId = null, conversationId = null, userId = null, source = 'static' }) {
    const all = [...new Set((Array.isArray(skillIds) ? skillIds : []).filter(id => typeof id === 'string' && id))];
    if (all.length === 0) return 0;
    const src = SOURCES.includes(source) ? source : 'static';
    const agent = agentId || '';
    const conversation = conversationId || '';
    const now = Date.now();
    const ids = all.filter(id => !_seenRecently(`${id}|${conversation}|${agent}|${src}`, now));
    if (ids.length === 0) return 0;
    try {
        await initDB();
        let written = 0;
        for (const skillId of ids) {
            // Upsert on the natural key: one row per use, `at` always current.
            const r = await run(
                `INSERT INTO skill_activations (skill_id, agent_id, conversation_id, user_id, source)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (skill_id, conversation_id, agent_id, source)
                 DO UPDATE SET at = NOW(), user_id = COALESCE(EXCLUDED.user_id, skill_activations.user_id)`,
                [skillId, agent, conversation, userId || null, src],
            );
            written += r?.rowCount ?? 0;
        }
        await run(`UPDATE skills SET last_used_at = NOW() WHERE id = ANY($1::text[])`, [ids]);
        await run(
            `DELETE FROM skill_activations WHERE skill_id = ANY($1::text[]) AND at < NOW() - ($2 || ' days')::interval`,
            [ids, String(RETENTION_DAYS)],
        );
        return written;
    } catch (err) {
        // A failed write must not be remembered as done.
        for (const id of ids) _recent.delete(`${id}|${conversation}|${agent}|${src}`);
        log.warn('[SkillActivations] recordActivations failed:', err.message);
        return 0;
    }
}

/**
 * Last activation per skill: `{ [skillId]: { at, agentId, source } }`.
 * @param {string[]} skillIds
 */
async function getLastActivationBySkillIds(skillIds) {
    const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).filter(Boolean))];
    if (ids.length === 0) return {};
    await initDB();
    const rows = await getAll(
        `SELECT DISTINCT ON (skill_id) skill_id, agent_id, source, at
           FROM skill_activations
          WHERE skill_id = ANY($1::text[])
          ORDER BY skill_id, at DESC`,
        [ids],
    );
    const out = {};
    for (const r of rows || []) {
        out[r.skill_id] = { at: r.at ? new Date(r.at).toISOString() : null, agentId: r.agent_id || null, source: r.source };
    }
    return out;
}

/**
 * Last activation per (skill, agent) for a set of agents — feeds the
 * `lastAt` column of the Used-by rows.
 * @returns {Promise<Object<string, string>>} `{ [agentId]: ISO }`
 */
async function getLastActivationByAgent(skillId, agentIds) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean))];
    if (!skillId || ids.length === 0) return {};
    await initDB();
    const rows = await getAll(
        `SELECT agent_id, MAX(at) AS at
           FROM skill_activations
          WHERE skill_id = $1 AND agent_id = ANY($2::text[])
          GROUP BY agent_id`,
        [skillId, ids],
    );
    /** @type {Record<string, string|null>} */
    const out = {};
    for (const r of rows || []) out[r.agent_id] = r.at ? new Date(r.at).toISOString() : null;
    return out;
}

/** Recent activations of one skill (newest first). */
async function listRecentActivations(skillId, limit = 50) {
    if (!skillId) return [];
    await initDB();
    const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const rows = await getAll(
        `SELECT skill_id, agent_id, conversation_id, source, at
           FROM skill_activations WHERE skill_id = $1 ORDER BY at DESC LIMIT $2`,
        [skillId, n],
    );
    return (rows || []).map(r => ({
        skillId: r.skill_id,
        agentId: r.agent_id || null,
        conversationId: r.conversation_id || null,
        source: r.source,
        at: r.at ? new Date(r.at).toISOString() : null,
    }));
}

module.exports = {
    SOURCES,
    RETENTION_DAYS,
    ACTIVATION_TTL_MS,
    initDB,
    recordActivations,
    getLastActivationBySkillIds,
    getLastActivationByAgent,
    listRecentActivations,
    _resetCache,
};
