// @typecheck strict
/**
 * Adoption per member: who is in the organisation, what each of them caused
 * in the ledger (calls, cost, the areas they used), what each of them built,
 * when they first used AI, and their status in the period.
 *
 * Returns user ids: turning them into pseudonyms or, after an audited reveal,
 * into names is the route's job (routes/usageAdoption.js).
 *
 * The ledger is grouped on COALESCE(actor_user_id, user_id): a run of an app
 * or automation started by a colleague counts for the colleague, not for the
 * owner whose account paid for it.
 */

'use strict';

const log = require('../../telemetry/log');
const { areaOf, AREA_IDS, TEST_SOURCES } = require('../../shared/usageAreas');
const { getOwners } = require('./studio');
const {
    ACTOR_SQL, DAY_MS, ledgerWhere, resolveMembers, memberStatus, actorsFor, lastSeenOf, num,
} = require('./shared');

/**
 * How far back the "caused for someone else" leg of a first use looks. The
 * actor column is young (rows before it carry none), and an unbounded read
 * would scan the organisation's whole ledger, which has no retention.
 */
const FIRST_USE_ACTOR_LOOKBACK_MS = 366 * DAY_MS;

/**
 * @typedef {import('./shared').Scope} Scope
 * @typedef {import('./shared').AdoptionDeps} AdoptionDeps
 * @typedef {import('./shared').Member} Member
 * @typedef {import('./shared').Period} Period
 * @typedef {{ calls: number, cost: number, areas: Map<string, number> }} ActorUse
 * @typedef {{
 *   id: string, member: import('./shared').UserRow, groupIds: string[],
 *   status: ReturnType<typeof memberStatus>, calls: number, cost: number, areas: string[],
 *   built: Record<string, number>, firstAiUseAt: string | null,
 * }} PersonRow
 */

/**
 * Calls, cost and cost per area of every person in the ledger of a period.
 * @param {AdoptionDeps} d
 * @param {string} orgId
 * @param {Period} period
 * @param {string[] | null} actors
 * @returns {Promise<Map<string, ActorUse>>}
 */
async function ledgerByActor(d, orgId, period, actors) {
    const w = ledgerWhere({ orgId, startDate: period.startDate, endDate: period.endDate, actors });
    const rows = await d.db.getAll(
        `SELECT ${ACTOR_SQL} AS actor, source, COUNT(*)::int AS calls, COALESCE(SUM(estimated_cost), 0)::float8 AS cost
           FROM ai_usage_log ${w.where} AND ${ACTOR_SQL} IS NOT NULL GROUP BY 1, 2`,
        w.params,
    );
    /** @type {Map<string, ActorUse>} */
    const out = new Map();
    for (const r of rows) {
        const id = String(r.actor);
        const use = out.get(id) || { calls: 0, cost: 0, areas: new Map() };
        use.calls += num(r.calls);
        use.cost += num(r.cost);
        const area = areaOf(/** @type {string} */ (r.source));
        use.areas.set(area, (use.areas.get(area) || 0) + num(r.cost) + 1e-9 * num(r.calls));
        out.set(id, use);
    }
    return out;
}

/**
 * Members, what they caused in the ledger and what they built: the one read
 * that summary, groups and people share. `partial` when the owners of a kind
 * could not be read (built counts and makers are then low).
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 */
async function memberActivity(d, scope) {
    const { members, groups, allGroups } = await resolveMembers(d, scope.orgId, scope.groupId || null);
    const actors = actorsFor(scope, members);
    const [byActor, owners] = await Promise.all([
        ledgerByActor(d, scope.orgId, scope.period, actors),
        getOwners(d, scope.orgId),
    ]);
    return { members, groups, allGroups, actors, byActor, owners: owners.byOwner, partial: owners.failed.length > 0 };
}

/**
 * The areas a person used, the costliest first.
 * @param {ActorUse | undefined} use
 */
function areasOf(use) {
    if (!use) return [];
    return [...use.areas.entries()]
        .sort((a, b) => b[1] - a[1] || AREA_IDS.indexOf(a[0]) - AREA_IDS.indexOf(b[0]))
        .map(([area]) => area);
}

/**
 * The first ledger row each person caused: when they started using AI. Two
 * bounded legs, never a scan of the organisation's whole ledger: the rows on
 * the person's own account, one index lookup per id (idx_usage_user_timestamp,
 * first row in time order), and the rows they caused on someone else's
 * account, within FIRST_USE_ACTOR_LOOKBACK_MS (idx_usage_org_timestamp).
 * @param {AdoptionDeps} d
 * @param {string} orgId
 * @param {string[]} ids
 * @param {number} now
 * @returns {Promise<Map<string, string>>}
 */
async function firstUseOf(d, orgId, ids, now) {
    if (ids.length === 0) return new Map();
    const notTest = '(source IS NULL OR source <> ALL($3::text[]))';
    const [own, caused] = await Promise.all([
        d.db.getAll(
            `SELECT p.id AS actor, (SELECT l.timestamp FROM ai_usage_log l
                     WHERE l.user_id = p.id AND l.organization_id = $1 AND l.actor_user_id IS NULL
                       AND l.tool_name IS NULL AND ${notTest.replace(/source/g, 'l.source')}
                     ORDER BY l.timestamp LIMIT 1) AS first
               FROM unnest($2::text[]) AS p(id)`,
            [orgId, ids, [...TEST_SOURCES]],
        ),
        d.db.getAll(
            `SELECT actor_user_id AS actor, MIN(timestamp) AS first FROM ai_usage_log
              WHERE organization_id = $1 AND timestamp >= $4 AND tool_name IS NULL AND ${notTest}
                AND actor_user_id = ANY($2::text[]) GROUP BY 1`,
            [orgId, ids, [...TEST_SOURCES], new Date(now - FIRST_USE_ACTOR_LOOKBACK_MS).toISOString()],
        ),
    ]);
    /** @type {Map<string, number>} */
    const first = new Map();
    for (const r of [...own, ...caused]) {
        if (r.first == null) continue;
        const t = new Date(/** @type {string} */ (r.first)).getTime();
        const id = String(r.actor);
        if (!first.has(id) || t < /** @type {number} */ (first.get(id))) first.set(id, t);
    }
    return new Map([...first].map(([id, t]) => [id, new Date(t).toISOString()]));
}

/**
 * @param {PersonRow} a
 * @param {PersonRow} b
 */
function byCostThenSeen(a, b) {
    return b.cost - a.cost || (lastSeenOf(b.member) ?? -1) - (lastSeenOf(a.member) ?? -1) || a.id.localeCompare(b.id);
}

/**
 * One page of people, sorted cost first, then last seen.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {{ limit: number, cursor: number }} page
 */
async function getPeople(d, scope, { limit, cursor }) {
    const act = await memberActivity(d, scope);
    /** @type {PersonRow[]} */
    const rows = act.members.map(({ member, groupIds }) => {
        const id = String(member.id);
        const use = act.byActor.get(id);
        return {
            id, member, groupIds,
            status: memberStatus(member, !!use, scope.period, scope.now),
            calls: use ? use.calls : 0,
            cost: use ? use.cost : 0,
            areas: areasOf(use),
            built: act.owners.get(id)?.built || {},
            firstAiUseAt: null,
        };
    }).sort(byCostThenSeen);
    const pageRows = rows.slice(cursor, cursor + limit);
    let partial = act.partial;
    try {
        const first = await firstUseOf(d, scope.orgId, pageRows.map((r) => r.id), scope.now);
        for (const r of pageRows) r.firstAiUseAt = first.get(r.id) || null;
    } catch (err) {
        partial = true;
        log.warn('[Adoption] first AI use failed:', /** @type {Error} */ (err)?.message || err);
    }
    const next = cursor + limit;
    return {
        people: pageRows, groups: act.groups, allGroups: act.allGroups,
        total: rows.length, nextCursor: next < rows.length ? next : null, partial,
    };
}

module.exports = { getPeople, memberActivity, ledgerByActor, areasOf };
