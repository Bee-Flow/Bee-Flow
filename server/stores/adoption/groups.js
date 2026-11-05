// @typecheck strict
/**
 * Adoption per group of the organisation: members, AI-active members,
 * adoption rate, makers, cost and the area the group spends most on.
 *
 * Membership is the CURRENT one (users.groups holds no history), so a past
 * period is attributed to the groups people are in today; the report says so.
 * A group with fewer than FOLD_BELOW members is folded into one "other groups"
 * row, so a figure never describes two or three identifiable people
 * (k = chatMonitoringVocab's cell size).
 */

'use strict';

const { memberActivity } = require('./people');
const { percent } = require('./shared');

/**
 * @typedef {import('./shared').Scope} Scope
 * @typedef {import('./shared').AdoptionDeps} AdoptionDeps
 * @typedef {import('./shared').GroupRow} GroupRow
 * @typedef {{ members: number, aiActive: number, adoptionRate: number, makers: number, cost: number, topArea: string | null }} GroupFigures
 */

/** Groups smaller than this are folded together. */
const FOLD_BELOW = 5;

/**
 * Where a group came from.
 * @param {GroupRow} g
 * @returns {'entra' | 'nextcloud' | 'local'}
 */
function sourceOf(g) {
    const source = String(g.source || '').toLowerCase();
    if (g.azureGroupId || source === 'azure' || source === 'entra') return 'entra';
    if (source === 'nextcloud') return 'nextcloud';
    return 'local';
}

/**
 * The figures of a set of members.
 * @param {string[]} ids
 * @param {Awaited<ReturnType<typeof memberActivity>>} act
 * @returns {GroupFigures}
 */
function figuresOf(ids, act) {
    let aiActive = 0;
    let makers = 0;
    let cost = 0;
    /** @type {Map<string, number>} */
    const areaCost = new Map();
    for (const id of ids) {
        const use = act.byActor.get(id);
        if (act.owners.has(id)) makers++;
        if (!use) continue;
        aiActive++;
        cost += use.cost;
        for (const [area, c] of use.areas) areaCost.set(area, (areaCost.get(area) || 0) + c);
    }
    const top = [...areaCost.entries()].sort((a, b) => b[1] - a[1])[0];
    return { members: ids.length, aiActive, adoptionRate: percent(aiActive, ids.length), makers, cost, topArea: top ? top[0] : null };
}

/**
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 */
async function getGroups(d, scope) {
    const act = await memberActivity(d, scope);
    /** @type {Map<string, string[]>} */
    const membersOf = new Map(act.groups.map((g) => [String(g.id), []]));
    for (const { member, groupIds } of act.members) {
        for (const gid of groupIds) membersOf.get(gid)?.push(String(member.id));
    }
    const groups = [];
    /** @type {Set<string>} */
    const folded = new Set();
    let foldedCount = 0;
    for (const g of act.groups) {
        const ids = membersOf.get(String(g.id)) || [];
        if (ids.length < FOLD_BELOW) {
            foldedCount++;
            for (const id of ids) folded.add(id);
            continue;
        }
        groups.push({ id: String(g.id), name: String(g.name || g.id), source: sourceOf(g), ...figuresOf(ids, act) });
    }
    groups.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
    return {
        groups,
        folded: foldedCount > 0 ? { count: foldedCount, ...figuresOf([...folded], act) } : null,
        partial: act.partial,
    };
}

module.exports = { getGroups, FOLD_BELOW, sourceOf };
