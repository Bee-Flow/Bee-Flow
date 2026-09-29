// @typecheck
/**
 * Feedback Store — Tracks user feedback (thumbs up/down) on AI responses
 * PostgreSQL-backed for admin monitoring dashboard.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');

// Schema init
const initDB = makeStoreInit('FeedbackStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS message_feedback (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            message_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            model TEXT,
            model_tier TEXT,
            user_id TEXT,
            organization_id TEXT,
            rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
            comment TEXT,
            source TEXT DEFAULT 'agent',
            conversation_snapshot TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    // Backfill columns on existing installs (idempotent) + indexes — via
    // runDdl (stores/lib/_ddl.js): fouten per statement luid verzameld
    // i.p.v. stil ingeslikt.
    await runDdl('feedbackStore', [
        `ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS agent_name TEXT`,
        `ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS model TEXT`,
        `ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS model_tier TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_feedback_created ON message_feedback(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_feedback_rating ON message_feedback(rating)`,
        `CREATE INDEX IF NOT EXISTS idx_feedback_agent ON message_feedback(agent_id)`,
        `CREATE INDEX IF NOT EXISTS idx_feedback_conversation ON message_feedback(conversation_id)`,
    ]);
}

log.info('[FeedbackStore] Initialized (PostgreSQL)');

// ============ Write ============

async function saveFeedback({ conversationId, messageId, agentId, agentName, model, modelTier, userId, organizationId, rating, comment, source, conversationSnapshot }) {
    await initDB();
    try {
        const id = `${conversationId || 'none'}_${messageId || 'none'}_${userId || 'anon'}`;
        const now = new Date().toISOString();
        const snapshot = conversationSnapshot ? JSON.stringify(conversationSnapshot) : null;
        await run(`
            INSERT INTO message_feedback (id, conversation_id, message_id, agent_id, agent_name, model, model_tier, user_id, organization_id, rating, comment, source, conversation_snapshot, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT(id) DO UPDATE SET
                rating = EXCLUDED.rating,
                comment = EXCLUDED.comment,
                conversation_snapshot = EXCLUDED.conversation_snapshot,
                organization_id = EXCLUDED.organization_id,
                agent_name = COALESCE(EXCLUDED.agent_name, message_feedback.agent_name),
                model = COALESCE(EXCLUDED.model, message_feedback.model),
                model_tier = COALESCE(EXCLUDED.model_tier, message_feedback.model_tier),
                created_at = EXCLUDED.created_at
        `, [
            id,
            conversationId || null,
            messageId || null,
            agentId || null,
            agentName || null,
            model || null,
            modelTier || null,
            userId || null,
            organizationId || null,
            rating,
            comment || null,
            source || 'agent',
            snapshot,
            now
        ]);
        return { id };
    } catch (e) {
        log.error('[FeedbackStore] Failed to save feedback:', e.message);
        throw e;
    }
}

// ============ Queries ============

function buildFilters(filters) {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (filters?.startDate) {
        conditions.push(`created_at >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`created_at <= $${idx++}`);
        params.push(filters.endDate);
    }
    if (filters?.rating) {
        conditions.push(`rating = $${idx++}`);
        params.push(filters.rating);
    }
    if (filters?.agentId) {
        conditions.push(`agent_id = $${idx++}`);
        params.push(filters.agentId);
    }
    if (filters?.source) {
        conditions.push(`source = $${idx++}`);
        params.push(filters.source);
    }
    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

async function getFeedback(filters = {}, limit = 200) {
    await initDB();
    const { where, params, nextIdx } = buildFilters(filters);
    return getAll(`
        SELECT * FROM message_feedback ${where}
        ORDER BY created_at DESC
        LIMIT $${nextIdx}
    `, [...params, limit]);
}

async function getFeedbackSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total,
            COALESCE(SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END), 0) as thumbs_up,
            COALESCE(SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END), 0) as thumbs_down,
            COALESCE(SUM(CASE WHEN comment IS NOT NULL AND comment != '' THEN 1 ELSE 0 END), 0) as with_comments
        FROM message_feedback ${where}
    `, params);
}

module.exports = {
    saveFeedback,
    getFeedback,
    getFeedbackSummary,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
