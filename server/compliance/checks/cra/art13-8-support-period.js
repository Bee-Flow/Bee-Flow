/**
 * CRA Art. 13(8) / Annex II(7) — support period and end-of-support date
 * declared.
 *
 * A manufacturer must decide, and tell users, for how long security updates
 * will be provided (at least five years unless the product's expected
 * lifetime is shorter) and publish the end-of-support date. The PLD leans on
 * the same declaration: Art. 11(2)(c) keeps a manufacturer liable for
 * defects introduced by updates it still controls, so the support window is
 * also the liability window.
 *
 * ATTESTATION check: the fact lives in a published policy and a business
 * decision, not in the platform. The admin records under Compliance →
 * Settings:
 *   • support_policy_url       — where users can read the support policy,
 *   • support_end_date         — the published end-of-support date,
 *   • security_update_channel  — how updates reach users (release notes,
 *                                registry tag, mailing list …; optional).
 *
 * Verdicts: cra_role ≠ manufacturer → not_applicable (with a hint when the
 * org visibly places products on the market); missing URL or date → fail;
 * end-of-support in the past or within 12 months → warn (renew or announce
 * the successor); otherwise pass.
 *
 * Evidence carries the URL (the org's public policy page), the date and the
 * days remaining. The update channel may be a mailing-list address, so only
 * a boolean is recorded for it (BFSF-441).
 * Also counts for PLD Art. 11(2)(c).
 */

const db = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const RENEWAL_HORIZON_DAYS = 365;
const DAY_MS = 86400e3;

function _httpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let u;
    try { u = new URL(value.trim()); } catch { return null; }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

/** `support_end_date` may arrive as a DATE (Date object) or an ISO/`YYYY-MM-DD` string. */
function _dateOnly(value) {
    if (!value) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

function _daysUntil(dateOnly, now) {
    if (!dateOnly) return null;
    const end = Date.parse(`${dateOnly}T23:59:59.999Z`);
    return Math.floor((end - now) / DAY_MS);
}

function _isNotProvisioned(e) {
    return e && (e.code === '42703' || e.code === '42P01');
}

/**
 * Does this org visibly place products with digital elements on the market?
 * Cheap counts over the three product surfaces; each guarded on its own so a
 * missing table only blanks that number. Used ONLY for the not_applicable
 * hint — the verdict never depends on it.
 */
async function _productsHint(orgId) {
    const hint = { solution_releases: null, public_app_pages: null, published_webpages: null };
    try {
        const r = await db.getOne(`
            SELECT COUNT(*)::int AS c
            FROM project_releases r JOIN projects p ON p.id = r.project_id
            WHERE p.organization_id = $1
        `, [orgId]);
        hint.solution_releases = r?.c ?? 0;
    } catch (e) { if (!_isNotProvisioned(e)) throw e; }
    try {
        const r = await db.getOne(`
            SELECT COUNT(*)::int AS c
            FROM studio_app_public_pages pp JOIN studio_apps a ON a.id = pp.app_id
            WHERE a.organization_id = $1
        `, [orgId]);
        hint.public_app_pages = r?.c ?? 0;
    } catch (e) { if (!_isNotProvisioned(e)) throw e; }
    try {
        const r = await db.getOne(`
            SELECT COUNT(*)::int AS c FROM webpages
            WHERE organization_id = $1 AND is_published = TRUE
        `, [orgId]);
        hint.published_webpages = r?.c ?? 0;
    } catch (e) { if (!_isNotProvisioned(e)) throw e; }
    hint.any = Object.values(hint).some(v => typeof v === 'number' && v > 0);
    return hint;
}

module.exports = {
    id: 'CRA-Art13(8)-support-period',
    regulation: 'CRA',
    article: 'Art. 13(8)',
    frameworks: [
        { regulation: 'PLD', ref: 'Art. 11(2)(c)' },
    ],
    severity: 'medium',
    scope: 'global',
    verification: 'attestation',
    titleKey: 'compliance.check_cra_support_period_title',
    descriptionKey: 'compliance.check_cra_support_period_desc',
    remediationKey: 'compliance.check_cra_support_period_fix',
    remediationLink: 'admin/compliance/settings',

    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (settings.framework_relevance?.cra === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The CRA was marked not relevant for this organisation.',
            };
        }

        const craRole = settings.cra_role || null;
        if (craRole !== 'manufacturer') {
            const products = await _productsHint(orgId);
            const roleText = craRole ? `the CRA role is "${craRole}"` : 'no CRA role has been declared';
            return {
                status: 'not_applicable',
                evidence: { cra_role: craRole, products_hint: products },
                details: products.any
                    ? `Art. 13(8) binds manufacturers and ${roleText}. Note: this organisation publishes solutions, public app pages or webpages (${[
                        products.solution_releases ? `${products.solution_releases} solution release(s)` : null,
                        products.public_app_pages ? `${products.public_app_pages} public app page(s)` : null,
                        products.published_webpages ? `${products.published_webpages} published webpage(s)` : null,
                    ].filter(Boolean).join(', ')}) — if those are products with digital elements placed on the market, declare the manufacturer role under Compliance → Settings.`
                    : `Art. 13(8) binds manufacturers and ${roleText}; no products placed on the market were detected.`,
            };
        }

        const now = Date.now();
        const policyUrl = _httpUrl(settings.support_policy_url);
        const endDate = _dateOnly(settings.support_end_date);
        const channelSet = typeof settings.security_update_channel === 'string' && settings.security_update_channel.trim().length > 0;
        const daysRemaining = _daysUntil(endDate, now);

        const evidence = {
            cra_role: craRole,
            support_policy_url: policyUrl,
            support_policy_url_set: !!policyUrl,
            support_end_date: endDate,
            days_remaining: daysRemaining,
            renewal_horizon_days: RENEWAL_HORIZON_DAYS,
            security_update_channel_set: channelSet,
        };

        const missing = [];
        if (!policyUrl) missing.push(settings.support_policy_url ? 'the support policy URL is not a valid http(s) address' : 'no support policy URL');
        if (!endDate) missing.push(settings.support_end_date ? 'the end-of-support date is not a valid date' : 'no end-of-support date');
        if (missing.length) {
            return {
                status: 'fail',
                evidence,
                details: `Support period not declared: ${missing.join(' and ')}. Art. 13(8) requires the manufacturer to determine the support period and publish the end-of-support date — record both under Compliance → Settings.`,
            };
        }

        if (daysRemaining < 0) {
            return {
                status: 'warn',
                evidence,
                details: `The published end-of-support date ${endDate} has passed (${Math.abs(daysRemaining)} day(s) ago). Either extend the support period and update the policy, or make sure users have been told that security updates have ended.`,
            };
        }
        if (daysRemaining < RENEWAL_HORIZON_DAYS) {
            return {
                status: 'warn',
                evidence,
                details: `End of support is ${endDate} — ${daysRemaining} day(s) away, inside the 12-month renewal horizon. Decide now whether the period is extended or a successor version takes over, and announce it through the update channel.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Support period declared: policy published at ${policyUrl}, end of support ${endDate} (${daysRemaining} day(s) remaining)${channelSet ? ', update channel recorded' : ' — recording the security-update channel is recommended'}.`,
        };
    },
};

module.exports._test = { _dateOnly, _daysUntil, _httpUrl, RENEWAL_HORIZON_DAYS };
