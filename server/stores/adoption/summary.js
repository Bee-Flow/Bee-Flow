// @typecheck strict
/**
 * The hero numbers of the Adoption report: members and their status, makers,
 * spend, the adoption rate, seats, and the same figures for the period of the
 * same length immediately before.
 */

'use strict';

const log = require('../../telemetry/log');
const { memberActivity, ledgerByActor } = require('./people');
const {
    ACTOR_SQL, ledgerWhere, memberStatus, joinedInPeriod, previousPeriod, num, percent,
} = require('./shared');

/**
 * @typedef {import('./shared').Scope} Scope
 * @typedef {import('./shared').AdoptionDeps} AdoptionDeps
 * @typedef {import('./shared').Period} Period
 */

/**
 * Calls, cost and people of the ledger in a period.
 * @param {AdoptionDeps} d
 * @param {string} orgId
 * @param {Period} period
 * @param {string[] | null} actors
 */
async function spendOf(d, orgId, period, actors) {
    const w = ledgerWhere({ orgId, startDate: period.startDate, endDate: period.endDate, actors });
    const row = await d.db.getOne(
        `SELECT COUNT(*)::int AS calls, COALESCE(SUM(estimated_cost), 0)::float8 AS cost,
                COUNT(DISTINCT ${ACTOR_SQL})::int AS people
           FROM ai_usage_log ${w.where}`,
        w.params,
    );
    return { calls: num(row?.calls), cost: num(row?.cost), people: num(row?.people) };
}

/**
 * Seats in use and the licence's cap (null when unlimited or unknown).
 * @param {AdoptionDeps} d
 * @param {string} orgId
 */
async function seatsOf(d, orgId) {
    const [used, max] = await Promise.all([
        d.userStore.getActiveSeatCount(orgId),
        d.seats.getMaxSeatsForOrg(orgId),
    ]);
    return { used: num(used), max: max == null ? null : num(max) };
}

/**
 * Counts of members per status.
 * @param {Awaited<ReturnType<typeof memberActivity>>} act
 * @param {Scope} scope
 */
function statusCounts(act, scope) {
    const counts = { aiActive: 0, seenOnly: 0, dormant: 0, never: 0, newInPeriod: 0 };
    for (const { member } of act.members) {
        const status = memberStatus(member, act.byActor.has(String(member.id)), scope.period, scope.now);
        if (status === 'ai_active') counts.aiActive++;
        else if (status === 'seen_only') counts.seenOnly++;
        else if (status === 'dormant') counts.dormant++;
        else if (status === 'never') counts.never++;
        if (joinedInPeriod(member, scope.period)) counts.newInPeriod++;
    }
    return counts;
}

/**
 * Makers among the members, and those whose first object falls in the period.
 * @param {Awaited<ReturnType<typeof memberActivity>>} act
 * @param {Period} period
 */
function makersOf(act, period) {
    const start = Date.parse(period.startDate);
    const end = Date.parse(period.endDate);
    let total = 0;
    let newInPeriod = 0;
    for (const { member } of act.members) {
        const owned = act.owners.get(String(member.id));
        if (!owned) continue;
        total++;
        if (owned.first != null && owned.first >= start && owned.first <= end) newInPeriod++;
    }
    return { total, newInPeriod };
}

/**
 * The previous period: AI-active members, adoption rate (over today's member
 * count, the only membership the report knows), cost and calls. Null when it
 * cannot be read.
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 * @param {Awaited<ReturnType<typeof memberActivity>>} act
 */
async function previousOf(d, scope, act) {
    try {
        const prev = previousPeriod(scope.period);
        const [byActor, spend] = await Promise.all([
            ledgerByActor(d, scope.orgId, prev, act.actors),
            spendOf(d, scope.orgId, prev, act.actors),
        ]);
        const aiActive = act.members.filter((m) => byActor.has(String(m.member.id))).length;
        return { aiActive, adoptionRate: percent(aiActive, act.members.length), cost: spend.cost, calls: spend.calls };
    } catch (err) {
        log.warn('[Adoption] previous period failed:', /** @type {Error} */ (err)?.message || err);
        return null;
    }
}

/**
 * @param {AdoptionDeps} d
 * @param {Scope} scope
 */
async function getSummary(d, scope) {
    const act = await memberActivity(d, scope);
    let partial = act.partial;
    const [spend, seats, prev] = await Promise.all([
        spendOf(d, scope.orgId, scope.period, act.actors),
        seatsOf(d, scope.orgId).catch((err) => {
            partial = true;
            log.warn('[Adoption] seats failed:', /** @type {Error} */ (err)?.message || err);
            return { used: 0, max: null };
        }),
        previousOf(d, scope, act),
    ]);
    if (!prev) partial = true;
    const counts = statusCounts(act, scope);
    const total = act.members.length;
    const relative = scope.period.relative;
    return {
        range: { startDate: scope.period.startDate, endDate: scope.period.endDate, days: scope.period.days, relative },
        members: {
            total,
            aiActive: counts.aiActive,
            seenOnly: relative ? counts.seenOnly : null,
            dormant: relative ? counts.dormant : null,
            never: relative ? counts.never : null,
            newInPeriod: counts.newInPeriod,
            seats,
        },
        makers: makersOf(act, scope.period),
        spend: { ...spend, perActiveMember: counts.aiActive > 0 ? spend.cost / counts.aiActive : 0 },
        adoptionRate: percent(counts.aiActive, total),
        prev,
        partial,
    };
}

module.exports = { getSummary, spendOf };
