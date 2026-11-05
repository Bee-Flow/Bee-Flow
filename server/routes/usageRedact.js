// @typecheck strict
/**
 * What a caller may see of the AI figures: raw cost and token or call counts,
 * or the customer's marked-up cost alone.
 *
 * Moved out of routes/usage.js unchanged (isAdminCaller, getCustomerMarkup,
 * maybeRedact) so a second usage router, routes/usageAdoption.js, applies the
 * same rule rather than a copy of it. `costLens` is the form the Adoption
 * report needs: its answers are nested (areas, kinds, people), while
 * usageCustomerView.js redacts flat rows by an allow-list of column names, so
 * the report asks maybeRedact once what a cost of 1 becomes for this caller and
 * applies that to every figure it serves.
 */

'use strict';

const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const { isPlatformOperator } = require('../auth/platformOperator');

// Resolve the markup factor to apply when redacting customer-facing usage
// responses. Admin callers see raw figures; org / consumer callers see
// total_estimated_cost × (1 + markup_percent/100) and have token / message
// counts stripped from the payload.
// A failed lookup propagates (500): a 0% markup would show the customer the
// raw provider cost as if it were their bill.
/** @param {import('express').Request} req */
async function getCustomerMarkup(req) {
    const orgIds = await resolveUserOrgIds(req);
    const sub = orgIds === null || orgIds.size === 0
        ? (req.session?.user?.id ? await userStore.getConsumerSubscription(req.session.user.id) : null)
        : await userStore.getOrgSubscription(Array.from(orgIds)[0]);
    if (!sub?.plan_id) return 0;
    const plan = await userStore.getPlan(sub.plan_id);
    return Number(plan?.markup_percent) || 0;
}

/** @param {import('express').Request} req */
async function isAdminCaller(req) {
    // Privacy gate, not an operational permission: only the hardcoded
    // platform-operator account ("admin" credential from loginRoutes) sees
    // raw token/message counts and estimated_cost. Everyone else — org
    // admins, RBAC role-holders with `all`, every customer — gets the
    // redacted, marked-up cost-only view. Delegating this via the standard
    // hasPermission helper is a leak because `all` resolves any permission
    // query truthy, and org admins routinely receive `all` via their role.
    return isPlatformOperator(req.session?.user);
}

// The customer view of a row (allow-list, see usageCustomerView.js): usage*
// markup is the only AI figure customers see.
const { redactRow, redactRows } = require('./usageCustomerView');

// Apply customer redaction unless the caller is an admin. Use as the last
// step before res.json — returns the redacted payload (or the original).
/**
 * @param {import('express').Request} req
 * @param {unknown} payload
 * @param {string} kind
 */
async function maybeRedact(req, payload, kind) {
    // Self-hosted: no Stripe markup/reselling exists, so there's nothing to
    // redact — the operator sees raw tokens/cost. Redaction is purely a cloud
    // billing concern (serverLicenseGovernsOrgs() === self-hosted). The license
    // module is lazy-required (never at module top-level) to preserve boot
    // ordering — it pulls in heavy userStore DB init that must load after this
    // route module, not during it.
    const { serverLicenseGovernsOrgs } = require('../license');
    if (serverLicenseGovernsOrgs()) return payload;
    if (await isAdminCaller(req)) return payload;
    const markup = await getCustomerMarkup(req);
    const factor = 1 + markup / 100;
    if (kind === 'summary') return redactRow(payload, factor);
    if (kind === 'rows') return redactRows(/** @type {unknown[] | null | undefined} */ (payload), factor);
    return payload;
}

/**
 * @typedef {{
 *   raw: boolean,
 *   cost: (value: number | null | undefined) => number | null,
 *   calls: (value: number | null | undefined) => number | undefined,
 * }} CostLens
 */

/**
 * How this caller sees the figures, read off maybeRedact itself: a probe row
 * with a raw cost of 1 comes back either untouched (raw figures, calls shown)
 * or as the customer view, whose `billed_cost` is the markup factor. `calls`
 * answers undefined for a customer, which JSON leaves out of the answer.
 * @param {import('express').Request} req
 * @returns {Promise<CostLens>}
 */
async function costLens(req) {
    const probe = { estimated_cost: 1, calls: 1 };
    const seen = /** @type {Record<string, unknown> | null} */ (await maybeRedact(req, probe, 'summary'));
    const raw = seen === probe;
    const billed = Number(seen?.billed_cost);
    const factor = raw ? 1 : (Number.isFinite(billed) ? billed : 1);
    return {
        raw,
        cost: (value) => (value == null ? null : Math.round(Number(value) * factor * 1e6) / 1e6),
        calls: (value) => (raw ? Number(value) || 0 : undefined),
    };
}

module.exports = { getCustomerMarkup, isAdminCaller, maybeRedact, costLens };
