/**
 * Resolve which licence tier a subscription plan grants.
 *
 * This used to be a substring match on the plan's *display name*
 * (`name.includes('enterprise')`, `name.includes('pro')`, …), which had two bad
 * properties. Renaming a plan in the admin console — "Pro" to "Business", say —
 * silently returned null, and a null tier means no licence is issued at all:
 * the Stripe webhook writes an audit row and moves on, so a paying customer
 * lands on Community until someone notices and runs the manual reissue endpoint.
 * And a plan called "Approved" matched 'pro' by accident.
 *
 * The `subscription_plans` table has had a `tier` column all along. That column
 * is now the source of truth; the name match survives only as a logged fallback
 * for rows predating it, and validateAllPlanTiers turns a mis-tiered catalogue
 * into a loud startup error (and a CI failure) rather than a silent downgrade.
 */

const { TIER_HIERARCHY, LEGACY_TIER_ALIAS } = require('./tiers');
const logger = require('../telemetry/log');

/**
 * Canonicalise a tier string. Returns null for anything not in the hierarchy,
 * so a typo can never be mistaken for a real tier.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizeTier(raw) {
    if (!raw) return null;
    const t = String(raw).trim().toLowerCase();
    const aliased = LEGACY_TIER_ALIAS[t] || t;
    return TIER_HIERARCHY.includes(aliased) ? aliased : null;
}

/**
 * Legacy fallback: guess the tier from the plan name. Only reached when a plan
 * row has no usable `tier` value.
 * @returns {string|null}
 */
function tierFromPlanName(planName) {
    if (!planName) return null;
    const n = String(planName).toLowerCase();
    if (n.includes('enterprise')) return 'enterprise';
    if (n.includes('pro')) return normalizeTier('pro');
    if (n.includes('community') || n === '__consumer_default__') return 'community';
    return null;
}

/**
 * The tier a plan grants: its `tier` column, else a logged name guess.
 *
 * @param {object} plan  a subscription_plans row (or a join exposing plan_tier / plan_name)
 * @returns {string|null} null means "no licence to issue" (a Free plan)
 */
function resolveTierForPlan(plan) {
    if (!plan) return null;
    const fromColumn = normalizeTier(plan.tier ?? plan.plan_tier);
    if (fromColumn) return fromColumn;

    const name = plan.name ?? plan.plan_name;
    const guessed = tierFromPlanName(name);
    if (guessed) {
        logger.warn(`[License] plan '${name}' (${plan.id || plan.plan_id || 'unknown id'}) has no valid tier column — `
            + `falling back to a name match → '${guessed}'. Set the tier explicitly; `
            + 'renaming this plan would otherwise stop licence issuance. [stripe.tier.fallback_by_name]');
    }
    return guessed;
}

/**
 * Check a whole plan catalogue. A paid plan that resolves to no tier is the
 * failure this module exists to prevent: the customer pays and gets nothing.
 *
 * @param {Array<object>} plans
 * @returns {{ok: boolean, offenders: Array<{id, name, tier, reason}>}}
 */
function validateAllPlanTiers(plans) {
    const offenders = [];
    for (const plan of plans || []) {
        const declared = plan.tier ?? plan.plan_tier;
        const resolved = resolveTierForPlan(plan);
        const isPaid = Number(plan.price ?? plan.amount ?? 0) > 0;

        if (declared && !normalizeTier(declared)) {
            offenders.push({ id: plan.id, name: plan.name, tier: declared, reason: 'unknown_tier_value' });
        } else if (isPaid && !resolved) {
            offenders.push({ id: plan.id, name: plan.name, tier: declared ?? null, reason: 'paid_plan_grants_no_tier' });
        } else if (!declared && resolved) {
            offenders.push({ id: plan.id, name: plan.name, tier: null, reason: 'tier_only_from_name_match' });
        }
    }
    return { ok: offenders.length === 0, offenders };
}

/**
 * Log the catalogue's tier problems at boot. Non-fatal on purpose — refusing to
 * start would take the whole product down over a billing-catalogue typo — but
 * loud, and the colocated test is the CI gate.
 */
function reportPlanTierProblems(plans, log = console) {
    const { ok, offenders } = validateAllPlanTiers(plans);
    if (ok) return true;
    for (const o of offenders) {
        log.error(`[License] subscription plan '${o.name}' (${o.id}) — ${o.reason}`
            + (o.reason === 'paid_plan_grants_no_tier'
                ? ' — customers on this plan will be issued NO licence. Set its tier in Admin → Subscriptions → Plans.'
                : ''));
    }
    return false;
}

module.exports = {
    normalizeTier,
    tierFromPlanName,
    resolveTierForPlan,
    validateAllPlanTiers,
    reportPlanTierProblems,
};
