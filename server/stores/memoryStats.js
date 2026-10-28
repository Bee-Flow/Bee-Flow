// @typecheck strict
/**
 * stores/memoryStats.js — counts (per user, per org, the Memory panel's
 * distribution) and the schedule-coverage bookkeeping rows. Split out of
 * stores/memoryStore.js.
 */

const { run, getOne, getAll } = require('../db');
const { randomUUID } = require('crypto');
const { embedAndStore } = require('./memoryEmbedding');
const { dep } = require('./memoryDeps');
const { PLAINTEXT_WRITE } = dep('memoryCrypto');

/** The store's schema-init memo, installed by stores/memoryStore (read per call). */
const initDB = () => dep('initDB')();

// ============ Stats ============

/** @param {string} userId */
async function getMemoryStats(userId) {
    await initDB();
    const total = await getOne('SELECT COUNT(*) as count FROM user_memories WHERE user_id = $1 AND project_id IS NULL', [userId]);
    const byType = await getAll('SELECT type, COUNT(*) as count FROM user_memories WHERE user_id = $1 AND project_id IS NULL GROUP BY type', [userId]);
    const byImportance = await getAll(`
        SELECT
            CASE WHEN importance >= 0.8 THEN 'high' WHEN importance >= 0.5 THEN 'medium' ELSE 'low' END as level,
            COUNT(*) as count
        FROM user_memories WHERE user_id = $1 AND project_id IS NULL GROUP BY level
    `, [userId]);

    const typeDistribution = { labels: byType.map(r => r.type), data: byType.map(r => parseInt(r.count)) };
    /** @type {Record<string, number>} */
    const importanceDistribution = { high: 0, medium: 0, low: 0 };
    byImportance.forEach(r => { if (importanceDistribution[r.level] !== undefined) importanceDistribution[r.level] = parseInt(r.count); });

    return { total: parseInt(total.count), typeDistribution, importanceDistribution };
}

/**
 * How many live memories Bee Flow holds about one user — every project and
 * agent included, superseded/expired rows excluded. Read by the DSR discovery
 * scan (compliance/dsr/discovery.js), which reports the COUNT and never the
 * contents.
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function countActiveMemoriesForUser(userId) {
    if (!userId) return 0;
    await initDB();
    const row = await getOne(`
        SELECT COUNT(*)::int AS count FROM user_memories
        WHERE user_id = $1
          AND COALESCE(status, 'active') = 'active'
          AND superseded_by IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
    `, [userId]);
    return Number(row?.count) || 0;
}

/**
 * Counts only, for the org admin screen: never memory content.
 * @param {string} orgId
 */
async function countOrgMemoryStats(orgId) {
    if (!orgId) return { activeMemories: 0, users: 0 };
    await initDB();
    const row = await getOne(`
        SELECT COUNT(m.id)::int AS "activeMemories", COUNT(DISTINCT m.user_id)::int AS users
        FROM user_memories m
        JOIN users u ON u.id = m.user_id
        WHERE u."organizationId" = $1
          AND m.type <> $2
          AND COALESCE(m.status, 'active') = 'active'
          AND m.superseded_by IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
    `, [orgId, SCHEDULE_COVERAGE_TYPE]);
    return { activeMemories: Number(row?.activeMemories) || 0, users: Number(row?.users) || 0 };
}

// ============ R3: Schedule Coverage Memories ============
// A "schedule_coverage" memory tracks one topic the agent has surfaced in a
// past run of a specific Cowork schedule. Used to de-dupe daily/weekly digests
// (e.g. an AI-news schedule: don't re-cover "openai-gpt-5" unless there's an
// update). Indexed by `(user_id, source_schedule_id, subject)` so each topic
// has exactly one row per schedule and updating a topic supersedes the prior
// value rather than duplicating.

const SCHEDULE_COVERAGE_TYPE = 'schedule_coverage';
const SCHEDULE_COVERAGE_TTL_DAYS = 30;

/**
 * Insert-or-update a coverage memory for one topic of one schedule.
 * - subject: stable topic key (e.g. "openai-gpt-5")
 * - title: human-readable title used in the addendum (e.g. "OpenAI GPT-5 launch")
 * - summary: short one-line description ("Released …")
 * @param {{ userId: string, agentId?: string | null, scheduleId: string, subject: string, title?: string | null, summary?: string | null }} args
 */
async function upsertScheduleCoverage({ userId, agentId, scheduleId, subject, title, summary }) {
    if (!userId || !scheduleId || !subject) return null;
    await initDB();
    const expiresAt = new Date(Date.now() + SCHEDULE_COVERAGE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
    const content = title ? `${title}${summary ? ' — ' + summary : ''}` : (summary || subject);
    const existing = await getOne(
        `SELECT id FROM user_memories
         WHERE user_id = $1 AND source_schedule_id = $2 AND subject = $3 AND status = 'active'
         LIMIT 1`,
        [userId, scheduleId, subject]
    );
    if (existing) {
        await run(
            `UPDATE user_memories
             SET content = $1, summary = $2, value = $3,
                 last_confirmed_at = NOW(), expires_at = $4, updated_at = NOW()
             WHERE id = $5`,
            [content, summary || null, title || null, expiresAt, existing.id]
        );
        return existing.id;
    }
    const id = randomUUID();
    await run(
        `INSERT INTO user_memories
            (id, user_id, agent_id, type, content, subject, value, summary, importance,
             last_confirmed_at, status, source_schedule_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'active', $10, $11)`,
        [id, userId, agentId || null, SCHEDULE_COVERAGE_TYPE, content, subject,
         title || null, summary || null, 0.5, scheduleId, expiresAt]
    );
    // Bookkeeping rows are not memories and stay clear (see memoryCrypto.js).
    embedAndStore(id, content, PLAINTEXT_WRITE);
    return id;
}

/**
 * List active coverage memories for a schedule, newest-first.
 * @param {string} scheduleId
 * @param {{ limit?: number }} [opts]
 */
async function getScheduleCoverage(scheduleId, { limit = 50 } = {}) {
    if (!scheduleId) return [];
    await initDB();
    return getAll(
        `SELECT id, subject, summary, value, last_confirmed_at
         FROM user_memories
         WHERE source_schedule_id = $1 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY last_confirmed_at DESC LIMIT $2`,
        [scheduleId, limit]
    );
}

/** Delete coverage memories whose TTL has elapsed. Returns rowCount. */
async function pruneExpiredCoverage() {
    await initDB();
    const { rowCount } = await run(
        `UPDATE user_memories SET status = 'expired', updated_at = NOW()
         WHERE type = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()`,
        [SCHEDULE_COVERAGE_TYPE]
    );
    return rowCount || 0;
}

module.exports = {
    SCHEDULE_COVERAGE_TYPE, SCHEDULE_COVERAGE_TTL_DAYS,
    getMemoryStats, countActiveMemoriesForUser, countOrgMemoryStats,
    upsertScheduleCoverage, getScheduleCoverage, pruneExpiredCoverage,
};
