/**
 * Migration: the enterprise split (2026-10) — keep what paying customers have.
 *
 * Six capabilities that every organisation could use until now became paid
 * Enterprise features: automation_privacy_steps, studio_documents,
 * webpage_sharing, datatable_retention, kb_datatable_sources and
 * kb_scheduled_refresh. Each is a GA beta whose id equals its licence feature,
 * listed only in tiers.js TIER_FEATURES.enterprise (the compliance_hub_gdpr
 * shape, core/entitlements/betaFeatures.js). On cloud the plan's
 * `allowed_beta_features` is the sole authority for a beta, and a stored org
 * access menu narrows it further, so without this migration two groups of
 * customers would silently lose features on deploy:
 *
 *   A. Plans. Every plan with a RESTRICTED (non-null) `allowed_beta_features`
 *      list that is PAID gets each new id it is missing. Paid means a price
 *      above zero OR metered billing: a pay-as-you-go plan has price 0 and is
 *      still a paying customer. `tier` is deliberately not consulted, because
 *      the paid "Bee Flow" plan can carry tier NULL (stores/user/schema.js only
 *      backfills a tier from the plan's name).
 *      The exception is `webpage_sharing`: it is appended to ANY plan, free
 *      ones included, whose list already contains `webpages`, and to no other.
 *      A plan that lists webpages today lets its orgs share them today; a paid
 *      plan without webpages never shared a page, so it gains nothing to keep.
 *      Plans whose list is NULL already include every beta and are untouched;
 *      free plans get none of the other five.
 *
 *   B. Org access menus. Every organisation with a stored (non-null)
 *      `org_available_capabilities` menu gets the five new ids it is missing,
 *      plus `webpage_sharing` when the menu already contains `webpages`. The
 *      new betas are userFacing and groupTogglable, so a stored menu would
 *      otherwise hide them (entitlements.js buildOrgAvailable). Appending is
 *      grant-free: the menu only NARROWS the plan or licence ceiling, so an
 *      org without the entitlement still does not get the feature, and a
 *      super-admin can untick it per org afterwards. Same menu rule applies on
 *      self-hosted, where the menu narrows the licence tier the same way.
 *
 * Deliberately NOT touched:
 *   - `default_consumer_beta_features` (the org-less consumer beta list): it is
 *     an operator-wide setting, and appending to it would grant these features
 *     to every free consumer account.
 *   - `organization_subscriptions.allowed_features` overrides: they replace the
 *     plan's CORE feature chips only. The beta ceiling on cloud reads the plan's
 *     `allowed_beta_features` alone (betaFeatures.getEffectiveOrgBetaAllowList),
 *     so an override can neither add nor remove these betas.
 *   - `org_granted_capabilities` / `org_enabled_beta_features`: betas are
 *     granted to every member straight from the ceiling (buildOrgGrant).
 *
 * ONE-SHOT PER ID, bounded by a config marker (`enterprise_split_grant_<id>`,
 * ON CONFLICT DO NOTHING), like org-granted-capabilities-2026-09. The
 * schema_migrations ledger already skips an unchanged file, but the ladder
 * re-runs everything under `--force`, when the ledger is unreachable, and
 * whenever this file changes. Without the marker a super-admin who later
 * removes one of these ids from a plan or a menu (the per-plan switch is the
 * point of the design) would find it re-appended by the next such run.
 *
 * Fails LOUD, never half-quiet: when a pass fails, up() throws after trying
 * both, no marker is written, the ledger does not record the entry, and the
 * next boot retries. The appends are idempotent, so the retry is safe. A table
 * or column that does not exist yet counts as "nothing to preserve": it can
 * only appear later as NULL, which already means unrestricted.
 *
 * Standalone: node migrations/enterprise-split-2026-10.js [--dry-run]
 * (--dry-run reports what would be appended and writes nothing, markers
 * included).
 */

const { getAll, getOne, run } = require('../db');

const NEW_IDS = [
    'automation_privacy_steps',
    'studio_documents',
    'webpage_sharing',
    'datatable_retention',
    'kb_datatable_sources',
    'kb_scheduled_refresh',
];
const SHARING_ID = 'webpage_sharing';
const SHARING_PARENT = 'webpages';
const MARKER_PREFIX = 'enterprise_split_grant_';

// Postgres: undefined_table, undefined_column.
const MISSING_SCHEMA = new Set(['42P01', '42703']);

function parseList(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch (_) { return null; } }
    return null;
}

/** A flat price above zero, or metered billing (pay-as-you-go has price 0). */
function isPaidPlan(plan) {
    const price = Number(plan && plan.price);
    if (Number.isFinite(price) && price > 0) return true;
    return String((plan && plan.billing_model) || '').toLowerCase() === 'metered';
}

/**
 * The ids from `pending` that `list` should gain. `paid` decides the five
 * ordinary ids; `webpage_sharing` follows `webpages` regardless of `paid`.
 */
function additionsFor(list, pending, { paid }) {
    const have = new Set(list);
    const add = [];
    for (const id of pending) {
        if (have.has(id)) continue;
        if (id === SHARING_ID) {
            if (have.has(SHARING_PARENT)) add.push(id);
            continue;
        }
        if (paid) add.push(id);
    }
    return add;
}

async function pendingIds() {
    const pending = [];
    for (const id of NEW_IDS) {
        if (!(await getOne(`SELECT key FROM config WHERE key = $1`, [`${MARKER_PREFIX}${id}`]))) pending.push(id);
    }
    return pending;
}

/** Runs one pass; a missing table/column means there is nothing to keep. */
async function guardedPass(label, fn, errors) {
    try {
        return await fn();
    } catch (e) {
        if (e && MISSING_SCHEMA.has(e.code)) {
            console.log(`[enterprise-split] ${label}: ${e.message} — nothing stored yet, nothing to keep`);
            return 0;
        }
        errors.push(`${label}: ${e && e.message}`);
        return 0;
    }
}

async function up({ dryRun = false } = {}) {
    const pending = await pendingIds();
    if (pending.length === 0) return { ids: [], plans: 0, orgs: 0 };

    const errors = [];
    const tag = dryRun ? 'DRY-RUN ' : '';

    // ── A. Restricted plan beta lists ──────────────────────────────────────
    // SELECT * so a plan table that predates billing_model still reads (the
    // column is then simply absent, and only the price decides).
    const plans = await guardedPass('plans', async () => {
        let touched = 0;
        const rows = await getAll(`SELECT * FROM subscription_plans WHERE allowed_beta_features IS NOT NULL`);
        for (const p of (rows || [])) {
            const list = parseList(p.allowed_beta_features);
            if (!Array.isArray(list)) continue;
            const add = additionsFor(list, pending, { paid: isPaidPlan(p) });
            if (add.length === 0) continue;
            if (!dryRun) {
                await run(`UPDATE subscription_plans SET allowed_beta_features = $1 WHERE id = $2`,
                    [JSON.stringify([...list, ...add]), p.id]);
            }
            console.log(`[enterprise-split] ${tag}plan ${p.id}: appended ${add.join(', ')} to allowed_beta_features`);
            touched++;
        }
        return touched;
    }, errors);

    // ── B. Stored org access menus ─────────────────────────────────────────
    const orgs = await guardedPass('org access menus', async () => {
        let touched = 0;
        const rows = await getAll(`SELECT id, "org_available_capabilities" FROM organizations
                                    WHERE "org_available_capabilities" IS NOT NULL`);
        for (const o of (rows || [])) {
            const list = parseList(o.org_available_capabilities);
            if (!Array.isArray(list)) continue;
            // The menu only narrows a ceiling, so every org counts as "paid"
            // here; webpage_sharing still follows webpages.
            const add = additionsFor(list, pending, { paid: true });
            if (add.length === 0) continue;
            if (!dryRun) {
                await run(`UPDATE organizations SET "org_available_capabilities" = $1 WHERE id = $2`,
                    [JSON.stringify([...list, ...add]), o.id]);
            }
            console.log(`[enterprise-split] ${tag}org ${o.id}: appended ${add.join(', ')} to org_available_capabilities`);
            touched++;
        }
        return touched;
    }, errors);

    if (errors.length > 0) {
        // No marker: the ledger does not record a throwing entry, so the next
        // boot retries, and the idempotent appends make that retry safe.
        throw new Error(`[enterprise-split] incomplete, will retry: ${errors.join('; ')}`);
    }

    if (dryRun) {
        console.log(`[enterprise-split] DRY-RUN: markers for ${pending.join(', ')} NOT written`);
    } else {
        for (const id of pending) {
            // DO NOTHING keeps racing replicas convergent; from here on the
            // absence of an id is an admin's choice, not a gap.
            await run(`INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO NOTHING`,
                [`${MARKER_PREFIX}${id}`, JSON.stringify({ done: true, at: new Date().toISOString(), migration: 'enterprise-split-2026-10' })]);
        }
    }
    return { ids: pending, plans, orgs };
}

module.exports = { up, NEW_IDS, MARKER_PREFIX, isPaidPlan, additionsFor };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then((res) => {
        console.log(`[enterprise-split] ${dryRun ? 'DRY-RUN ' : ''}done:`, JSON.stringify(res));
        process.exit(0);
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
