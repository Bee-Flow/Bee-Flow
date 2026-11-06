// @typecheck strict
/**
 * Where the AI goes: the organisation's ledger rows in a period, rolled up to
 * the areas of shared/usageAreas.js, and the same per ISO week.
 *
 * The roll-up happens in SQL against the vocabulary's own table (two arrays
 * unnested into a join), so the people and objects of an area are distinct
 * across its sources: a person who used two agent sources is one person of
 * the agents area, not two. A source the table does not know lands in
 * `other` with its raw name. Rides idx_usage_org_timestamp; no new index.
 */

'use strict';

const { AREAS } = require('../../shared/usageAreas');
const { ACTOR_SQL, ledgerWhere, areaMapArrays, weekBucketSql, weekKey, isoWeeksOf, num } = require('./shared');

/**
 * @typedef {import('./shared').Scope} Scope
 * @typedef {import('./shared').AdoptionDeps} AdoptionDeps
 * @typedef {{ source: string, calls: number, cost: number }} SourceRow
 * @typedef {{ area: string, kind: string | null, calls: number, cost: number, people: number, objects: number, sources: SourceRow[] }} AreaRow
 * @typedef {{ week: string, start: string, end: string, complete: boolean, total: number, byArea: Record<string, number> }} WeekRow
 */

/**
 * The ledger joined to the vocabulary: `l` is the row, `area` its area.
 * @param {string} where  a ledgerWhere WHERE over the unaliased columns
 * @param {number} mapIdx the parameter index of the two vocabulary arrays
 */
function mappedLedger(where, mapIdx) {
    return `FROM ai_usage_log
            LEFT JOIN unnest($${mapIdx}::text[], $${mapIdx + 1}::text[]) AS m(src, area) ON m.src = ai_usage_log.source
            ${where}`;
}

/**
 * @param {AdoptionDeps} d
 * @param {{ orgId: string, startDate: string, endDate: string, actors?: string[] | null }} opts
 */
async function areaRows(d, opts) {
    const w = ledgerWhere(opts);
    const params = [...w.params, ...areaMapArrays()];
    const from = mappedLedger(w.where, w.nextIdx);
    const [bySource, byArea] = await Promise.all([
        d.db.getAll(`SELECT COALESCE(m.area, 'other') AS area, COALESCE(source, 'unknown') AS source,
                            COUNT(*)::int AS calls, COALESCE(SUM(estimated_cost), 0)::float8 AS cost
                       ${from} GROUP BY 1, 2`, params),
        d.db.getAll(`SELECT COALESCE(m.area, 'other') AS area,
                            COUNT(DISTINCT ${ACTOR_SQL})::int AS people, COUNT(DISTINCT agent_id)::int AS objects
                       ${from} GROUP BY 1`, params),
    ]);
    return { bySource, byArea };
}

/**
 * Every area in vocabulary order, zero rows included.
 * @param {Array<Record<string, unknown>>} bySource
 * @param {Array<Record<string, unknown>>} byArea
 * @returns {AreaRow[]}
 */
function foldAreas(bySource, byArea) {
    /** @type {Map<string, AreaRow>} */
    const out = new Map(AREAS.map((a) => [a.id, { area: a.id, kind: a.kind, calls: 0, cost: 0, people: 0, objects: 0, sources: [] }]));
    for (const r of bySource) {
        const row = out.get(String(r.area)) || /** @type {AreaRow} */ (out.get('other'));
        const calls = num(r.calls);
        const cost = num(r.cost);
        row.calls += calls;
        row.cost += cost;
        row.sources.push({ source: String(r.source), calls, cost });
    }
    for (const r of byArea) {
        const row = out.get(String(r.area)) || /** @type {AreaRow} */ (out.get('other'));
        row.people += num(r.people);
        row.objects += num(r.objects);
    }
    for (const row of out.values()) row.sources.sort((a, b) => b.cost - a.cost || b.calls - a.calls);
    return [...out.values()];
}

/**
 * The area breakdown of a scope's period.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string[] | null} actors
 * @returns {Promise<AreaRow[]>}
 */
async function getAreaBreakdown(d, scope, actors) {
    const { bySource, byArea } = await areaRows(d, {
        orgId: scope.orgId, startDate: scope.period.startDate, endDate: scope.period.endDate, actors,
    });
    return foldAreas(bySource, byArea);
}

/**
 * Cost per area per ISO week of the period, oldest week first; `byArea` names
 * every area (0 when none).
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string[] | null} actors
 * @returns {Promise<WeekRow[]>}
 */
async function getAreaTimeline(d, scope, actors) {
    const weeks = isoWeeksOf(scope.period.startDate, scope.period.endDate, scope.now);
    if (weeks.length === 0) return [];
    // The ledger read starts at the first week shown, so a clamped long period
    // does not read the months the chart leaves out.
    const startDate = new Date(Math.max(Date.parse(weeks[0].start), Date.parse(scope.period.startDate))).toISOString();
    const w = ledgerWhere({ orgId: scope.orgId, startDate, endDate: scope.period.endDate, actors });
    const rows = await d.db.getAll(
        `SELECT COALESCE(m.area, 'other') AS area, ${weekBucketSql('timestamp')} AS wk,
                COALESCE(SUM(estimated_cost), 0)::float8 AS cost
           ${mappedLedger(w.where, w.nextIdx)} GROUP BY 1, 2`,
        [...w.params, ...areaMapArrays()],
    );
    /** @type {Map<string, WeekRow>} */
    const byKey = new Map(weeks.map((wk) => [weekKey(wk), {
        ...wk, total: 0, byArea: Object.fromEntries(AREAS.map((a) => [a.id, 0])),
    }]));
    for (const r of rows) {
        const row = byKey.get(String(r.wk));
        if (!row) continue;
        const area = String(r.area) in row.byArea ? String(r.area) : 'other';
        row.byArea[area] += num(r.cost);
        row.total += num(r.cost);
    }
    return [...byKey.values()];
}

module.exports = { getAreaBreakdown, getAreaTimeline, foldAreas };
