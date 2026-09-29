// @typecheck
/**
 * Admin Routes — organization management: CRUD, content-encryption settings
 * and the logo upload. Split out of auth/adminRoutes.js; mounted there in the
 * original registration order.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth, requireSuperAdmin, getUserPermissions, resolveUserOrgIds } = require('../permissions');
const { sanitizePlainTextFields } = require('../../utils/htmlSanitizer');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const freeEmailDomains = require('../../utils/freeEmailDomains');
const { requireOrgAdmin } = require('./orgAdminGuards');

/**
 * The fields PUT /organizations/:id writes. The user route has had an
 * unknown-key guard since a pentest sent {"isAdmin":true} and got 200; the org
 * route was never given one, so it silently ignored anything it did not
 * destructure.
 */
const ORG_UPDATE_FIELDS = Object.freeze([
    'name', 'description', 'tagline', 'address', 'billingLine2', 'billingPostalCode',
    'billingCity', 'billingCountry', 'email', 'phone', 'website', 'kvk', 'vat', 'logo',
    'footerText', 'defaultGroups', 'allowSignup', 'authMethod', 'enabledIntegrations',
    'autoApproveSSO', 'allowedDomains', 'usagePooled',
]);
const ORG_UPDATE_ALLOWED_KEYS = new Set(ORG_UPDATE_FIELDS);

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const ORG_NAME_TEXT = 'Organization name required';
const text = (max) => worded('That field must be text.').max(max, `That field is at most ${max} characters.`);

/**
 * POST /organizations. The UPDATE route beside it has refused unknown keys
 * since a pentest sent {"isAdmin":true} and got 200; CREATE never grew the
 * same guard, so the identical body created an organisation and answered 200
 * with the field silently dropped.
 *
 * `allowSignup` is a real boolean now. It was stored as `!!allowSignup`, so
 * the string "false" — what an HTML form sends — opened the organisation to
 * self-service signup while the caller had just asked for the opposite.
 */
const CreateOrgBody = z.object({
    name: worded(ORG_NAME_TEXT).trim().min(1, ORG_NAME_TEXT).max(200, 'An organization name is at most 200 characters.'),
    description: text(2000).optional(),
    tagline: text(2000).optional(),
    address: text(2000).optional(),
    email: text(254).optional(),
    phone: text(64).optional(),
    website: text(2000).optional(),
    kvk: text(64).optional(),
    vat: text(64).optional(),
    logo: text(2_000_000).optional(),
    footerText: text(2000).optional(),
    defaultGroups: z.array(worded('A group id must be text.'), { invalid_type_error: 'defaultGroups must be a list of group ids.' }).optional(),
    allowSignup: z.boolean({ invalid_type_error: 'allowSignup must be true or false.' }).optional(),
}).strict();

// tier and scope are checked in the handler, against the tier table and the
// surface list the encryption policy owns — a list baked in here would drift
// from stores/encryptionPolicy.js the first time a surface is added.
const EncryptionBody = z.object({
    tier: worded('A tier must be text.').optional(),
    scope: z.union([z.record(z.unknown()), z.null()], {
        invalid_type_error: 'scope must be an object of surface booleans, or null',
    }).optional(),
}).strict();

/**
 * Organisation text that is only ever rendered as text. A pentest stored
 * `<img src=x onerror=...>` in `tagline` and `<script>` in `description` and
 * both round-tripped verbatim; they never executed in the SPA because React
 * escapes, but the same values are interpolated into HTML EMAIL, which nothing
 * escapes for you. Stripping on the way in means the column never holds markup
 * in the first place, whatever renders it later.
 *
 * `logo` and `website` are URLs and `email`/`phone` are format-shaped, so they
 * get the same treatment: none of them has any business containing tags.
 * Structural fields (defaultGroups, allowedDomains, booleans) are left alone.
 */
const ORG_TEXT_FIELDS = Object.freeze([
    'name', 'description', 'tagline', 'address', 'billingLine2', 'billingPostalCode',
    'billingCity', 'billingCountry', 'email', 'phone', 'website', 'kvk', 'vat',
    'logo', 'footerText',
]);

/** Longer than a name needs, short enough that a column is not an upload slot. */
const ORG_TEXT_MAX = 2000;

function sanitizeOrgText(orgUpdates) {
    return sanitizePlainTextFields(orgUpdates, ORG_TEXT_FIELDS, { maxLen: ORG_TEXT_MAX });
}

// === Organizations Management API (Admin Only) ===

router.get('/organizations', requireAuth, async (req, res) => {
    // Non-super-admins must have org-level permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isSuperAdmin) {
        const userId = req.session.user?.id;
        const perms = await getUserPermissions(userId, req.session);
        const canView = perms.includes('all') || perms.includes('manage_users') || perms.includes('admin_security') || perms.includes('org_admin');
        if (!canView) {
            return res.status(403).json({ error: 'Permission required to view organisations' });
        }
    }

    let orgs = await userStore.getAllOrganizations();

    // Org-scoped filtering using canonical resolver
    if (!isSuperAdmin) {
        const myOrgIds = await resolveUserOrgIds(req);
        if (myOrgIds) {
            orgs = orgs.filter(o => myOrgIds.has(o.id));
        }
    }

    res.json(orgs);
});

router.post('/organizations', requireSuperAdmin, validate({ body: CreateOrgBody }), async (req, res) => {
    const { name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup } = req.body;

    // The shared slugifier, not a local copy of the same regex: it also applies
    // the 48-character cap, and createOrganization refuses anything longer.
    const id = require('../accountProvisioning').slugifyOrgId(name);

    // Apply default integrations from global config
    const configStore = require('../../stores/configStore');
    const defaultIntegrations = await configStore.getConfig('default_org_integrations') || null;

    const newOrg = sanitizeOrgText({ id, name, description: description || '', tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups: defaultGroups || [], allowSignup: allowSignup === true, enabledIntegrations: defaultIntegrations, registrationSource: 'admin' });

    if (await userStore.createOrganization(newOrg)) {
        log.info(`[Audit] ${req.session.user?.id || 'system'} created organization '${name}' (${id})`);
        await userStore.logAccessAudit(
            'org.create',
            'organization',
            id,
            req.session.user?.id || null,
            null,
            { name, description: description || '', allowSignup: allowSignup === true },
            id,
        );
        res.json({ success: true, organization: newOrg });
    } else {
        res.status(400).json({ error: 'Organization already exists' });
    }
});

router.get('/organizations/:id', requireOrgAdmin('id'), async (req, res) => {
    const org = await userStore.getOrganization(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json(org);
});

// ── Content-encryption settings ─────────────────────────────────────────────
// Read and change the org's encryption tier and per-surface scope.
//
// Both directions are safe at any time: reads detect the on-disk format of
// each value, so switching a surface on leaves older plaintext rows readable,
// and switching it off leaves older ciphertext rows readable. Nothing is
// re-encrypted by flipping these, and nothing needs to be.
// Authorisation note: these two routes use the STRICT, group-permission-aware
// org-admin decider from permissions.js, not the local requireOrgAdmin above.
// The local one accepts org-role plus plain group *membership*, so a user who
// is org_admin of org A and merely a member of any group belonging to org B
// would pass for org B. Every other org-scoped config route (orgPrivacyShield,
// orgAzureConfig, houseStyles, talkNotesSettings) uses the strict decider;
// choosing an org's encryption posture belongs in that company.
async function requireStrictOrgAdmin(req, res) {
    const { isOrgAdminForOrg } = require('../permissions');
    if (await isOrgAdminForOrg(req, req.params.id)) return true;
    res.status(403).json({ error: 'Only organization admins can manage encryption settings' });
    return false;
}

// Canonical super-admin predicate (permissions.js), not another inline copy of
// the `session.isAdmin || user.role === 'admin'` expression — its docstring
// notes that spelling drifted across ~20 handlers before it was centralised.
function isSuperAdminReq(req) {
    return require('../permissions').isSuperAdmin(req);
}

router.get('/organizations/:id/encryption', async (req, res) => {
    if (!(await requireStrictOrgAdmin(req, res))) return;
    const { ALL_SURFACES, IMPLEMENTED_SURFACES, policyFromRow } = require('../../stores/encryptionPolicy');
    const { getEncryptionAvailability } = require('../../stores/encryptionAvailability');
    const org = await userStore.getOrganization(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const policy = policyFromRow({
        encryption_tier: org.encryption_tier ?? org.encryptionTier,
        encryption_scope: org.encryption_scope ?? org.encryptionScope,
    });
    // `effective` is what is actually enforced. A surface can be switched on in
    // `scope` while its store is not wired yet, and reporting only `scope`
    // would tell an admin data is protected when it is not.
    const effective = {};
    for (const s of ALL_SURFACES) effective[s] = policy.scope[s] && IMPLEMENTED_SURFACES.includes(s);

    // Availability drives the picker: which tiers this org may choose, and why
    // not, split into a billing reason (upgrade) and a config reason (ops).
    const availability = await getEncryptionAvailability(req.params.id);

    res.json({
        tier: policy.tier,
        enabled: policy.enabled,
        scope: policy.scope,
        effective,
        surfaces: ALL_SURFACES,
        implementedSurfaces: IMPLEMENTED_SURFACES,
        keyVersion: org.org_key_version ?? org.orgKeyVersion ?? 1,
        // Entitlement + readiness
        entitled: availability.entitled,
        allowedTiers: availability.allowedTiers,
        tierOptions: availability.tiers,
        readiness: availability.readiness,
        // Only a super-admin may change the per-surface scope; the UI hides the
        // advanced block for everyone else rather than offering a control whose
        // save would 403.
        canEditScope: isSuperAdminReq(req),
    });
});

router.put('/organizations/:id/encryption', validate({ body: EncryptionBody }), async (req, res) => {
    if (!(await requireStrictOrgAdmin(req, res))) return;
    const { TIERS, ALL_SURFACES, invalidatePolicyCache, policyFromRow } = require('../../stores/encryptionPolicy');
    const { getEncryptionAvailability } = require('../../stores/encryptionAvailability');
    const { id } = req.params;
    const { tier, scope } = req.body;

    const org = await userStore.getOrganization(id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const prevPolicy = policyFromRow({
        encryption_tier: org.encryption_tier ?? org.encryptionTier,
        encryption_scope: org.encryption_scope ?? org.encryptionScope,
    });

    const updates = {};

    if (tier !== undefined) {
        if (!TIERS.includes(tier)) {
            return res.status(400).json({ error: `tier must be one of: ${TIERS.join(', ')}` });
        }
        // Entitlement + readiness. Only checked when the tier actually CHANGES,
        // so an org whose plan lapsed can still save unrelated edits and, above
        // all, can still switch back to 'none'.
        if (tier !== prevPolicy.tier) {
            const availability = await getEncryptionAvailability(id);
            const opt = availability.tiers.find(t => t.tier === tier);
            if (!opt || !opt.selectable) {
                // Two distinct failure classes, distinguished for the UI:
                //   entitlement → 403 + upgrade path (a billing answer)
                //   readiness   → 409 + what is missing (a config answer)
                // Refusing outright rather than storing the tier is deliberate:
                // resolveCrypto would otherwise fall back to plaintext with only
                // a console.error, leaving the org believing it was encrypted.
                if (opt && opt.blockedBy === 'entitlement') {
                    return res.status(403).json({
                        error: 'feature_locked',
                        code: 'encryption_not_entitled',
                        feature: 'encryption',
                        tier,
                        message: opt.reason,
                    });
                }
                return res.status(409).json({
                    error: 'tier_unavailable',
                    code: 'encryption_tier_not_ready',
                    tier,
                    missing: opt ? opt.missing : [],
                    message: (opt && opt.reason) || `Encryption tier '${tier}' cannot be enabled on this server.`,
                });
            }
        }
        updates.encryptionTier = tier;
    }

    if (scope !== undefined) {
        // Per-surface scope is a super-admin control. An org admin choosing a
        // tier gets all surfaces; letting them switch individual ones off is
        // how you end up with the PII token map readable while the messages
        // beside it are encrypted.
        if (!isSuperAdminReq(req)) {
            return res.status(403).json({
                error: 'scope_forbidden',
                code: 'encryption_scope_super_admin_only',
                message: 'Per-surface encryption scope can only be changed by a platform administrator.',
            });
        }
        if (scope === null) {
            updates.encryptionScope = null;   // null = every surface this tier supports
        } else {
            const unknown = Object.keys(scope).filter(k => !(/** @type {readonly string[]} */ (ALL_SURFACES)).includes(k));
            if (unknown.length) {
                return res.status(400).json({
                    error: `unknown surface(s): ${unknown.join(', ')}. Valid: ${ALL_SURFACES.join(', ')}`,
                });
            }
            const clean = {};
            for (const [k, v] of Object.entries(scope)) {
                if (typeof v !== 'boolean') {
                    return res.status(400).json({ error: `scope.${k} must be a boolean` });
                }
                clean[k] = v;
            }
            updates.encryptionScope = JSON.stringify(clean);
        }
    }

    if (!Object.keys(updates).length) {
        return res.status(400).json({ error: 'Nothing to update — provide tier and/or scope' });
    }

    const ok = await userStore.updateOrganization(id, updates);
    if (!ok) return res.status(500).json({ error: 'Failed to update encryption settings' });

    // ── Make the change take effect ──────────────────────────────────────────
    invalidatePolicyCache(id);
    try { require('../orgEscrow').invalidateOrgKeyCache(id); } catch (_) { /* non-fatal */ }

    // Switching INTO zk must force a re-auth. The zero-knowledge tier has no
    // escrow, so the only source of a key is the per-user DEK derived at login.
    // A user already holding a session has no session.encryptionKey, so
    // resolveCrypto returns PLAINTEXT_CONTEXT and their messages keep being
    // written in plaintext — silently, for up to the 30-day cookie lifetime.
    const enteringZk = updates.encryptionTier === 'zk' && prevPolicy.tier !== 'zk';
    if (enteringZk) {
        try {
            const { bustSessionsForOrg } = require('../sessionCache');
            await bustSessionsForOrg(id);
            log.info(`[Auth] Busted sessions for org '${id}' — zk tier requires a fresh login to derive each user's key`);
        } catch (err) {
            // Surface loudly: without the bust, users silently write plaintext.
            log.error(`[Auth] FAILED to bust sessions for org '${id}' after switching to zk — existing sessions will write PLAINTEXT until they expire: ${err.message}`);
        }
    }

    const actorId = req.session.user?.id || 'system';
    log.info(`[Audit] ${actorId} changed encryption settings for org '${id}': ${JSON.stringify(updates)}`);
    // Persistent trail — access_audit_log carries organization_id and never
    // throws, so awaiting it inline is safe.
    try {
        await userStore.logAccessAudit(
            'org.encryption.update', 'organization', id, actorId,
            { tier: prevPolicy.tier, scope: prevPolicy.scope },
            { tier: updates.encryptionTier ?? prevPolicy.tier, scope: updates.encryptionScope ?? null },
            id,
        );
    } catch (_) { /* logAccessAudit already swallows; belt and braces */ }

    const fresh = await userStore.getOrganization(id);
    const policy = policyFromRow({
        encryption_tier: fresh.encryption_tier ?? fresh.encryptionTier,
        encryption_scope: fresh.encryption_scope ?? fresh.encryptionScope,
    });
    res.json({
        success: true,
        tier: policy.tier,
        enabled: policy.enabled,
        scope: policy.scope,
        sessionsBusted: enteringZk,
    });
});

router.put('/organizations/:id', requireOrgAdmin('id'), async (req, res) => {
    const { id } = req.params;

    // Unknown keys are refused here for the same reason they are on
    // PUT /users/:id — a body field accepted, answered 200, and then dropped is
    // how a real privilege change gets mistaken for a failed one. The users
    // route grew that guard after a pentest; this one never did.
    const unknownOrgFields = Object.keys(req.body || {}).filter(k => !ORG_UPDATE_ALLOWED_KEYS.has(k));
    if (unknownOrgFields.length > 0) {
        return res.status(400).json({
            error: `Unsupported field(s): ${unknownOrgFields.join(', ')}`,
            code: 'unknown_fields',
            fields: unknownOrgFields,
        });
    }

    const { name, description, tagline, address, billingLine2, billingPostalCode, billingCity, billingCountry, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, enabledIntegrations, autoApproveSSO, allowedDomains, usagePooled } = req.body;

    // authMethod can only be set once — if already set, ignore any change
    const existing = await userStore.getOrganization(id);
    const finalAuthMethod = (existing && existing.authMethod) ? undefined : authMethod;

    // enabledIntegrations: only super admins can change this
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const finalIntegrations = isSuperAdmin && enabledIntegrations !== undefined ? enabledIntegrations : undefined;

    // ── allowedDomains validation (self-hosted only) ──
    // Org domain allow-listing is a self-hosted feature (formerly gated to the
    // retired 'private-cloud' mode). `!== 'cloud'` keeps it working for both
    // 'self-hosted' and any lingering 'private-cloud' env value.
    let finalAllowedDomains = undefined;
    if (allowedDomains !== undefined && (process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud') {
        if (!Array.isArray(allowedDomains)) {
            return res.status(400).json({ error: 'allowedDomains must be an array' });
        }

        // Validate domain formats
        const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
        const normalised = [];
        for (const d of allowedDomains) {
            const domain = String(d).trim().toLowerCase();
            if (!domain) continue;
            if (!domainRegex.test(domain)) {
                return res.status(400).json({ error: `Invalid domain format: "${domain}"` });
            }
            // A free/public provider (gmail.com, …) can never be an org's
            // allow-listed domain — nobody owns it, so allow-listing it would
            // auto-join every user on that provider (the cross-tenant incident).
            if (freeEmailDomains.isFreeEmailDomain(domain, await freeEmailDomains.getEffectiveFreeEmailDomains())) {
                return res.status(400).json({ error: `"${domain}" is a public email provider and cannot be an organisation allow-listed domain` });
            }
            normalised.push(domain);
        }

        // Collision check: no domain can belong to another org
        if (normalised.length > 0) {
            const allOrgs = await userStore.getAllOrganizations();
            for (const domain of normalised) {
                const collision = allOrgs.find(o =>
                    o.id !== id && Array.isArray(o.allowedDomains) && o.allowedDomains.includes(domain)
                );
                if (collision) {
                    return res.status(400).json({ error: `Domain "${domain}" is already assigned to organisation "${collision.name}"` });
                }
            }
        }

        finalAllowedDomains = normalised;
    }

    const orgUpdates = sanitizeOrgText({ name, description, tagline, address, billingLine2, billingPostalCode, billingCity, billingCountry, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod: finalAuthMethod, enabledIntegrations: finalIntegrations, autoApproveSSO, allowedDomains: finalAllowedDomains, usagePooled });
    if (await userStore.updateOrganization(id, orgUpdates)) {
        // Record only the access-relevant deltas. existing was loaded above
        // for the authMethod check; reuse it.
        const AUDIT_FIELDS = ['name', 'description', 'tagline', 'address', 'billingLine2', 'billingPostalCode', 'billingCity', 'billingCountry', 'email', 'phone', 'website', 'kvk', 'vat', 'authMethod', 'enabledIntegrations', 'allowSignup', 'autoApproveSSO', 'allowedDomains', 'defaultGroups', 'usagePooled'];
        const oldVals = {};
        const newVals = {};
        for (const f of AUDIT_FIELDS) {
            if (orgUpdates[f] === undefined) continue;
            if (existing && JSON.stringify(existing[f]) === JSON.stringify(orgUpdates[f])) continue;
            oldVals[f] = existing ? existing[f] : null;
            newVals[f] = orgUpdates[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'org.update',
                'organization',
                id,
                req.session.user?.id || null,
                oldVals,
                newVals,
                id,
            );
        }
        // Keep the org's Stripe Customer (and thus Checkout + Billing Portal)
        // in sync with the billing address/phone/name just saved. Cloud-only,
        // fire-and-forget, non-fatal: no-op when the org has no Stripe customer.
        if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud') {
            const billingTouched = ['address', 'billingLine2', 'billingPostalCode', 'billingCity', 'billingCountry', 'phone', 'name', 'email']
                .some(f => orgUpdates[f] !== undefined);
            if (billingTouched) {
                setImmediate(() => {
                    require('../../services/stripeService').pushOrgBillingToStripe(id).catch(() => {});
                });
            }
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Organization not found' });
    }
});

router.delete('/organizations/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    // Snapshot the org row before the cascade so the audit trail captures
    // what was destroyed (the row is gone after deleteOrganization).
    let prevOrg = null;
    try { prevOrg = await userStore.getOrganization(id); } catch (_) { prevOrg = null; }
    if (await userStore.deleteOrganization(id)) {
        log.info(`[Audit] ${req.session.user?.id || 'system'} deleted organization '${id}'`);
        await userStore.logAccessAudit(
            'org.delete',
            'organization',
            id,
            req.session.user?.id || null,
            prevOrg,
            null,
            id,
        );
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Organization not found' });
    }
});

// Upload organization logo
const orgLogoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `org-logo-${req.params.id}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpeg|jpg|svg\+xml|webp)$/.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPG, SVG, WEBP images are allowed'));
        }
    }
});

router.post('/organizations/:id/logo', requireOrgAdmin('id'), orgLogoUpload.single('logo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const logoPath = `/uploads/${req.file.filename}`;
    await userStore.updateOrganization(req.params.id, { logo: logoPath });
    res.json({ success: true, logo: logoPath });
});

router.delete('/organizations/:id/logo', requireOrgAdmin('id'), async (req, res) => {
    // The logo path below is reduced to a basename under data/uploads.
    const org = await userStore.getOrganization(req.params.id); // nosemgrep: ajinabraham.njsscan.traversal.resolve_path_traversal.join_resolve_path_traversal
    if (org && org.logo) {
        // Only ever a file the upload above wrote: a stored value with `..` in it
        // must not reach outside data/uploads.
        // nosemgrep: javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
        const filePath = path.join(__dirname, '..', '..', 'data', 'uploads', path.basename(String(org.logo)));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await userStore.updateOrganization(req.params.id, { logo: '' });
    res.json({ success: true });
});

module.exports = router;
