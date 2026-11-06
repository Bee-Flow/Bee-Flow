// @typecheck strict
/**
 * The organisation's Studio inventory (kinds.js) with who built it and who
 * uses it: one row per kind for the overview, and the objects of one kind for
 * the drill-down.
 *
 * Every kind is read inside its own try/catch: a table that is missing (a
 * module this install does not run) or a store having a bad day drops that
 * kind to zeros and marks the answer partial, never the whole answer. A kind
 * the organisation's licence leaves out is still listed, with total 0: the
 * report never answers 403 for one kind.
 *
 * With a group (`actors`), what people DID narrows to its members: usage
 * evidence, cost, trend and delta. The inventory (total, published, makers,
 * new in the period) stays organisation-wide: what exists is the
 * organisation's, whoever in the group uses it.
 */

'use strict';

const log = require('../../telemetry/log');
const { PLATFORM_OPERATOR_ID } = require('../../auth/platformOperator');
const { KINDS } = require('./kinds');
const { getAreaBreakdown, getAreaTimeline } = require('./areas');
const {
    areaOfKind, isoWeeksOf, weekBucketSql, weekKey,
    previousPeriod, num, deltaPct,
} = require('./shared');

/**
 * @typedef {import('./shared').Scope} Scope
 * @typedef {import('./shared').AdoptionDeps} AdoptionDeps
 * @typedef {import('./kinds').KindDef} KindDef
 * @typedef {{ events: number, people: number | null, label: string }} Usage
 * @typedef {{
 *   kind: string, total: number, published: number, makers: number, newInPeriod: number,
 *   usage: Usage | null, cost: number | null, trend: number[], deltaPct: number | null,
 * }} KindRow
 */

/** @param {string} value */
const sqlText = (value) => `'${value.replace(/'/g, "''")}'`;

/**
 * A person of the evidence who is a member-like person: guest accounts are
 * not, and the platform operator is nobody's member (as in ledgerWhere).
 */
const REAL_PERSON = `person IS NOT NULL AND person NOT LIKE 'guest\\_%' AND person <> ${sqlText(PLATFORM_OPERATOR_ID)}`;

/**
 * The evidence of a kind between two instants ($2, $3); with `actorsIdx`,
 * only the uses by the people in that text[] parameter (a group).
 * @param {KindDef} def
 * @param {number | null} [actorsIdx]
 */
function evidenceIn(def, actorsIdx = null) {
    if (!def.evidence) throw new Error(`${def.kind} has no evidence`);
    const narrow = actorsIdx ? ` AND e.person = ANY($${actorsIdx}::text[])` : '';
    return `SELECT * FROM (${def.evidence(def.objects)}) e WHERE e.ts >= $2 AND e.ts <= $3${narrow}`;
}

/**
 * The parameters of an evidence read over [start, end], with the actors last.
 * @param {string} orgId
 * @param {string} start
 * @param {string} end
 * @param {string[] | null} actors
 */
function evidenceParams(orgId, start, end, actors) {
    return actors ? [orgId, start, end, actors] : [orgId, start, end];
}

/**
 * total, published, makers and new-in-period of a kind.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 */
async function inventoryOf(d, def, scope) {
    const row = await d.db.getOne(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE published)::int AS published,
                COUNT(DISTINCT owner)::int AS makers,
                COUNT(*) FILTER (WHERE created_at >= $2 AND created_at <= $3)::int AS new_in_period
           FROM (${def.objects}) o`,
        [scope.orgId, scope.period.startDate, scope.period.endDate],
    );
    return { total: num(row?.total), published: num(row?.published), makers: num(row?.makers), newInPeriod: num(row?.new_in_period) };
}

/**
 * Uses of a kind in the period, in total and per ISO week (Monday date).
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @param {string[] | null} actors
 */
async function usageOf(d, def, scope, actors) {
    const rows = await d.db.getAll(
        `SELECT ${weekBucketSql('ts')} AS wk, GROUPING(${weekBucketSql('ts')}) AS whole,
                COUNT(*)::int AS events, COUNT(DISTINCT person) FILTER (WHERE ${REAL_PERSON})::int AS people
           FROM (${evidenceIn(def, actors ? 4 : null)}) x
          GROUP BY GROUPING SETS ((${weekBucketSql('ts')}), ())`,
        evidenceParams(scope.orgId, scope.period.startDate, scope.period.endDate, actors),
    );
    const whole = rows.find((r) => num(r.whole) === 1);
    /** @type {Map<string, number>} */
    const byWeek = new Map(rows.filter((r) => num(r.whole) === 0).map((r) => [String(r.wk), num(r.events)]));
    return { events: num(whole?.events), people: num(whole?.people), byWeek };
}

/**
 * Uses of a kind in the previous period of the same length.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @param {string[] | null} actors
 */
async function previousEventsOf(d, def, scope, actors) {
    const prev = previousPeriod(scope.period);
    const row = await d.db.getOne(`SELECT COUNT(*)::int AS events FROM (${evidenceIn(def, actors ? 4 : null)}) x`,
        evidenceParams(scope.orgId, prev.startDate, prev.endDate, actors));
    return num(row?.events);
}

/**
 * The ledger cost of every area, now, per week and in the previous period:
 * what the kinds without a usage signal fall back on.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string[] | null} actors
 */
async function areaCosts(d, scope, actors) {
    const prevScope = { ...scope, period: previousPeriod(scope.period) };
    const [now, weeks, before] = await Promise.all([
        getAreaBreakdown(d, scope, actors),
        getAreaTimeline(d, scope, actors),
        getAreaBreakdown(d, prevScope, actors),
    ]);
    return {
        cost: new Map(now.map((a) => [a.area, a.cost])),
        prev: new Map(before.map((a) => [a.area, a.cost])),
        weeks,
    };
}

/**
 * One kind's overview row.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @param {Awaited<ReturnType<typeof areaCosts>> | null} costs
 * @param {string[] | null} actors
 * @returns {Promise<KindRow>}
 */
async function kindRow(d, def, scope, costs, actors) {
    const weeks = isoWeeksOf(scope.period.startDate, scope.period.endDate, scope.now);
    const inv = await inventoryOf(d, def, scope);
    const area = areaOfKind(def.kind);
    const cost = area && costs ? costs.cost.get(area) ?? 0 : null;
    if (!def.evidence) {
        const trend = area && costs
            ? costs.weeks.map((w) => w.byArea[area] || 0)
            : weeks.map(() => 0);
        const before = area && costs ? costs.prev.get(area) ?? 0 : null;
        return { kind: def.kind, ...inv, usage: null, cost, trend, deltaPct: cost == null ? null : deltaPct(cost, before) };
    }
    const use = await usageOf(d, def, scope, actors);
    const prevEvents = await previousEventsOf(d, def, scope, actors);
    return {
        kind: def.kind,
        ...inv,
        usage: { events: use.events, people: def.peopleKnown ? use.people : null, label: String(def.label) },
        cost,
        trend: weeks.map((w) => use.byWeek.get(weekKey(w)) || 0),
        deltaPct: deltaPct(use.events, prevEvents),
    };
}

/**
 * A kind that could not be read: listed, with nothing in it.
 * @param {KindDef} def
 * @param {Scope} scope
 * @returns {KindRow}
 */
function emptyRow(def, scope) {
    const weeks = isoWeeksOf(scope.period.startDate, scope.period.endDate, scope.now);
    return {
        kind: def.kind, total: 0, published: 0, makers: 0, newInPeriod: 0,
        usage: null, cost: null, trend: weeks.map(() => 0), deltaPct: null,
    };
}

/**
 * The overview: every kind in report order.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string[] | null} [actors]  the members of the scope's group, null for the organisation
 * @returns {Promise<{ kinds: KindRow[], partial: boolean }>}
 */
async function getStudioOverview(d, scope, actors = null) {
    let partial = false;
    /** @type {Awaited<ReturnType<typeof areaCosts>> | null} */
    let costs = null;
    try {
        costs = await areaCosts(d, scope, actors);
    } catch (err) {
        partial = true;
        log.warn('[Adoption] studio area costs failed:', /** @type {Error} */ (err)?.message || err);
    }
    const kinds = await Promise.all(KINDS.map(async (def) => {
        try {
            return await kindRow(d, def, scope, costs, actors);
        } catch (err) {
            partial = true;
            log.warn(`[Adoption] studio ${def.kind} failed:`, /** @type {Error} */ (err)?.message || err);
            return emptyRow(def, scope);
        }
    }));
    return { kinds, partial };
}

/**
 * Per owner, how many objects of every kind they own and when they built their
 * first: who the makers are. A kind that cannot be read is left out and named.
 * @param {AdoptionDeps} d
 * @param {string} orgId
 * @returns {Promise<{ byOwner: Map<string, { built: Record<string, number>, first: number | null }>, failed: string[] }>}
 */
async function getOwners(d, orgId) {
    /** @type {Map<string, { built: Record<string, number>, first: number | null }>} */
    const byOwner = new Map();
    /** @type {string[]} */
    const failed = [];
    await Promise.all(KINDS.map(async (def) => {
        try {
            const rows = await d.db.getAll(
                `SELECT owner, COUNT(*)::int AS n, MIN(created_at) AS first FROM (${def.objects}) o
                  WHERE owner IS NOT NULL GROUP BY owner`, [orgId]);
            for (const r of rows) {
                const owner = String(r.owner);
                const entry = byOwner.get(owner) || { built: {}, first: null };
                entry.built[def.kind] = num(r.n);
                const first = r.first ? new Date(r.first).getTime() : null;
                if (first != null && (entry.first == null || first < entry.first)) entry.first = first;
                byOwner.set(owner, entry);
            }
        } catch (err) {
            failed.push(def.kind);
            log.warn(`[Adoption] owners of ${def.kind} failed:`, /** @type {Error} */ (err)?.message || err);
        }
    }));
    return { byOwner, failed };
}

module.exports = { getStudioOverview, getOwners, evidenceIn, evidenceParams, REAL_PERSON };
