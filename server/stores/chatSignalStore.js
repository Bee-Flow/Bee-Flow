// @typecheck
/**
 * chat_signal_counts — chat signals: how the Privacy Shield handled chat
 * messages, as counters only.
 *
 * Written by core/privacy/chatSignals.js (an in-process aggregator flushed
 * once a minute); read by the summary route, GDPR-Art32-chat-shield-coverage,
 * GDPR-Art35-chat-monitoring-safeguards and the RoPA entry, every one of them
 * through stores/lib/chatSignalSuppression.js.
 *
 * One row per (org, period, granularity, surface, signal, value, destination,
 * provider_type, protection) holding a number of turns. Employee chats are
 * weekly rows (ISO-week Monday, UTC), website visitors daily rows.
 *
 * NEVER STORED, here or anywhere this feature writes: user, guest,
 * conversation, agent, project or model ids or names; message or entity text;
 * offsets, token maps or hashes of anything; IP or user agent; the label text
 * of org-defined data types and DLP terms (those become 'other').
 *
 * STATUS OF THIS DATA. The table holds no identifiers, yet it is personal data
 * for the controller wherever few people contribute: the same controller holds
 * ai_usage_log and guardrail_events with user_id, so a sparse cell can be
 * linked to a person. The GDPR applies in full. Because the rows carry no
 * identifier, an Art. 15 request cannot select them (Art. 11(2)); the RoPA
 * entry says so.
 *
 * The SQL CHECKs guard the charset only. The closed vocabulary is enforced in
 * JS by addCounts, which throws on any value outside chatMonitoringVocab, so a
 * new surface in a later phase needs no DDL. No index besides the primary key:
 * its (organization_id, period_start) prefix serves every read and the purge.
 *
 * Built by a factory over a `{ query }` handle so the pglite test runs the
 * store's own SQL without module mocking; the default instance wraps the pool.
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const V = require('./lib/chatMonitoringVocab');
const log = require('../telemetry/log');

const DDL = `
    CREATE TABLE IF NOT EXISTS chat_signal_counts (
        organization_id TEXT NOT NULL CHECK (organization_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
        period_start    DATE NOT NULL,
        granularity     TEXT NOT NULL CHECK (granularity IN ('week', 'day')),
        surface         TEXT NOT NULL CHECK (surface ~ '^[a-z_]{1,32}$'),
        signal          TEXT NOT NULL CHECK (signal IN ('outcome', 'kind')),
        value           TEXT NOT NULL CHECK (value ~ '^[a-z_]{1,32}$'),
        destination     TEXT NOT NULL CHECK (destination IN ('internal', 'external', 'unknown')),
        provider_type   TEXT NOT NULL DEFAULT '' CHECK (provider_type ~ '^[a-z0-9_]{0,32}$'),
        protection      TEXT NOT NULL DEFAULT '' CHECK (protection IN ('', 'protected', 'exposed')),
        turns           INTEGER NOT NULL CHECK (turns >= 0),
        PRIMARY KEY (organization_id, period_start, granularity, surface, signal, value,
                     destination, provider_type, protection)
    );
`;

const ORG_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PK = ['organization_id', 'period_start', 'granularity', 'surface', 'signal', 'value', 'destination', 'provider_type', 'protection'];
const COLS = [...PK, 'turns'];
/** One statement holds at most this many rows (10 binds each, under Postgres' 65 535). */
const MAX_ROWS_PER_STATEMENT = 5000;
const MAX_TURNS = 1_000_000_000;

/** The first invalid field of a row, by name; never its value. */
function _invalidField(r) {
    if (!r || typeof r !== 'object') return 'row';
    if (typeof r.organization_id !== 'string' || !ORG_RE.test(r.organization_id)) return 'organization_id';
    if (!V.SURFACES.includes(r.surface)) return 'surface';
    if (!V.GRANULARITY.includes(r.granularity) || r.granularity !== V.granularityFor(r.surface)) return 'granularity';
    if (typeof r.period_start !== 'string' || !DAY_RE.test(r.period_start)) return 'period_start';
    const t = Date.parse(`${r.period_start}T00:00:00.000Z`);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== r.period_start) return 'period_start';
    if (r.granularity === 'week' && new Date(t).getUTCDay() !== 1) return 'period_start';
    if (!V.ROW_SIGNALS.includes(r.signal)) return 'signal';
    if (r.signal === 'outcome' ? !V.OUTCOMES.includes(r.value) : !V.KINDS.includes(r.value)) return 'value';
    if (!V.DESTINATIONS.includes(r.destination)) return 'destination';
    if (r.signal === 'outcome') {
        if (r.provider_type !== '' && !V.PROVIDER_TYPES.includes(r.provider_type)) return 'provider_type';
        if (r.protection !== '') return 'protection';
    } else {
        // Kind rows never carry a provider (amendment 6).
        if (r.provider_type !== '') return 'provider_type';
        if (r.protection !== 'protected' && r.protection !== 'exposed') return 'protection';
    }
    if (!Number.isInteger(r.turns) || r.turns < 1 || r.turns > MAX_TURNS) return 'turns';
    return null;
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} db
 * @param {{ ready?: () => Promise<unknown> }} [opts]
 */
function makeChatSignalStore(db, { ready = async () => {} } = {}) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    /**
     * Add turns to the counters. Every row is checked against the vocabulary
     * first; the first bad field throws `chat_signal_invalid:<field>` and
     * nothing is written. Rows with the same key are summed, then written in
     * ONE additive upsert, so concurrent pods add up instead of overwriting.
     *
     * @param {Array<{organization_id: string, period_start: string, granularity: string, surface: string,
     *   signal: string, value: string, destination: string, provider_type: string, protection: string, turns: number}>} rows
     * @returns {Promise<number>} the number of keys written
     */
    async function addCounts(rows) {
        const list = Array.isArray(rows) ? rows : [];
        /** @type {Map<string, any>} */
        const merged = new Map();
        for (const r of list) {
            const bad = _invalidField(r);
            if (bad) throw new Error(`chat_signal_invalid:${bad}`);
            const key = PK.map(c => r[c]).join('|');
            const prev = merged.get(key);
            if (prev) prev.turns += r.turns;
            else merged.set(key, Object.fromEntries(COLS.map(c => [c, r[c]])));
        }
        const all = [...merged.values()];
        for (let i = 0; i < all.length; i += MAX_ROWS_PER_STATEMENT) {
            const chunk = all.slice(i, i + MAX_ROWS_PER_STATEMENT);
            const params = [];
            const tuples = chunk.map((r) => {
                const at = params.length;
                params.push(...COLS.map(c => r[c]));
                return `(${COLS.map((c, j) => `$${at + j + 1}${c === 'period_start' ? '::date' : ''}`).join(', ')})`;
            });
            await q(`
                INSERT INTO chat_signal_counts (${COLS.join(', ')})
                VALUES ${tuples.join(',\n                       ')}
                ON CONFLICT (${PK.join(', ')})
                DO UPDATE SET turns = chat_signal_counts.turns + EXCLUDED.turns
            `, params);
        }
        return all.length;
    }

    /** @param {{ from: string, to: string, surfaces: string[], granularity?: string }} w */
    function _window(orgId, w) {
        const surfaces = (w?.surfaces || []).filter(s => V.SURFACES.includes(s));
        return { org: String(orgId), from: w?.from, to: w?.to, surfaces, granularity: w?.granularity || null };
    }

    /**
     * Outcome turns per surface, outcome, destination and provider type,
     * summed over `from <= period_start <= to`.
     * @param {string} orgId
     * @param {{ from: string, to: string, surfaces: string[], granularity?: string }} w
     * @returns {Promise<Array<{surface: string, value: string, destination: string, provider_type: string, turns: number}>>}
     */
    async function outcomeTotals(orgId, w) {
        const x = _window(orgId, w);
        if (!x.surfaces.length || !x.from || !x.to) return [];
        const { rows } = await q(`
            SELECT surface, value, destination, provider_type, SUM(turns)::bigint AS turns
            FROM chat_signal_counts
            WHERE organization_id = $1 AND period_start >= $2::date AND period_start <= $3::date
              AND signal = 'outcome' AND surface = ANY($4::text[])
              AND ($5::text IS NULL OR granularity = $5::text)
            GROUP BY surface, value, destination, provider_type
            ORDER BY surface, value, destination, provider_type
        `, [x.org, x.from, x.to, x.surfaces, x.granularity]);
        return rows.map(r => ({ surface: r.surface, value: r.value, destination: r.destination, provider_type: r.provider_type, turns: Number(r.turns) || 0 }));
    }

    /**
     * Kind turns per surface, kind, protection and destination.
     * @param {string} orgId
     * @param {{ from: string, to: string, surfaces: string[], granularity?: string }} w
     * @returns {Promise<Array<{surface: string, value: string, protection: string, destination: string, turns: number}>>}
     */
    async function kindTotals(orgId, w) {
        const x = _window(orgId, w);
        if (!x.surfaces.length || !x.from || !x.to) return [];
        const { rows } = await q(`
            SELECT surface, value, protection, destination, SUM(turns)::bigint AS turns
            FROM chat_signal_counts
            WHERE organization_id = $1 AND period_start >= $2::date AND period_start <= $3::date
              AND signal = 'kind' AND surface = ANY($4::text[])
              AND ($5::text IS NULL OR granularity = $5::text)
            GROUP BY surface, value, protection, destination
            ORDER BY surface, value, protection, destination
        `, [x.org, x.from, x.to, x.surfaces, x.granularity]);
        return rows.map(r => ({ surface: r.surface, value: r.value, protection: r.protection, destination: r.destination, turns: Number(r.turns) || 0 }));
    }

    /**
     * How many distinct people used a surface in [from, toExclusive), from
     * ai_usage_log. A NUMBER ONLY: no id leaves this function.
     *
     *   direct        direct chat and the Swarm tier, attributed to the org
     *                 the same way GDPR-Art32-dlp-efficacy does (the row's
     *                 org, else its user's org); for 'default', rows that
     *                 resolve to no organisation at all.
     *   agent         agent chat on the org's agents by members whose home
     *                 org is this org (members only through a group are left
     *                 out: the safe direction); never guests.
     *   agent_public  no contributor gate for website visitors: null.
     *
     * An UPPER bound of the people behind the counted turns: ai_usage_log also
     * holds turns that were not counted (no notice marker, an objection). Do
     * not join the objection table to correct it: that would make objections
     * visible through the suppression. ai_usage_log is a volume table: the
     * predicates are the sargable ones the efficacy check uses, and no index
     * is added for this.
     *
     * @param {string} orgId
     * @param {string} surface
     * @param {{ from: string, toExclusive: string }} w
     * @returns {Promise<number|null>}
     */
    async function contributorCount(orgId, surface, { from, toExclusive }) {
        const org = String(orgId);
        if (surface === 'direct') {
            const noOrgOnRow = `(t.organization_id IS NULL OR t.organization_id = '')`;
            const memberOrg = `NULLIF(u."organizationId", '')`;
            const resolvesToOrg = `(t.organization_id = $1 OR (${noOrgOnRow} AND ${memberOrg} = $1))`;
            const belongs = org === 'default'
                ? `(${resolvesToOrg} OR (${noOrgOnRow} AND ${memberOrg} IS NULL))`
                : resolvesToOrg;
            const { rows } = await q(`
                SELECT COUNT(DISTINCT t.user_id)::int AS n
                FROM ai_usage_log t
                LEFT JOIN users u ON u.id = t.user_id
                WHERE t.timestamp >= $2::timestamptz AND t.timestamp < $3::timestamptz
                  AND t.source IN ('direct_chat', 'swarm', 'swarm_orchestrator')
                  AND t.user_id IS NOT NULL AND t.user_id NOT LIKE 'guest\\_%'
                  AND (t.organization_id = $1 OR ${noOrgOnRow})
                  AND ${belongs}
            `, [org, from, toExclusive]);
            return Number(rows[0]?.n) || 0;
        }
        if (surface === 'agent') {
            const { rows } = await q(`
                SELECT COUNT(DISTINCT t.user_id)::int AS n
                FROM ai_usage_log t
                JOIN users u ON u.id = t.user_id
                WHERE t.timestamp >= $2::timestamptz AND t.timestamp < $3::timestamptz
                  AND t.source = 'agent_stream' AND t.organization_id = $1
                  AND t.user_id NOT LIKE 'guest\\_%'
                  AND u."organizationId" = $1
            `, [org, from, toExclusive]);
            return Number(rows[0]?.n) || 0;
        }
        return null;
    }

    /** Does the org have any counts left? (The RoPA lists the activity while it does.) */
    async function hasRows(orgId) {
        const { rows } = await q(`SELECT 1 AS one FROM chat_signal_counts WHERE organization_id = $1 LIMIT 1`, [String(orgId)]);
        return rows.length > 0;
    }

    /** "Delete collected counts": every row of the org. @returns {Promise<number>} */
    async function deleteAll(orgId) {
        const r = await q(`DELETE FROM chat_signal_counts WHERE organization_id = $1`, [String(orgId)]);
        return r.rowCount || 0;
    }

    /**
     * Retention: whole periods (weeks, or days for website visitors) go once
     * all of the period is older than the org's retention, 30-90 days with
     * 90 for an org without a setting. One statement over every org.
     * @returns {Promise<number>}
     */
    async function purgeExpired() {
        const r = await q(`
            DELETE FROM chat_signal_counts c
            USING (
                SELECT o.organization_id,
                       LEAST(${V.RETENTION.max}, GREATEST(${V.RETENTION.min}, COALESCE(s.chat_monitoring_retention_days, ${V.RETENTION.default}))) AS days
                FROM (SELECT DISTINCT organization_id FROM chat_signal_counts) o
                LEFT JOIN compliance_settings s ON s.organization_id = o.organization_id
            ) r
            WHERE c.organization_id = r.organization_id
              AND c.period_start + (CASE WHEN c.granularity = 'week' THEN 7 ELSE 1 END) <= CURRENT_DATE - r.days
        `);
        return r.rowCount || 0;
    }

    return { addCounts, outcomeTotals, kindTotals, contributorCount, hasRows, deleteAll, purgeExpired };
}

const initDB = makeStoreInit('ChatSignalStore', async () => {
    await exec(DDL);
    log.info('[ChatSignalStore] PostgreSQL initialized');
});

const defaultStore = makeChatSignalStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    makeChatSignalStore,
    ...defaultStore,
};
