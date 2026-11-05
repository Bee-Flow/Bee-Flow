// @typecheck strict
/**
 * The Adoption read model (Settings → Organisation → Usage & Monitoring →
 * Adoption): how an organisation uses Bee Flow, from what exists today.
 *
 *   summary      members and their status, makers, spend, seats, the period before
 *   areas        where the AI goes (shared/usageAreas.js) and the same per ISO week
 *   studio       the organisation's Studio inventory per kind, with usage evidence
 *   studioItems  the objects of one kind: owner, audience, uses, people, cost
 *   groups       adoption per group, small groups folded
 *   people       adoption per member (user ids; the route pseudonymises them)
 *
 * Every read is scoped to the organisation id the caller passes, which the
 * route takes from the session; nothing here reads a request. The parts live
 * in stores/adoption/; this barrel binds them to their dependencies, which a
 * test may replace (`createAdoptionStore({ db })`).
 */

'use strict';

const { defaultDeps } = require('./adoption/shared');
const { getSummary } = require('./adoption/summary');
const { getAreaBreakdown, getAreaTimeline } = require('./adoption/areas');
const { getStudioOverview } = require('./adoption/studio');
const { getStudioItems } = require('./adoption/studioItems');
const { getGroups } = require('./adoption/groups');
const { getPeople, memberActivity } = require('./adoption/people');
const { KIND_KEYS } = require('./adoption/kinds');
const { resolveMembers, actorsFor, periodOf } = require('./adoption/shared');
const { recordReveal, REVEAL_ACTION } = require('./adoption/audit');

/**
 * @typedef {import('./adoption/shared').Scope} Scope
 * @typedef {import('./adoption/shared').AdoptionDeps} AdoptionDeps
 */

/**
 * @param {Partial<AdoptionDeps>} [overrides]
 */
function createAdoptionStore(overrides = {}) {
    const base = defaultDeps();
    /** @type {AdoptionDeps} */
    const d = Object.create(base);
    for (const [k, v] of Object.entries(overrides)) Object.defineProperty(d, k, { value: v, enumerable: true });
    /**
     * The ledger and evidence actors of a scope: null for the organisation,
     * the members of its group with one (nobody for another organisation's group).
     * @param {Scope} scope
     */
    const actorsOf = async (scope) => {
        if (!scope.groupId) return null;
        const { members } = await resolveMembers(d, scope.orgId, scope.groupId);
        return actorsFor(scope, members);
    };
    return {
        /** @param {Scope} scope */
        summary: (scope) => getSummary(d, scope),
        /** @param {Scope} scope */
        areas: async (scope) => {
            const actors = await actorsOf(scope);
            const [areas, weeks] = await Promise.all([getAreaBreakdown(d, scope, actors), getAreaTimeline(d, scope, actors)]);
            return { areas, timeline: { weeks }, partial: false };
        },
        /** @param {Scope} scope */
        studio: async (scope) => getStudioOverview(d, scope, await actorsOf(scope)),
        /**
         * @param {Scope} scope
         * @param {string} kind
         * @param {number} limit
         */
        studioItems: async (scope, kind, limit) => getStudioItems(d, scope, kind, limit, await actorsOf(scope)),
        /** @param {Scope} scope */
        groups: (scope) => getGroups(d, scope),
        /**
         * @param {Scope} scope
         * @param {{ limit: number, cursor: number }} page
         */
        people: (scope, page) => getPeople(d, scope, page),
        /** @param {Scope} scope */
        memberActivity: (scope) => memberActivity(d, scope),
        /**
         * Write the access-audit row of a name reveal; throws when it was not written.
         * @param {{ orgId: string, actorId: string, details: import('./adoption/audit').RevealDetails }} reveal
         */
        recordReveal: (reveal) => recordReveal(d.db, reveal),
    };
}

/** @typedef {ReturnType<typeof createAdoptionStore>} AdoptionStore */

const store = createAdoptionStore();

module.exports = { ...store, createAdoptionStore, KIND_KEYS, periodOf, REVEAL_ACTION };
