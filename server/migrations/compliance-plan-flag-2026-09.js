/**
 * Migration: Compliance Hub becomes a subscription-togglable feature flag.
 *
 * `compliance_hub_gdpr` moved from an implicit tier-only CORE capability to a
 * GA compound feature flag (core/entitlements/betaFeatures.js). On cloud the
 * plan's `allowed_beta_features` is now the sole authority for it — which
 * means a pro/enterprise-tier plan with a RESTRICTED (non-null) beta list
 * would silently lose the hub on deploy, because the id was never in any
 * existing list. Two grandfathering passes keep the pre-change reality:
 *
 *   A. Plans: append 'compliance_hub_gdpr' to every non-null
 *      `allowed_beta_features` list on plans whose tier is pro/enterprise —
 *      exactly the plans whose orgs had the hub via tier before. Free/NULL-tier
 *      plans are left alone (their orgs never had it). Unrestricted (NULL)
 *      lists already include every flag, so they need nothing.
 *
 *   B. Orgs: append 'compliance_hub_gdpr' to every non-null
 *      `org_available_capabilities` access menu. The flag is now
 *      userFacing/groupTogglable, so a stored menu would start hiding it.
 *      Appending is grant-free — the menu only NARROWS the plan/licence
 *      ceiling, so orgs without the entitlement still don't get the hub, and
 *      a super-admin can now untick it per org (that per-org disable is the
 *      point of the change).
 *
 * Idempotent: both passes append only when the id is missing, so a second run
 * matches nothing. Safe to run repeatedly.
 */

const { getAll, run } = require('../db');

const FLAG = 'compliance_hub_gdpr';

function parseList(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch (_) { return null; } }
    return null;
}

async function up() {
    // ── A. Pro/enterprise plans with a restricted beta list ────────────────
    try {
        const plans = await getAll(`SELECT id, allowed_beta_features FROM subscription_plans
                                     WHERE allowed_beta_features IS NOT NULL
                                       AND tier IN ('pro', 'enterprise')`);
        for (const p of (plans || [])) {
            const list = parseList(p.allowed_beta_features);
            if (!Array.isArray(list) || list.includes(FLAG)) continue;
            await run(`UPDATE subscription_plans SET allowed_beta_features = $1 WHERE id = $2`,
                [JSON.stringify([...list, FLAG]), p.id]);
            console.log(`[compliance-plan-flag] plan ${p.id}: grandfathered ${FLAG} into allowed_beta_features`);
        }
    } catch (e) {
        console.warn('[compliance-plan-flag] plan grandfather skipped:', e.message);
    }

    // ── B. Orgs with a stored "Organisation access" menu ───────────────────
    try {
        const orgs = await getAll(`SELECT id, "org_available_capabilities" FROM organizations
                                    WHERE "org_available_capabilities" IS NOT NULL`);
        for (const o of (orgs || [])) {
            const list = parseList(o.org_available_capabilities);
            if (!Array.isArray(list) || list.includes(FLAG)) continue;
            await run(`UPDATE organizations SET "org_available_capabilities" = $1 WHERE id = $2`,
                [JSON.stringify([...list, FLAG]), o.id]);
            console.log(`[compliance-plan-flag] org ${o.id}: grandfathered ${FLAG} into org_available_capabilities`);
        }
    } catch (e) {
        console.warn('[compliance-plan-flag] org access-menu grandfather skipped:', e.message);
    }
}

module.exports = { up };
