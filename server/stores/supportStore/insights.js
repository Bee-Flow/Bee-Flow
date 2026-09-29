// @typecheck
/**
 * Insights — the dashboard aggregates over support_threads: CSAT averages,
 * handling/SLA percentiles, daily volume, busiest hours and the per-assignee
 * leaderboard, all under the same inbox/tag scoping the inbox list uses.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');

// ── Insights / dashboard aggregates ─────────────────────────────────────────

async function getInsights({ organizationId = null, inboxId = null, inboxIdIn = null, inboxIsNull = null, tagsIn = null, excludeTags = null } = {}) {
    await initDB();
    const clauses = [];
    const params = [];
    if (organizationId) { params.push(organizationId); clauses.push(`organization_id = $${params.length}`); }
    if (inboxId) { params.push(inboxId); clauses.push(`inbox_id = $${params.length}`); }
    if (inboxIdIn && inboxIdIn.length) { params.push(inboxIdIn); clauses.push(`inbox_id = ANY($${params.length}::uuid[])`); }
    if (inboxIsNull === true) { clauses.push(`inbox_id IS NULL`); }
    else if (inboxIsNull === false) { clauses.push(`inbox_id IS NOT NULL`); }
    if (tagsIn && tagsIn.length) { params.push(tagsIn); clauses.push(`jsonb_exists_any(tags, $${params.length}::text[])`); }
    if (excludeTags && excludeTags.length) { params.push(excludeTags); clauses.push(`(tags IS NULL OR NOT jsonb_exists_any(tags, $${params.length}::text[]))`); }
    const orgFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const csat = await pool.query(
        `SELECT
            AVG(csat_score) FILTER (WHERE csat_at > now() - interval '7 days')::numeric(3,2)  AS avg_7d,
            AVG(csat_score) FILTER (WHERE csat_at > now() - interval '30 days')::numeric(3,2) AS avg_30d,
            COUNT(*) FILTER (WHERE csat_score IS NOT NULL)                                    AS responses,
            COUNT(*) FILTER (WHERE status = 'resolved')                                       AS resolved_total
         FROM support_threads WHERE 1=1 ${orgFilter}`,
        params
    );

    const handling = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE ai_handled = true AND ai_escalated_reason IS NULL AND status IN ('resolved','closed','awaiting_user')) AS ai_resolved,
            COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND (ai_escalated_reason IS NOT NULL OR ai_handled = false))            AS staff_resolved,
            COUNT(*) FILTER (WHERE sla_first_response_breached_at IS NOT NULL OR sla_resolution_breached_at IS NOT NULL)                   AS sla_breaches,
            COUNT(*) AS total,
            EXTRACT(EPOCH FROM AVG(first_response_at - created_at) FILTER (WHERE first_response_at IS NOT NULL)) AS avg_first_response_secs,
            EXTRACT(EPOCH FROM AVG(resolved_at - created_at) FILTER (WHERE resolved_at IS NOT NULL))             AS avg_resolution_secs,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)))
                FILTER (WHERE first_response_at IS NOT NULL) AS p50_first_response_secs,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)))
                FILTER (WHERE first_response_at IS NOT NULL) AS p90_first_response_secs,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)))
                FILTER (WHERE resolved_at IS NOT NULL) AS p50_resolution_secs,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)))
                FILTER (WHERE resolved_at IS NOT NULL) AS p90_resolution_secs,
            COUNT(*) FILTER (WHERE status IN ('open','ai_responding','awaiting_agent'))                          AS open_backlog,
            MIN(created_at) FILTER (WHERE status = 'awaiting_agent')                                             AS oldest_waiting_at,
            COUNT(*) FILTER (WHERE first_response_at IS NOT NULL)                                                AS first_response_count,
            COUNT(*) FILTER (WHERE first_response_at IS NOT NULL AND sla_first_response_breached_at IS NULL)     AS first_response_within_sla
         FROM support_threads WHERE 1=1 ${orgFilter}`,
        params
    );

    // Daily ticket volume (last 30 days) — feeds the Insights sparkline.
    const volume = await pool.query(
        `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS period, COUNT(*)::int AS total
           FROM support_threads
          WHERE created_at > now() - interval '30 days' ${orgFilter}
          GROUP BY 1 ORDER BY 1`,
        params
    );

    // Busiest hours (UTC, last 30 days).
    const busiest = await pool.query(
        `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour, COUNT(*)::int AS count
           FROM support_threads
          WHERE created_at > now() - interval '30 days' ${orgFilter}
          GROUP BY 1 ORDER BY 1`,
        params
    );

    // Per-assignee leaderboard (resolved count + median first response).
    const agents = await pool.query(
        `SELECT assignee_user_id,
                COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)))
                    FILTER (WHERE first_response_at IS NOT NULL) AS p50_first_response_secs
           FROM support_threads
          WHERE assignee_user_id IS NOT NULL ${orgFilter}
          GROUP BY assignee_user_id
          ORDER BY resolved DESC NULLS LAST
          LIMIT 10`,
        params
    );

    const c = csat.rows[0] || {};
    const h = handling.rows[0] || {};
    const respondedRate = Number(c.resolved_total) > 0
        ? Number(c.responses) / Number(c.resolved_total)
        : 0;
    const num = (v) => (v != null ? Math.round(Number(v)) : null);
    const total = Number(h.total) || 0;
    const aiResolved = Number(h.ai_resolved) || 0;
    const frCount = Number(h.first_response_count) || 0;
    const frWithinSla = Number(h.first_response_within_sla) || 0;
    return {
        csat: {
            avg7d: c.avg_7d != null ? Number(c.avg_7d) : null,
            avg30d: c.avg_30d != null ? Number(c.avg_30d) : null,
            responses: Number(c.responses) || 0,
            responseRate: Number(respondedRate.toFixed(3)),
        },
        handling: {
            aiResolved,
            staffResolved: Number(h.staff_resolved) || 0,
            slaBreaches: Number(h.sla_breaches) || 0,
            total,
            avgFirstResponseSecs: num(h.avg_first_response_secs),
            avgResolutionSecs: num(h.avg_resolution_secs),
            p50FirstResponseSecs: num(h.p50_first_response_secs),
            p90FirstResponseSecs: num(h.p90_first_response_secs),
            p50ResolutionSecs: num(h.p50_resolution_secs),
            p90ResolutionSecs: num(h.p90_resolution_secs),
            openBacklog: Number(h.open_backlog) || 0,
            oldestWaitingAt: h.oldest_waiting_at || null,
            aiHandledRate: total > 0 ? Number((aiResolved / total).toFixed(3)) : null,
            firstResponseWithinSlaRate: frCount > 0 ? Number((frWithinSla / frCount).toFixed(3)) : null,
        },
        volume: volume.rows.map(r => ({ period: r.period, total: r.total })),
        busiestHours: busiest.rows.map(r => ({ hour: r.hour, count: r.count })),
        agents: agents.rows.map(r => ({
            userId: r.assignee_user_id,
            resolved: Number(r.resolved) || 0,
            p50FirstResponseSecs: num(r.p50_first_response_secs),
        })),
    };
}

module.exports = { getInsights };
