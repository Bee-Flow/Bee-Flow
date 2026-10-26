// @typecheck strict
// The outward edges of the user / organisation store to the billing services,
// behind ports. organizations.js and billingLifecycle.js only call these; the
// services (planEntitlements.js, trialService.js) install the real functions
// when they load. The store must not require the services itself: they require
// the user store back, and every module that did would join that import cycle
// (scripts/scc-ratchet.mjs). The seat-sync port sits next to this one
// (seatSyncPort.js), installed by services/stripeService.js.

const log = require('../../telemetry/log');

/** @typedef {{ mode?: 'intersect' | 'reset' }} PlanOpts */

/** @type {(orgId: string, planId: string, opts?: PlanOpts) => Promise<unknown>} */
let applyPlan = async () => { throw new Error('applyPlanToOrg is not installed: services/planEntitlements.js has not loaded'); };

let trialWarned = false;
/** @type {(orgId: string) => unknown} */
let autoGrantTrial = () => {
    if (!trialWarned) { trialWarned = true; log.warn('[billingPorts] trial auto-grant not installed: require boot/lateBoundPorts in this entry point'); }
    return undefined;
};

/** @param {typeof applyPlan} fn */
function setApplyPlanToOrg(fn) { applyPlan = fn; }

/** @param {typeof autoGrantTrial} fn */
function setMaybeAutoGrantOrgTrial(fn) { autoGrantTrial = fn; }

/**
 * Seed integrations + beta-feature enablement from a plan. Rejects when the
 * plan service is not loaded; callers already wrap this in try/catch.
 * @param {string} orgId
 * @param {string} planId
 * @param {PlanOpts} [opts]
 */
function applyPlanToOrg(orgId, planId, opts) { return applyPlan(orgId, planId, opts); }

/** Start the configured org trial, if any. Warns once and does nothing while no entry point installed the port. */
function maybeAutoGrantOrgTrial(/** @type {string} */ orgId) { return autoGrantTrial(orgId); }

module.exports = { setApplyPlanToOrg, setMaybeAutoGrantOrgTrial, applyPlanToOrg, maybeAutoGrantOrgTrial };
