/**
 * Admin License Routes — direct license issuance from the admin console.
 *
 *   GET    /api/admin/licenses                  — list admin-issued licenses (?organizationId)
 *   POST   /api/admin/licenses/grant            — mint a new license
 *   POST   /api/admin/licenses/:id/revoke       — revoke an existing license
 *   POST   /api/admin/licenses/:id/extend       — change expires_at on a license
 *   POST   /api/admin/licenses/import           — re-import a previously-exported blob
 *   GET    /api/admin/licenses/capabilities     — feature flags for the UI
 *
 * Super-admin only. No org-admin self-grant in v1.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Every body and query is `.strict()` and typed, because each field used to
 * be read with a fallback that minted a DIFFERENT licence than the one asked
 * for, under a 200 that said "License granted.":
 *
 *   - `scope` was `=== 'server' ? 'server' : 'organization'`, so 'Server'
 *     bound the licence to the organisation in the body instead of minting the
 *     unbound blob another install binds on import;
 *   - `maxSeats` became `Number(value)`, and the seat check reads anything
 *     that is not a positive number as "no cap": 'ten' — or 0 — granted
 *     UNLIMITED seats;
 *   - `featuresOverride` / `limitsOverride` in any shape but a list / an
 *     object were dropped, and the licence recorded the tier's defaults;
 *   - `deliverEmail` without an '@' was skipped without a word — no mail, no
 *     `emailDelivery` in the answer — while the admin believed it was sent;
 *   - on import, a misspelled `organizationId` ("organisationId") was dropped
 *     and the licence landed in the org embedded in the blob, or unbound.
 *
 * `tier` stays judged by tiers.isValidTier (legacy names included), and a date
 * in the past by adminIssuance itself; the schema adds the shape around them.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z } = require('zod');

require('../license');
const tiers = require('../license/tiers');
const adminIssuance = require('../license/adminIssuance');
const store = require('../license/store');
const { requireSuperAdmin } = require('../auth/permissions');
const userStore = require('../stores/userStore');
const { sendServiceEmail, getServiceEmailConfig } = require('../utils/emailService');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const ORG_TEXT = 'organizationId is the id of an organisation.';
const orgId = () => worded(ORG_TEXT).trim().min(1, ORG_TEXT);

const EXPIRY_TEXT = 'expiresAt is a date, like 2027-12-31T23:59:59Z.';
const expiresAt = () => worded(EXPIRY_TEXT).trim().refine((v) => !Number.isNaN(Date.parse(v)), EXPIRY_TEXT);

const ListQuery = z.object({
    organizationId: orgId().optional(),
    includeInactive: z.enum(['true', 'false'], { errorMap: () => ({ message: 'includeInactive is true or false.' }) }).optional(),
}).strict();

const TIER_TEXT = `tier is one of: ${tiers.TIER_HIERARCHY.join(', ')}.`;
const SEATS_TEXT = 'maxSeats is a whole number of seats, 1 or more — or empty for no cap.';
const FEATURES_TEXT = 'featuresOverride is a list of feature keys.';
const LIMITS_TEXT = 'limitsOverride is an object of limits, like { "max_users": 50 }.';
const EMAIL_TEXT = 'deliverEmail is an e-mail address.';

const GrantBody = z.object({
    scope: z.enum(['organization', 'server'], { errorMap: () => ({ message: 'scope is "organization" or "server".' }) })
        .default('organization'),
    organizationId: orgId().nullish(),
    tier: worded(TIER_TEXT).trim().refine((t) => tiers.isValidTier(t), TIER_TEXT),
    expiresAt: expiresAt(),
    billingInterval: z.enum(['monthly', 'yearly'], { errorMap: () => ({ message: 'billingInterval is "monthly" or "yearly".' }) })
        .optional(),
    featuresOverride: z.array(worded(FEATURES_TEXT).trim().min(1, FEATURES_TEXT), { invalid_type_error: FEATURES_TEXT })
        .nullish(),
    limitsOverride: z.record(
        z.number({ invalid_type_error: LIMITS_TEXT }).int(LIMITS_TEXT).nullable(),
        { invalid_type_error: LIMITS_TEXT },
    ).nullish(),
    maxSeats: z.number({ invalid_type_error: SEATS_TEXT }).int(SEATS_TEXT).min(1, SEATS_TEXT).nullish(),
    notes: worded('notes is text.').nullish(),
    // Empty is "do not send"; anything else has to be somewhere a mail can go.
    deliverEmail: z.preprocess(
        (v) => (v === '' ? undefined : v),
        worded(EMAIL_TEXT).trim().email(EMAIL_TEXT).optional(),
    ),
}, { required_error: TIER_TEXT, invalid_type_error: TIER_TEXT }).strict().superRefine((b, ctx) => {
    if (b.scope === 'organization' && !b.organizationId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['organizationId'],
            message: 'An organisation licence needs the organizationId it is for — or scope "server" for an unbound one.',
        });
    }
});

const RevokeBody = bodyOf({ reason: worded('reason is text.').trim().max(500, 'reason is at most 500 characters.').optional() });

const ExtendBody = z.object({ expiresAt: expiresAt() }, { required_error: EXPIRY_TEXT, invalid_type_error: EXPIRY_TEXT }).strict();

const BLOB_TEXT = 'blob is the exported licence text, beginning with beeflow-admin-v1.';
const ImportBody = z.object({
    blob: worded(BLOB_TEXT).trim().min(1, BLOB_TEXT),
    // Empty means "the organisation the blob names".
    organizationId: z.preprocess((v) => (v === '' ? null : v), orgId().nullish()),
}, { required_error: BLOB_TEXT, invalid_type_error: BLOB_TEXT }).strict();

router.use((req, res, next) => {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
});
// requireSuperAdmin, NOT requireAdmin. This router mints licences for an
// arbitrary organizationId taken from the body, lists every org's licences
// including the re-importable blob, and imports unsigned blobs. requireAdmin
// passes on the `manage_users` permission, which config/orgRoles.json grants to
// every org_admin — so until this line changed, any self-registered org admin
// could grant themselves an enterprise licence. The header above has always
// said "Super-admin only"; now the gate agrees with it.
router.use(requireSuperAdmin);

function actorId(req) {
    return req.session?.user?.id || null;
}

// ── GET /capabilities ──────────────────────────────────────────────────
router.get('/capabilities', (_req, res) => {
    res.json({
        // `full` is a first-class admin-issuable tier, same as enterprise — no
        // operator-only gate. (Historically full was the internal/operator tier
        // behind ALLOW_ADMIN_FULL_TIER; super-admins can now grant it directly.)
        tiers: tiers.TIER_HIERARCHY,
        billingIntervals: ['monthly', 'yearly'],
        scopes: ['organization', 'server'],
        tierFeatures: tiers.TIER_FEATURES,
        tierLimits: tiers.TIER_LIMITS,
        fullTierEnabled: true,
    });
});

// ── GET / ──────────────────────────────────────────────────────────────
router.get('/', validate({ query: ListQuery }), async (req, res) => {
    const { organizationId, includeInactive } = req.query;
    const list = await store.getAdminIssuedLicenses({
        organizationId: organizationId || null,
        includeInactive: includeInactive !== 'false',
    });
    // Decorate with org name for UI display.
    const orgs = await userStore.getAllOrganizations();
    const orgsById = new Map((orgs || []).map(o => [o.id, o]));
    const licenses = list.map(l => ({
        ...adminIssuance.publicLicenseShape(l),
        organizationName: orgsById.get(l.organizationId)?.name || null,
        // Include the original blob so the UI can offer "Copy blob" on any row.
        blob: l.rawToken && l.rawToken.startsWith(adminIssuance.BLOB_PREFIX) ? l.rawToken : null,
    }));
    res.json({ licenses });
});

// ── POST /grant ────────────────────────────────────────────────────────
router.post('/grant', validate({ body: GrantBody }), async (req, res) => {
    try {
        const {
            scope, organizationId, tier, expiresAt,
            billingInterval, featuresOverride, limitsOverride,
            maxSeats, notes, deliverEmail,
        } = req.body;
        const result = await adminIssuance.issueAdminLicense({
            scope,
            organizationId: scope === 'organization' ? organizationId : null,
            tier,
            expiresAt,
            billingInterval: billingInterval || 'yearly',
            featuresOverride: featuresOverride || null,
            limitsOverride: limitsOverride || null,
            maxSeats: maxSeats ?? null,
            notes: notes || null,
            activatedBy: actorId(req),
        });

        // Optional: email the blob straight to the customer. Failure here
        // is non-fatal — the admin still gets the blob in the response and
        // can deliver it manually.
        if (deliverEmail) {
            const delivery = await deliverBlobByEmail({
                to: deliverEmail,
                tier,
                expiresAt: result.license.expiresAt,
                organizationId,
                blob: result.blob,
            }).catch(e => ({ success: false, error: e.message }));
            result.emailDelivery = delivery;
            if (!delivery?.success) {
                log.warn(`[Admin License] email.delivery_failed to=${deliverEmail} reason=${delivery?.error || 'unknown'}`);
                try {
                    const userStore = require('../stores/userStore');
                    await userStore.logSubscriptionAudit('email_send_failed', 'license', result.license.id, actorId(req), null, { to: deliverEmail, reason: delivery?.error || 'unknown' });
                } catch (_) { /* audit best-effort */ }
            }
        }

        res.json(result);
    } catch (e) {
        log.error('[Admin License] grant error:', e);
        res.status(400).json({ error: e.message });
    }
});

async function deliverBlobByEmail({ to, tier, expiresAt, organizationId, blob }) {
    const cfg = await getServiceEmailConfig();
    if (!cfg.configured) {
        return { success: false, error: 'service_email_not_configured' };
    }
    const tierLabel = tier ? tier[0].toUpperCase() + tier.slice(1) : 'Pro';
    const expiry = expiresAt ? new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'n/a';
    const subject = `Your Bee Flow ${tierLabel} license key`;
    const text = [
        `Hi,`,
        ``,
        `Your Bee Flow ${tierLabel} license is ready.`,
        ``,
        `Expires: ${expiry}`,
        organizationId ? `Organization: ${organizationId}` : null,
        ``,
        `Paste the block below into Settings → Organisation → License → "Enter license key".`,
        ``,
        blob,
        ``,
        `Keep this email — the same key can be re-imported on a new install if needed.`,
        ``,
        `— Bee Flow`,
    ].filter(Boolean).join('\n');
    const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.55;max-width:560px;margin:24px auto;padding:0 16px">
        <h2 style="margin:0 0 12px">Your Bee Flow ${tierLabel} license</h2>
        <p>Expires: <strong>${expiry}</strong>${organizationId ? `<br/>Organization: <code>${organizationId}</code>` : ''}</p>
        <p>Paste the block below into <em>Settings → Organisation → License → "Enter license key"</em>.</p>
        <pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:12px;word-break:break-all;white-space:pre-wrap;font-size:12px">${blob}</pre>
        <p style="font-size:12px;color:#666">Keep this email — the same key can be re-imported on a new install if needed.</p>
    </body></html>`;
    return sendServiceEmail({ to, subject, text, html });
}

// ── POST /:id/revoke ───────────────────────────────────────────────────
router.post('/:id/revoke', validate({ body: RevokeBody }), async (req, res) => {
    const { reason } = req.body;
    const lic = await store.getLicenseById(req.params.id);
    if (!lic) return res.status(404).json({ error: 'License not found' });
    if (!adminIssuance.isAdminIssuedLicense(lic)) {
        return res.status(400).json({ error: 'Only admin-issued licenses can be revoked here' });
    }
    await store.markRevoked(req.params.id, reason || `revoked_by:${actorId(req) || 'admin'}`);
    const fresh = await store.getLicenseById(req.params.id);
    res.json({ license: adminIssuance.publicLicenseShape(fresh) });
});

// ── POST /:id/extend ───────────────────────────────────────────────────
router.post('/:id/extend', validate({ body: ExtendBody }), async (req, res) => {
    const { expiresAt } = req.body;
    const lic = await store.getLicenseById(req.params.id);
    if (!lic) return res.status(404).json({ error: 'License not found' });
    if (!adminIssuance.isAdminIssuedLicense(lic)) {
        return res.status(400).json({ error: 'Only admin-issued licenses can be extended here' });
    }
    const d = new Date(expiresAt);
    if (d.getTime() <= Date.now()) return res.status(400).json({ error: 'expiresAt must be in the future' });
    const updated = await store.extendExpiry(req.params.id, d.toISOString(), actorId(req));
    res.json({ license: adminIssuance.publicLicenseShape(updated) });
});

// ── POST /import ───────────────────────────────────────────────────────
router.post('/import', validate({ body: ImportBody }), async (req, res) => {
    try {
        const { blob, organizationId } = req.body;
        const result = await adminIssuance.importAdminLicense(blob, {
            activatedBy: actorId(req),
            organizationId: organizationId || null,
        });
        res.json(result);
    } catch (e) {
        log.error('[Admin License] import error:', e);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
