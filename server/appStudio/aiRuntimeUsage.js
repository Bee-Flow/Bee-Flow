// @typecheck strict
/**
 * App Studio — the usage-ledger side of the AI runtime (aiRuntime.js).
 *
 * Every model call an app makes runs as its OWNER, so the ledger row is
 * attributed to the owner (`user_id`), with the viewer who caused it and the
 * run it belongs to read from the attribution scope (usageAttribution.js).
 * The row also goes to the run log of the step (runLog/aiUsage.mts).
 * Billing bookkeeping never breaks a step: every failure here is swallowed.
 */

'use strict';

const usageStore = require('../stores/usageStore');
const { usageLogFields } = require('../core/providers/usageNormalizer');
const { usageAttributionFields } = require('./usageAttribution');
const { bestEffort } = require('../utils/bestEffort');

/** @typedef {{ id: string, userId: string, organizationId?: string | null, name?: string }} UsageApp */

/** @typedef {{ modelId: string, tierName?: string | null }} UsageModel */

/**
 * The ledger entry of one model call of an app.
 * @param {UsageApp} app
 * @param {string} modelId
 * @param {unknown} usage   raw or normalised provider usage (core/providers/usageNormalizer.js)
 * @param {number} t0
 * @param {string} source
 */
function usageEntry(app, modelId, usage, t0, source) {
    return {
        user_id: app.userId,
        organization_id: app.organizationId || null,
        agent_id: app.id,
        agent_name: `App: ${app.name || 'Untitled app'}`,
        agent_type: 'studio_app',
        model: modelId,
        // Tokens, cache read/write (with the 5m/1h split and cache_ttl), reasoning,
        // tier and tool counts: adapters return the normalised shape
        // (core/providers/usageNormalizer.js); a raw provider block is read too.
        ...usageLogFields(usage),
        duration_ms: Date.now() - t0,
        source,
        conversation_id: app.id,
        // The viewer whose click caused the call and the run it belongs to,
        // when the runner set them (usageAttribution.js); the owner pays.
        ...usageAttributionFields(),
    };
}

/**
 * Log one model call of an app to the ledger and to the run log of its step.
 * @param {UsageApp} app
 * @param {UsageModel} model
 * @param {unknown} usage
 * @param {number} t0
 * @param {string} source
 */
function logUsage(app, model, usage, t0, source) {
    // Never let billing bookkeeping break a step (matches studioAppsRun). The run log of the step gets the call too (runLog/aiUsage.mts).
    try { const entry = usageEntry(app, model.modelId, usage, t0, source); require('./runLog/aiUsage.mts').noteStepAiCall(model, entry); usageStore.logUsage(entry).catch((/** @type {unknown} */ e) => bestEffort('appStudio/aiRuntime:logUsage', e)); } catch (err) { bestEffort('appStudio/aiRuntime:logUsage#2', err); /* ignore */ }
}

module.exports = { usageEntry, logUsage };
