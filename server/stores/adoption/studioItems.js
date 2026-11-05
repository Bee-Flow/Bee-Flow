// @typecheck strict
/**
 * The drill-down of one Studio kind: its objects with owner, audience, when
 * each was last used, by how many people and at what cost; the people who use
 * the kind most (ids only: the route turns them into pseudonyms); and what was
 * published but not used in the period.
 */

'use strict';

const { kindDef } = require('./kinds');
const { evidenceIn, REAL_PERSON } = require('./studio');
const { ACTOR_SQL, ledgerWhere, sourcesOfArea, areaOfKind, num, timeOf } = require('./shared');

/**
 * @typedef {import('./shared').Scope} Scope
 * @typedef {import('./shared').AdoptionDeps} AdoptionDeps
 * @typedef {import('./kinds').KindDef} KindDef
 * @typedef {{
 *   id: string, name: string, ownerId: string | null, ownerName: string | null,
 *   audience: string, createdAt: string | null, publishedAt: string | null, published: boolean,
 *   lastUsedAt: string | null, people: number | null, uses: number | null, cost: number | null,
 * }} Item
 * @typedef {{ person: string, uses: number, cost: number }} TopPerson
 */

const TOP_PEOPLE = 5;
const UNUSED_MAX = 10;

/** @param {unknown} v */
function isoOrNull(v) {
    const t = timeOf(/** @type {string | Date | null} */ (v));
    return t == null ? null : new Date(t).toISOString();
}

/**
 * Per object: uses and people in the period, and the last use ever (up to the
 * end of the period), so an unused object still says when it was last used.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 */
async function evidenceByObject(d, def, scope) {
    const rows = await d.db.getAll(
        `SELECT object_id, COUNT(*) FILTER (WHERE ts >= $4)::int AS uses,
                COUNT(DISTINCT person) FILTER (WHERE ts >= $4 AND ${REAL_PERSON})::int AS people,
                MAX(ts) AS last_used_at
           FROM (${evidenceIn(def)}) x GROUP BY object_id`,
        [scope.orgId, new Date(0).toISOString(), scope.period.endDate, scope.period.startDate],
    );
    return new Map(rows.map((r) => [String(r.object_id), r]));
}

/**
 * Ledger cost per object (the ledger's agent_id is the object id for agents,
 * automations and apps), from the sources of the kind's area only.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @param {string[]} ids
 */
async function costByObject(d, def, scope, ids) {
    const area = areaOfKind(def.kind);
    if (!def.itemCost || !area || ids.length === 0) return null;
    const w = ledgerWhere({ orgId: scope.orgId, startDate: scope.period.startDate, endDate: scope.period.endDate });
    const rows = await d.db.getAll(
        `SELECT agent_id, COALESCE(SUM(estimated_cost), 0)::float8 AS cost FROM ai_usage_log
          ${w.where} AND source = ANY($${w.nextIdx}::text[]) AND agent_id = ANY($${w.nextIdx + 1}::text[])
          GROUP BY agent_id`,
        [...w.params, sourcesOfArea(area), ids],
    );
    return new Map(rows.map((r) => [String(r.agent_id), num(r.cost)]));
}

/**
 * The people who use the kind most: uses from the evidence, cost from the
 * ledger rows of the kind's area they caused; at most TOP_PEOPLE.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @returns {Promise<TopPerson[]>}
 */
async function topPeopleOf(d, def, scope) {
    /** @type {Map<string, TopPerson>} */
    const people = new Map();
    const entry = (/** @type {string} */ id) => people.get(id) || people.set(id, { person: id, uses: 0, cost: 0 }).get(id);
    if (def.evidence && def.peopleKnown) {
        const rows = await d.db.getAll(
            `SELECT person, COUNT(*)::int AS uses FROM (${evidenceIn(def)}) x WHERE ${REAL_PERSON}
              GROUP BY person ORDER BY uses DESC LIMIT 20`,
            [scope.orgId, scope.period.startDate, scope.period.endDate]);
        for (const r of rows) /** @type {TopPerson} */ (entry(String(r.person))).uses = num(r.uses);
    }
    const area = areaOfKind(def.kind);
    if (area) {
        const w = ledgerWhere({ orgId: scope.orgId, startDate: scope.period.startDate, endDate: scope.period.endDate });
        const rows = await d.db.getAll(
            `SELECT ${ACTOR_SQL} AS actor, COALESCE(SUM(estimated_cost), 0)::float8 AS cost FROM ai_usage_log
              ${w.where} AND source = ANY($${w.nextIdx}::text[]) AND ${ACTOR_SQL} IS NOT NULL
              GROUP BY 1 ORDER BY cost DESC LIMIT 20`,
            [...w.params, sourcesOfArea(area)]);
        for (const r of rows) /** @type {TopPerson} */ (entry(String(r.actor))).cost = num(r.cost);
    }
    return [...people.values()]
        .filter((p) => p.uses > 0 || p.cost > 0)
        .sort((a, b) => b.uses - a.uses || b.cost - a.cost)
        .slice(0, TOP_PEOPLE);
}

/**
 * Display names of the owners: an owner is organisational metadata.
 * @param {AdoptionDeps} d
 * @param {Array<Record<string, unknown>>} objects
 */
async function ownerNames(d, objects) {
    const ids = [...new Set(objects.map((o) => o.owner).filter(Boolean).map(String))];
    if (ids.length === 0) return new Map();
    const users = await d.userStore.getUserAvatarsByIds(ids);
    return new Map((users || []).map((/** @type {Record<string, unknown>} */ u) => [String(u.id), String(u.displayName || u.username || u.id)]));
}

/**
 * @param {Record<string, unknown>} o
 * @param {{ evidence: Map<string, Record<string, unknown>> | null, cost: Map<string, number> | null, names: Map<string, string> }} facts
 * @param {KindDef} def
 * @returns {Item}
 */
function itemOf(o, facts, def) {
    const id = String(o.id);
    const ev = facts.evidence ? facts.evidence.get(id) : null;
    const ownerId = o.owner == null ? null : String(o.owner);
    return {
        id,
        name: String(o.name ?? ''),
        ownerId,
        ownerName: ownerId ? facts.names.get(ownerId) || null : null,
        audience: String(o.audience || 'private'),
        published: !!o.published,
        createdAt: isoOrNull(o.created_at),
        publishedAt: isoOrNull(o.published_at),
        lastUsedAt: ev ? isoOrNull(ev.last_used_at) : null,
        people: facts.evidence && def.peopleKnown ? num(ev?.people) : null,
        uses: facts.evidence ? num(ev?.uses) : null,
        cost: facts.cost ? facts.cost.get(id) ?? 0 : null,
    };
}

/** @param {Item} a @param {Item} b */
function byUse(a, b) {
    return (b.people ?? -1) - (a.people ?? -1) || (b.uses ?? -1) - (a.uses ?? -1) || (b.cost ?? -1) - (a.cost ?? -1)
        || a.name.localeCompare(b.name);
}

/**
 * The drill-down of a kind. Null for a kind the report does not know.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string} kind
 * @param {number} limit
 */
async function getStudioItems(d, scope, kind, limit) {
    const def = kindDef(kind);
    if (!def) return null;
    const objects = await d.db.getAll(`${def.objects}`, [scope.orgId]);
    const ids = objects.map((o) => String(o.id));
    const [evidence, cost, names, topPeople] = await Promise.all([
        def.evidence ? evidenceByObject(d, def, scope) : Promise.resolve(null),
        costByObject(d, def, scope, ids),
        ownerNames(d, objects),
        topPeopleOf(d, def, scope),
    ]);
    const items = objects.map((o) => itemOf(o, { evidence, cost, names }, def)).sort(byUse);
    const unused = evidence
        ? items.filter((i) => i.published && !i.uses).slice(0, UNUSED_MAX).map((i) => ({
            id: i.id, name: i.name, ownerName: i.ownerName, publishedAt: i.publishedAt || i.createdAt, lastUsedAt: i.lastUsedAt,
        }))
        : [];
    return { kind, items: items.slice(0, limit), topPeople, unused, total: items.length };
}

module.exports = { getStudioItems, TOP_PEOPLE, UNUSED_MAX };
