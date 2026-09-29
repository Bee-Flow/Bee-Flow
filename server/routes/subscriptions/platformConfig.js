/**
 * Install-wide (not org-scoped) subscription admin — the master lists the Plan
 * editor renders, the default trial plans, the unresolved license-issuance
 * failures behind the sidebar badge, and the USD→currency rates.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const { getAdminId } = require('./shared');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// The trial-config body is `.strict()` because the save is a PUT of two
// OPTIONAL slots: setTrialConfig only writes a key it is actually given, and
// the plan checks below only look at the keys they name. A misspelled
// `default_org_trial_plan` therefore passed every check, wrote nothing, and
// came back 200 with the unchanged config — "Trial offers saved." on screen
// over a slot that had not moved.
//
// The currency-rates body is the opposite case and stays deliberately open:
// its keys ARE the data (one per ISO currency code), so it is a record with a
// validated key shape rather than a fixed field list.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A plan slot: a plan id, or empty/null to clear it. */
const PLAN_SLOT_TEXT = 'A trial plan is the id of a plan, or empty to offer none.';
const planSlot = worded(PLAN_SLOT_TEXT).trim().nullish();

const TrialConfigBody = z.object({
    default_org_trial_plan_id: planSlot,
    default_consumer_trial_plan_id: planSlot,
}).strict();

const CODE_TEXT = 'A currency code is three letters, like EUR.';
const RATES_TEXT = 'Send the rates as { eur: 0.92, gbp: 0.78 }.';
const CurrencyRatesBody = z.record(
    worded(CODE_TEXT).regex(/^[a-z]{3}$/i, CODE_TEXT),
    z.coerce.number({ invalid_type_error: 'A rate is a number of <currency> per USD.' })
        .positive('A rate is greater than zero.'),
    { required_error: RATES_TEXT, invalid_type_error: RATES_TEXT },
);

const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`)
    .min(1, `${name} is at least 1.`)
    .optional();

// `limit` stays CLAMPED rather than refused — see the same note in audit.js.
const FailuresQuery = z.object({ limit: whole('limit') }).strict();

// GET /api/subscriptions/registries — master lists used by the Plan editor
// (beta features registry; integration catalog is a frontend constant).
router.get('/registries', async (req, res) => {
    const { BETA_FEATURES } = require('../../core/entitlements/betaFeatures');

    // Installed MCP servers — surfaced to the Plan editor as INTEGRATION
    // options. IDs are `mcp:<id>` and the editor saves selected ones into the
    // plan's `allowed_integrations` (MCP servers are integrations now; opt-in
    // per subscription — never part of an unrestricted/null cap).
    let mcp_servers = [];
    try {
        const servers = await require('../../stores/mcpStore').listServers();
        mcp_servers = (servers || []).map(s => ({
            id: `mcp:${s.id}`,
            name: s.name || s.id,
            description: s.description || '',
            category: 'MCP servers',
            enabled: s.enabled !== false,
        }));
    } catch (e) {
        log.warn('[Subscriptions] registries: mcp list unavailable:', e.message);
    }

    // Module layer: a beta owned by an un-imported platform module must not
    // be addable to plans — hide it from the picker (fail-open to the full
    // registry; grandfathered modules fail open by design).
    let inactiveModuleCaps = new Set();
    try { inactiveModuleCaps = await require('../../modules').listInactiveCapabilityIds(); } catch (_) {}

    res.json({
        beta_features: (BETA_FEATURES || []).filter(f => !f.deprecated && !inactiveModuleCaps.has(f.id)).map(f => ({
            id: f.id, name: f.name, description: f.description, license_feature: f.licenseFeature || null,
        })),
        mcp_servers,
    });
});

// GET /api/subscriptions/trial-config — read which plans are offered as trial
router.get('/trial-config', async (req, res) => {
    const trialService = require('../../services/trialService');
    res.json(await trialService.getTrialConfig());
});

// PUT /api/subscriptions/trial-config — pick the default trial plans (org + consumer)
router.put('/trial-config', validate({ body: TrialConfigBody }), async (req, res) => {
    try {
        const trialService = require('../../services/trialService');
        const payload = req.body;

        // Validate referenced plans exist, are trial-ready, and are the right type
        for (const [field, expectedType] of [
            ['default_org_trial_plan_id', 'organization'],
            ['default_consumer_trial_plan_id', 'consumer'],
        ]) {
            const id = payload[field];
            if (!id) continue; // empty string / null clears the slot
            const plan = await userStore.getPlan(id);
            if (!plan) return res.status(400).json({ error: `${field}: plan not found` });
            if (!plan.trial_days || plan.trial_days <= 0) {
                return res.status(400).json({ error: `${field}: plan must have trial_days > 0` });
            }
            if (!plan.stripe_price_id) {
                return res.status(400).json({ error: `${field}: plan must be synced to Stripe first` });
            }
            const planType = plan.plan_type || 'organization';
            if (planType !== expectedType) {
                return res.status(400).json({ error: `${field}: plan_type must be "${expectedType}", got "${planType}"` });
            }
        }

        const oldCfg = await trialService.getTrialConfig();
        const newCfg = await trialService.setTrialConfig(payload);
        await userStore.logSubscriptionAudit('update_trial_config', 'trial_config', 'global', getAdminId(req), oldCfg, newCfg);
        res.json(newCfg);
    } catch (e) {
        log.error('[Subscriptions] setTrialConfig error:', e);
        res.status(400).json({ error: e.message });
    }
});

// GET /api/subscriptions/license-issuance-failures — unresolved-only.
// A "failure" is a `license_issuance_failed` audit row that does NOT have a
// later `license_issuance_succeeded` row for the same target_id. Used by the
// admin sidebar badge and the audit-view Retry UI. Returns the most recent
// 50 failures with target metadata so the UI can render the list inline.
router.get('/license-issuance-failures', validate({ query: FailuresQuery }), async (req, res) => {
    const limit = Math.min(200, req.query.limit ?? 50);
    const rows = await userStore.getUnresolvedLicenseIssuanceFailures(limit);
    res.json(rows);
});

// GET /api/subscriptions/currency-rates — admin-configurable USD→X rates
// applied at usage-log time to convert LiteLLM USD costs into the plan's
// billing currency. Missing rates fall back to 1.0 (no conversion).
router.get('/currency-rates', async (req, res) => {
    const currency = require('../../core/text/currency');
    res.json(await currency.getAllConfiguredRates());
});

// PUT /api/subscriptions/currency-rates — body: { eur: 0.92, gbp: 0.78, ... }
// Each value is a USD → <currency> multiplier. Persists via configStore
// and audits the diff. Also clears the PAYG resolver cache so the next AI
// call sees the new rate immediately rather than after the 60s TTL.
router.put('/currency-rates', validate({ body: CurrencyRatesBody }), async (req, res) => {
    try {
        const currency = require('../../core/text/currency');
        const before = await currency.getAllConfiguredRates();
        for (const [code, rate] of Object.entries(req.body)) {
            await currency.setUsdToCurrencyRate(code, rate);
        }
        // Drop any PAYG-cache entries so freshly converted rates take effect now.
        try { require('../../stores/usageStore').invalidatePaygCache(null, null); } catch (_) { /* circular-load safe */ }
        const after = await currency.getAllConfiguredRates();
        await userStore.logSubscriptionAudit('update_currency_rates', 'currency_rates', 'global', getAdminId(req), before, after);
        res.json(after);
    } catch (e) {
        log.error('[Subscriptions] setCurrencyRates error:', e);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
