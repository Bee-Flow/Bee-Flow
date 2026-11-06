// @typecheck strict
/**
 * The drill-down of one Studio kind: its objects with owner, audience, when
 * each was last used, by how many people and at what cost; the people who use
 * the kind most (ids only: the route turns them into pseudonyms); and what was
 * published but not used in the period.
 *
 * Privacy: a private object (audience 'private') is counted in `total` and
 * never listed: its title is its owner's, not the organisation's. For a kind
 * whose evidence person IS the owner (a recording, a Cowork job), an item
 * carries no owner, so a use count never sits next to a named person.
 *
 * With a group (`actors`), uses, people, cost and the top people narrow to its
 * members; which objects exist (`items`, `total`) stays organisation-wide.
 */

'use strict';

const { kindDef } = require('./kinds');
const { evidenceIn, evidenceParams, REAL_PERSON } = require('./studio');
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
 * @typedef {{ id: string, name: string, ownerId: string | null, ownerName: string | null, publishedAt: string | null, lastUsedAt: string | null }} UnusedItem
 * @typedef {{ person: string, uses: number, cost: number }} TopPerson
 */

const TOP_PEOPLE = 5;
const UNUSED_MAX = 10;
/** How many people each ranking (uses, cost) proposes for the top. */
const CANDIDATES = 20;

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
 * @param {string[] | null} actors
 */
async function evidenceByObject(d, def, scope, actors) {
    const params = [scope.orgId, new Date(0).toISOString(), scope.period.endDate, scope.period.startDate];
    const rows = await d.db.getAll(
        `SELECT object_id, COUNT(*) FILTER (WHERE ts >= $4)::int AS uses,
                COUNT(DISTINCT person) FILTER (WHERE ts >= $4 AND ${REAL_PERSON})::int AS people,
                MAX(ts) AS last_used_at
           FROM (${evidenceIn(def, actors ? 5 : null)}) x GROUP BY object_id`,
        actors ? [...params, actors] : params,
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
 * @param {string[] | null} actors
 */
async function costByObject(d, def, scope, ids, actors) {
    const area = areaOfKind(def.kind);
    if (!def.itemCost || !area || ids.length === 0) return null;
    const w = ledgerWhere({ orgId: scope.orgId, startDate: scope.period.startDate, endDate: scope.period.endDate, actors });
    const rows = await d.db.getAll(
        `SELECT agent_id, COALESCE(SUM(estimated_cost), 0)::float8 AS cost FROM ai_usage_log
          ${w.where} AND source = ANY($${w.nextIdx}::text[]) AND agent_id = ANY($${w.nextIdx + 1}::text[])
          GROUP BY agent_id`,
        [...w.params, sourcesOfArea(area), ids],
    );
    return new Map(rows.map((r) => [String(r.agent_id), num(r.cost)]));
}

/**
 * Uses per person from the evidence, the CANDIDATES busiest.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @param {string[] | null} actors
 * @returns {Promise<Map<string, number>>}
 */
async function usesByPerson(d, def, scope, actors) {
    const rows = await d.db.getAll(
        `SELECT person, COUNT(*)::int AS uses FROM (${evidenceIn(def, actors ? 4 : null)}) x WHERE ${REAL_PERSON}
          GROUP BY person ORDER BY uses DESC LIMIT ${CANDIDATES}`,
        evidenceParams(scope.orgId, scope.period.startDate, scope.period.endDate, actors));
    return new Map(rows.map((r) => [String(r.person), num(r.uses)]));
}

/**
 * Ledger cost per person in an area: the CANDIDATES costliest, and the exact
 * cost of every person in `ids` however they rank by cost.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string} area
 * @param {string[] | null} actors
 * @param {string[]} ids
 * @returns {Promise<Map<string, number>>}
 */
async function costByPerson(d, scope, area, actors, ids) {
    const w = ledgerWhere({ orgId: scope.orgId, startDate: scope.period.startDate, endDate: scope.period.endDate, actors });
    const rows = await d.db.getAll(
        `SELECT actor, cost FROM (
            SELECT ${ACTOR_SQL} AS actor, COALESCE(SUM(estimated_cost), 0)::float8 AS cost,
                   ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(estimated_cost), 0) DESC) AS rn
              FROM ai_usage_log ${w.where} AND source = ANY($${w.nextIdx}::text[]) AND ${ACTOR_SQL} IS NOT NULL
             GROUP BY 1) c
          WHERE c.rn <= ${CANDIDATES} OR c.actor = ANY($${w.nextIdx + 1}::text[])`,
        [...w.params, sourcesOfArea(area), ids]);
    return new Map(rows.map((r) => [String(r.actor), num(r.cost)]));
}

/**
 * The people who use the kind most: uses from the evidence, cost from the
 * ledger rows of the kind's area they caused; at most TOP_PEOPLE. The busiest
 * by uses are picked first, so their cost is read exactly, not only when they
 * also rank among the costliest.
 * @param {AdoptionDeps} d
 * @param {KindDef} def
 * @param {Scope} scope
 * @param {string[] | null} actors
 * @returns {Promise<TopPerson[]>}
 */
async function topPeopleOf(d, def, scope, actors) {
    const uses = def.evidence && def.peopleKnown ? await usesByPerson(d, def, scope, actors) : new Map();
    const area = areaOfKind(def.kind);
    const cost = area ? await costByPerson(d, scope, area, actors, [...uses.keys()]) : new Map();
    return [...new Set([...uses.keys(), ...cost.keys()])]
        .map((person) => ({ person, uses: uses.get(person) || 0, cost: cost.get(person) || 0 }))
        .filter((p) => p.uses > 0 || p.cost > 0)
        .sort((a, b) => b.uses - a.uses || b.cost - a.cost)
        .slice(0, TOP_PEOPLE);
}

/**
 * Display names of the given owners (an owner is organisational metadata):
 * the name columns only, never the avatar.
 * @param {AdoptionDeps} d
 * @param {Array<string | null>} ownerIds
 * @returns {Promise<Map<string, string>>}
 */
async function ownerNames(d, ownerIds) {
    const ids = [...new Set(ownerIds.filter((id) => id != null))];
    if (ids.length === 0) return new Map();
    const users = await d.db.getAll('SELECT id, username, "displayName" FROM users WHERE id = ANY($1::text[])', [ids]);
    return new Map(users.map((u) => [String(u.id), String(u.displayName || u.username || u.id)]));
}

/**
 * @param {Record<string, unknown>} o
 * @param {{ evidence: Map<string, Record<string, unknown>> | null, cost: Map<string, number> | null }} facts
 * @param {KindDef} def
 * @returns {Item}
 */
function itemOf(o, facts, def) {
    const id = String(o.id);
    const ev = facts.evidence ? facts.evidence.get(id) : null;
    const ownerId = o.owner == null || def.personIsOwner ? null : String(o.owner);
    return {
        id,
        name: String(o.name ?? ''),
        ownerId,
        ownerName: null,
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
 * Published and unused in the period, among the objects the evidence can see
 * (a webpage's evidence is its public views: one published to the
 * organisation only can never show a use).
 * @param {Item[]} items
 * @param {KindDef} def
 * @returns {UnusedItem[]}
 */
function unusedOf(items, def) {
    const sees = def.evidenceSees || null;
    return items
        .filter((i) => i.published && !i.uses && (!sees || sees.includes(i.audience)))
        .slice(0, UNUSED_MAX)
        .map((i) => ({ id: i.id, name: i.name, ownerId: i.ownerId, ownerName: null, publishedAt: i.publishedAt || i.createdAt, lastUsedAt: i.lastUsedAt }));
}

/**
 * The drill-down of a kind. Null for a kind the report does not know.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {string} kind
 * @param {number} limit
 * @param {string[] | null} [actors]  the members of the scope's group, null for the organisation
 */
async function getStudioItems(d, scope, kind, limit, actors = null) {
    const def = kindDef(kind);
    if (!def) return null;
    const objects = await d.db.getAll(`${def.objects}`, [scope.orgId]);
    const listed = objects.filter((o) => String(o.audience || 'private') !== 'private');
    const ids = listed.map((o) => String(o.id));
    const [evidence, cost, topPeople] = await Promise.all([
        def.evidence ? evidenceByObject(d, def, scope, actors) : Promise.resolve(null),
        costByObject(d, def, scope, ids, actors),
        topPeopleOf(d, def, scope, actors),
    ]);
    const all = listed.map((o) => itemOf(o, { evidence, cost }, def)).sort(byUse);
    const items = all.slice(0, limit);
    const unused = evidence ? unusedOf(all, def) : [];
    const names = await ownerNames(d, [...items, ...unused].map((i) => i.ownerId));
    for (const i of [...items, ...unused]) i.ownerName = i.ownerId ? names.get(i.ownerId) || null : null;
    return {
        kind, items, topPeople,
        unused: unused.map((u) => ({ id: u.id, name: u.name, ownerName: u.ownerName, publishedAt: u.publishedAt, lastUsedAt: u.lastUsedAt })),
        total: objects.length,
    };
}

module.exports = { getStudioItems, TOP_PEOPLE, UNUSED_MAX };
