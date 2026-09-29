/**
 * Compliance — org settings, the onboarding stamp, per-operator SCC
 * attestations and the auto-detect pre-fill the onboarding wizard reads.
 *
 * PUT /settings hands the body to `complianceStore.sanitizeSettingsPatch`
 * before `saveSettings`: SETTINGS_FIELDS is the whitelist, so every column a
 * framework stream adds there is accepted here without a route edit, and the
 * boundary is one call instead of a per-field list that drifts. What the
 * sanitiser does, and why the route may not skip it:
 *  · unknown keys are dropped (the columns with their own writers —
 *    scc_confirmed_operators, ropa_reviewed_*, last_retention_run_at — are not
 *    in SETTINGS_FIELDS at all, so a body cannot forge those attestations);
 *  · SETTINGS_REQUEST_DENY is dropped: `enabled_frameworks` and
 *    `framework_relevance` are frameworkPolicy's (a body must not enable a
 *    LICENSED framework without its licence check, its events and its
 *    relevance audit trail — POST /frameworks/:id/enable is the way in), and
 *    the marking stamp is this route's own, written below. Dropped rather than
 *    refused, so a client that PUTs a whole settings object back still saves;
 *  · every remaining value is coerced to its declared column type AND checked
 *    against that column's domain, so one "support_end_date":"soon" — or a
 *    pasted "notice_period_days": 99999999999 that a typed int4 column cannot
 *    hold — is a 400 naming that field instead of a driver error that discards
 *    the other thirty edits of the same submit.
 *
 * Two things the route still owns:
 *  · AI Act Art. 50(2) content marking. Flipping `ai_content_marking_enabled`
 *    (or editing the footer while marking is on) is a compliance decision, so
 *    it is stamped (`_enabled_at` / `_enabled_by`), evidenced, the marking
 *    memo is invalidated and CONTENT_MARKING_CHANGED re-runs the check.
 *  · `public_dsr_url` in the response — the absolute link an admin publishes,
 *    derived from the org's `public_base_url` or the installation's own host.
 */

// ── Why PUT /settings has no schema of its own ───────────────────
//
// The allow-list already exists, once, in complianceStore.SETTINGS_FIELDS: 45
// writable columns with a kind, a fallback and a min/max each, plus
// SETTINGS_REQUEST_DENY for the four an attestation writer owns.
// `sanitizeSettingsPatch` coerces against it and throws a
// SettingsValidationError that this route answers as a 400 naming the field
// and what it expected. A second copy in zod would be a list to keep in step
// with the first, and the first is the one the DDL is generated from.
//
// The one thing that list does NOT do is refuse an unknown key — it drops it.
// That stays visible here rather than becoming a 400, because the settings
// page re-renders from the response, so a dropped field reverts on screen,
// and because the Playbooks resolver posts a model-planned body to this same
// route: turning a planner typo into a hard 400 would fail a whole plan that
// today applies the fields it did get right.

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const runner = require('../../compliance/runner');
const configStore = require('../../stores/configStore');
const { getAll } = require('../../db');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { publicBaseUrl, publicDsrPath } = require('../../utils/appPaths');

// ───────────────── Settings / onboarding ─────────────────

/** Settings row + the derived read-only fields the UI shows next to them. */
function decorate(settings) {
    const s = settings || {};
    return { ...s, public_dsr_url: `${publicBaseUrl(s.public_base_url || null)}${publicDsrPath()}` };
}

const MARKING_KEYS = ['ai_content_marking_enabled', 'ai_content_marking_footer'];

/**
 * Typed store errors (SettingsValidationError) carry their own status + body;
 * the body names the offending FIELDS only, never the submitted values.
 */
function fail(res, next, e) {
    if (e && Number.isInteger(e.status) && e.body) return res.status(e.status).json(e.body);
    return next(e);
}

/**
 * The marking patch, stamped. Returns `null` when nothing about marking
 * changed — the caller then writes no evidence and emits nothing.
 * Turning marking OFF clears the stamp; a footer edit while marking is on
 * re-stamps (the published wording is what was attested to).
 */
function markingPatch(body, existing, actorId, at) {
    const touched = MARKING_KEYS.filter(k => Object.prototype.hasOwnProperty.call(body, k));
    if (!touched.length) return null;
    const wasOn = !!existing?.ai_content_marking_enabled;
    const willBeOn = Object.prototype.hasOwnProperty.call(body, 'ai_content_marking_enabled')
        ? !!body.ai_content_marking_enabled
        : wasOn;
    const footerChanged = Object.prototype.hasOwnProperty.call(body, 'ai_content_marking_footer')
        && (body.ai_content_marking_footer || null) !== (existing?.ai_content_marking_footer || null);
    if (willBeOn === wasOn && !footerChanged) return null;
    if (!willBeOn) return { enabled: false, footerChanged, patch: { ai_content_marking_enabled_at: null, ai_content_marking_enabled_by: null } };
    return { enabled: true, footerChanged, patch: { ai_content_marking_enabled_at: at, ai_content_marking_enabled_by: actorId } };
}

router.get('/settings', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const s = await complianceStore.getSettings(orgId);
    res.json(decorate(s));
});

router.put('/settings', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    try {
        const orgId = await resolveOrgId(req);
        const body = req.body || {};
        const actorId = req.session?.user?.id || null;
        const at = new Date().toISOString();
        const existing = await complianceStore.getSettings(orgId);
        const patch = complianceStore.sanitizeSettingsPatch(body);
        const marking = markingPatch(patch, existing, actorId, at);
        const saved = await complianceStore.saveSettings(orgId, marking ? { ...patch, ...marking.patch } : patch);

        if (marking) {
            // Allow-listed payload: the decision, the actor and the moment.
            // The footer text itself is org copy, not personal data, and is
            // what the attestation is about — its length is capped.
            await complianceStore.addEvidence({
                organization_id: orgId,
                check_id: 'AIA-Art50-content-marking',
                subject_type: 'setting',
                subject_id: 'ai_content_marking',
                payload: {
                    action: 'content_marking_changed',
                    enabled: marking.enabled,
                    footer_changed: marking.footerChanged,
                    footer: marking.enabled ? String(saved?.ai_content_marking_footer || '').slice(0, 500) || null : null,
                    by: actorId,
                    at,
                },
            }).catch(e => log.warn('[Compliance] marking evidence failed:', e.message));
            try { require('../../compliance/marking').invalidate(orgId); } catch { /* optional */ }
            try {
                const { emit, EVENTS } = require('../../compliance/events');
                emit(EVENTS.CONTENT_MARKING_CHANGED, { orgId, enabled: marking.enabled, by: actorId });
            } catch { /* the bus is optional in tests */ }
        }
        res.json(decorate(saved));
    } catch (e) {
        fail(res, next, e);
    }
});

router.post('/settings/onboarded', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    try {
        const orgId = await resolveOrgId(req);
        // The wizard PUTs the same settings shape, so it goes through the same
        // boundary; `onboarded_at` is this route's own stamp, set last.
        const patch = { ...complianceStore.sanitizeSettingsPatch(req.body), onboarded_at: new Date().toISOString() };
        const saved = await complianceStore.saveSettings(orgId, patch);
        runner.runAll(orgId, { runType: 'manual' }).catch(e =>
            log.warn('[Compliance] post-onboarding run failed:', e.message)
        );
        res.json(decorate(saved));
    } catch (e) {
        fail(res, next, e);
    }
});

router.post('/settings/scc', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const { operator, confirmed } = req.body || {};
    if (!operator) return res.status(400).json({ error: 'operator is required' });
    const actorId = req.session?.user?.id || null;
    const next = await complianceStore.setSccConfirmed(orgId, operator, !!confirmed, actorId);
    runner.runOne(orgId, 'GDPR-Art44-external-transfers').catch(() => {});
    res.json({ scc_confirmed_operators: next });
});

// ───────────────── Auto-detect settings ─────────────────
//
// Reads existing org config to pre-fill the onboarding wizard. No persistence
// happens here — the wizard PUTs the result back to /settings after the user
// confirms.

router.post('/auto-detect-settings', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const ai = (await configStore.getConfig('ai')) || {};
    const hasProviders = Array.isArray(ai.providers) && ai.providers.length > 0;
    const shield = (await configStore.getConfig(`org_privacy_shield_${orgId}`)) || {};

    // Legal bases — start with contract + legitimate interests if any agent
    // is published; add consent if Privacy Shield requires user opt-in.
    const legalBases = ['contract', 'legitimate_interests'];
    if (shield.requireConsent) legalBases.push('consent');

    // Residency: 'internal' if no external providers, 'hybrid' otherwise.
    const dataResidency = hasProviders ? 'hybrid' : 'internal';

    // Retention: 365 days default unless the org already set one.
    const existing = await complianceStore.getSettings(orgId);
    const defaultRetentionDays = existing.default_retention_days || 365;

    // Breach recipients: requester email + org admins.
    const requesterEmail = req.session?.user?.email || null;
    let admins = [];
    try {
        admins = await getAll(
            // 'org_admin' is the canonical orgRole. The legacy 'admin'
            // value is kept in the IN-list to cover historical rows
            // that pre-date the rename (matches the normalisation in
            // server/auth/permissions.js).
            `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin'))`,
            [orgId],
        );
    } catch { admins = []; }
    const breachRecipients = Array.from(new Set(
        [requesterEmail, ...(admins || []).map(a => a.email)].filter(Boolean)
    ));

    // Privacy URL: pass-through if already set.
    const privacyNoticeUrl = existing.privacy_notice_url || null;

    res.json({
        legal_bases: legalBases,
        data_residency: dataResidency,
        default_retention_days: defaultRetentionDays,
        privacy_notice_url: privacyNoticeUrl,
        breach_recipients: breachRecipients,
    });
});

module.exports = router;
module.exports.decorate = decorate;
module.exports.markingPatch = markingPatch;
