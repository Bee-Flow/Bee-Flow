// @typecheck
/**
 * Authenticated NC binding approval endpoints.
 *
 * When the connector bootstrap detects a candidate adoption (NC admin email
 * matches an existing un-bound Bee Flow org), it does NOT bind — it creates
 * a `pending_nc_bindings` row and returns 202 to the connector. The org
 * admin must visit the SaaS UI, log in with their existing credentials, and
 * approve/deny the binding here. Only on approval is the org bound and the
 * tenantKey minted.
 *
 * This blocks the unauthenticated org-takeover path where an attacker
 * hosting a fake Nextcloud could otherwise claim a victim's email and have
 * the bootstrap silently adopt the victim's org.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { requireAuth, isOrgAdminRole } = require('./permissions');
const { invalidateTenantKeyCache } = require('./connectorJwt');
const { helpers: bootstrapHelpers } = require('./connectorBootstrap');
const orgHealth = require('../services/orgHealth'); // fire-and-forget lifecycle events

const { ensureOrgAdminUser, bindOrgToNcInstance, getOrMintTenantKey } = bootstrapHelpers;
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

function isExpired(row) {
    return row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
}

/**
 * Re-read the session user and require org-admin (or super-admin) over
 * `targetOrgId`, defaulting to the caller's own org.
 *
 * A pairing code is a BEARER CREDENTIAL — connectorBootstrap redeems it with
 * "whoever holds it gets to bind this NC instance to that specific org… the
 * code already IS the approval", which mints the org's tenantKey and can
 * promote the redeemer to org_admin. Every operation on one therefore carries
 * the same gate the generator does; the listing endpoint used to be `requireAuth`
 * alone, which handed a live code to any rank-and-file member of the org.
 *
 * The role test goes through permissions.isOrgAdminRole, not `=== 'org_admin'`:
 * accounts predating the 'admin' → 'org_admin' rename still carry orgRole
 * 'admin', getUserPermissions normalises them so they hold the `org_admin`
 * permission, and the SPA renders the pairing panel off exactly that permission
 * (OrganisationSection.jsx:275). A raw equality check here 403s the very admins
 * the panel is shown to.
 *
 * DELIBERATE CONSEQUENCE, stated because it widens access: this helper also
 * gates POST /admin/nc-bindings/generate-pairing-code, so a legacy-orgRole
 * admin can now MINT a pairing code, not just list and revoke. That is the
 * intended reading — the product treats 'admin' as an org-admin variant
 * everywhere else (permissions.ORG_ADMIN_VARIANTS, ~15 call sites) — and a
 * split where the same person may revoke a code but not issue one would be
 * the odd rule, not the safe one. loadAndAuthorize below still uses a raw
 * 'org_admin' check on approve/deny; that predates this branch and is left
 * alone rather than widened on the way past.
 *
 * @returns {Promise<{freshUser: object, orgId: string, isSuperAdmin: boolean}|null>}
 *   null when a response has already been sent.
 */
async function loadOrgAdmin(req, res, targetOrgId) {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    const freshUser = await userStore.getUser(sessionUser.id);
    if (!freshUser) { res.status(401).json({ error: 'Session user no longer exists' }); return null; }

    const orgId = String(targetOrgId || freshUser.organizationId || '').trim();
    const isSuperAdmin = !!(req.session.isAdmin || freshUser.role === 'admin');
    const isOrgAdmin = isOrgAdminRole(freshUser.orgRole) && !!orgId && freshUser.organizationId === orgId;
    if (!isSuperAdmin && !isOrgAdmin) {
        res.status(403).json({ error: 'Organization admin access required' });
        return null;
    }
    return { freshUser, orgId, isSuperAdmin };
}

async function loadAndAuthorize(req, res) {
    const id = String(req.params.id || '').trim();
    if (!id) { res.status(400).json({ error: 'Missing id' }); return null; }
    const row = await userStore.getPendingNcBinding(id);
    if (!row) { res.status(404).json({ error: 'Pending binding not found' }); return null; }

    const sessionUser = req.session?.user;
    if (!sessionUser?.id) { res.status(401).json({ error: 'Not authenticated' }); return null; }

    const freshUser = await userStore.getUser(sessionUser.id);
    if (!freshUser) { res.status(401).json({ error: 'Session user no longer exists' }); return null; }

    const isSuperAdmin = req.session.isAdmin || freshUser.role === 'admin';
    const isOrgAdmin = freshUser.orgRole === 'org_admin' && freshUser.organizationId === row.orgId;
    if (!isSuperAdmin && !isOrgAdmin) {
        res.status(403).json({ error: 'Organization admin access required' });
        return null;
    }
    return { row, freshUser };
}

// List the active pending binding for the caller's own org. Used by the SPA
// to render <NcBindingApprovalModal/>. /auth/user already surfaces the same
// row inline; this endpoint exists for direct refreshes.
router.get('/admin/nc-bindings/pending', requireAuth, async (req, res) => {
    const orgId = req.session.user?.organizationId
        || (await userStore.getUser(req.session.user.id))?.organizationId;
    if (!orgId) return res.json({ pending: null });
    const row = await userStore.getPendingNcBindingForOrg(orgId);
    if (!row || isExpired(row)) return res.json({ pending: null });
    return res.json({
        pending: {
            id: row.id,
            ncBaseUrl: row.ncBaseUrl,
            ncInstanceId: row.ncInstanceId,
            ncAdminUid: row.ncAdminUid,
            ncAdminEmail: row.ncAdminEmail,
            themingName: row.themingName,
            ncVersion: row.ncVersion,
            expiresAt: row.expiresAt,
        },
    });
});

router.post('/admin/nc-bindings/:id/approve', requireAuth, async (req, res) => {
    const ctx = await loadAndAuthorize(req, res);
    if (!ctx) return;
    const { row, freshUser } = ctx;

    if (row.status !== 'pending') {
        return res.status(409).json({ error: `Binding is ${row.status}` });
    }
    if (isExpired(row)) {
        try { await userStore.expirePendingNcBindings(); } catch (_) { }
        return res.status(410).json({ error: 'Pending binding expired' });
    }

    const org = await userStore.getOrganization(row.orgId);
    if (!org) return res.status(404).json({ error: 'Organization no longer exists' });
    if (org.nc_instance_id && org.nc_instance_id !== row.ncInstanceId) {
        return res.status(409).json({ error: 'Organization is already bound to a different NC instance' });
    }

    let boundOrg = org;
    if (!org.nc_instance_id) {
        boundOrg = await bindOrgToNcInstance(org, {
            ncInstanceId: row.ncInstanceId,
            ncBaseUrl: row.ncBaseUrl,
            ncAdminUid: row.ncAdminUid,
            connectorCallbackUrl: row.connectorCallbackUrl,
        });
    }

    try {
        await ensureOrgAdminUser(boundOrg, {
            ncAdminEmail: row.ncAdminEmail,
            ncAdminUid: row.ncAdminUid,
            ncAdminDisplayName: row.ncAdminDisplayName,
        });
    } catch (e) {
        if (e.statusCode === 409) return res.status(409).json({ error: e.message });
        throw e;
    }

    const tenantKey = await getOrMintTenantKey(boundOrg.id);
    await userStore.markPendingNcBindingApproved(row.id, freshUser.id);

    log.info(`[NcBindingRoutes] Approved binding ${row.id} → org ${boundOrg.id} by user ${freshUser.id}`);
    orgHealth.event('binding.approved', {
        orgId: boundOrg.id, actorUserId: freshUser.id, actorKind: 'admin', req,
        meta: { bindingId: row.id, ncInstanceId: row.ncInstanceId },
    });
    return res.json({
        tenantKey,
        organizationId: boundOrg.id,
        organizationName: boundOrg.name,
        isAdopted: true,
    });
});

// ── Pairing-code branch (Phase 2 Branch B) ──
//
// Email-auto-match (Branch A above) only fires when the NC admin's email is
// already registered as an org_admin in Bee Flow. The pairing-code branch
// covers the case where it isn't — for example, the NC admin is an IT person
// and the Bee Flow account-holder is somebody from procurement.
//
// Flow:
//   1. Org admin in Bee Flow generates a code (this endpoint). 15-min TTL.
//   2. Code is handed off out-of-band (Slack, ticket, in person).
//   3. Whoever installs Bee Flow on the new NC sets BEEFLOW_PAIRING_CODE via
//      occ/AppAPI before first boot (or by uninstall+reinstall after setting).
//   4. Connector includes the code as an X-Beeflow-Pairing-Code header on its
//      /auth/connector/bootstrap call.
//   5. SaaS validates the code in connectorBootstrap.js and binds + returns
//      tenantKey directly — no separate approval step (the code IS the
//      approval).
const ORG_TEXT = 'organizationId required';
// Optional: absent means "my own organisation". A mis-spelled key used to mean
// the same thing silently, so a super-admin minting a pairing code FOR another
// tenant got one for their own instead, and the code looked identical.
const PairingCodeBody = z.object({
    organizationId: worded(ORG_TEXT).trim().min(1, ORG_TEXT).max(200, ORG_TEXT).optional(),
}).strict();

router.post('/admin/nc-bindings/generate-pairing-code', requireAuth, validate({ body: PairingCodeBody }), async (req, res) => {
    // Nextcloud self-pairing is available on self-hosted installs.
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) return res.status(401).json({ error: 'Not authenticated' });
    const preUser = await userStore.getUser(sessionUser.id);
    if (!preUser) return res.status(401).json({ error: 'Session user no longer exists' });

    const targetOrgId = String(req.body.organizationId || preUser.organizationId || '').trim();
    if (!targetOrgId) return res.status(400).json({ error: 'organizationId required' });

    const ctx = await loadOrgAdmin(req, res, targetOrgId);
    if (!ctx) return;
    const { freshUser } = ctx;

    const code = await userStore.createOrgPairingCode(targetOrgId, {
        mintedByUserId: freshUser.id,
        ttlSeconds: 15 * 60,
    });
    log.info(`[NcBindingRoutes] Pairing code minted for org=${targetOrgId} by user=${freshUser.id} expiresAt=${code.expiresAt}`);
    // Lifecycle event — never the code itself, only its expiry.
    orgHealth.event('binding.pairing_code_generated', {
        orgId: targetOrgId, actorUserId: freshUser.id, actorKind: 'admin', req,
        meta: { expiresAt: code.expiresAt },
    });
    return res.json({
        code: code.pairingCode,
        expiresAt: code.expiresAt,
        id: code.id,
    });
});

router.get('/admin/nc-bindings/pairing-codes', requireAuth, async (req, res) => {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) return res.status(401).json({ error: 'Not authenticated' });
    const preUser = await userStore.getUser(sessionUser.id);
    if (!preUser) return res.status(401).json({ error: 'Session user no longer exists' });
    // An account with no organisation has no codes to show either way; answer
    // the empty list rather than a 403 so the panel renders as it always did.
    if (!preUser.organizationId) return res.json({ codes: [] });

    // The code itself is returned below, so this is a credential read.
    const ctx = await loadOrgAdmin(req, res);
    if (!ctx) return;
    const orgId = ctx.orgId;
    if (!orgId) return res.json({ codes: [] });
    const codes = await userStore.getActivePairingCodesForOrg(orgId);
    return res.json({
        codes: codes.map(c => ({
            id: c.id,
            code: c.pairingCode,
            expiresAt: c.expiresAt,
            createdAt: c.createdAt,
        })),
    });
});

router.delete('/admin/nc-bindings/pairing-codes/:id', requireAuth, async (req, res) => {
    // Revoking is org-scoped (deletePairingCode filters on the org), so this is
    // not a cross-tenant issue — but letting any member revoke the admin's
    // outstanding code is a denial of the pairing workflow.
    const ctx = await loadOrgAdmin(req, res);
    if (!ctx) return;
    const { freshUser } = ctx;
    const ok = await userStore.deletePairingCode(req.params.id, freshUser.organizationId);
    if (!ok) return res.status(404).json({ error: 'Pairing code not found' });
    log.info(`[NcBindingRoutes] Pairing code ${req.params.id} revoked by user=${freshUser.id}`);
    return res.json({ ok: true });
});

router.post('/admin/nc-bindings/:id/deny', requireAuth, async (req, res) => {
    const ctx = await loadAndAuthorize(req, res);
    if (!ctx) return;
    const { row, freshUser } = ctx;
    if (row.status !== 'pending') {
        return res.status(409).json({ error: `Binding is ${row.status}` });
    }
    await userStore.markPendingNcBindingDenied(row.id, freshUser.id);
    log.info(`[NcBindingRoutes] Denied binding ${row.id} for org ${row.orgId} by user ${freshUser.id}`);
    orgHealth.event('binding.denied', {
        orgId: row.orgId, actorUserId: freshUser.id, actorKind: 'admin', req,
        meta: { bindingId: row.id, ncInstanceId: row.ncInstanceId },
    });
    return res.json({ status: 'denied' });
});

// ── Global-admin: remove an organisation's Nextcloud association ──
//
// Clears the NC binding fields on the org, revokes the per-org tenant key (so
// the disconnected connector can no longer mint valid JWTs) and drops the
// in-memory key cache so it takes effect immediately. The organisation itself
// is kept — to delete it entirely use DELETE /auth/organizations/:id. This is
// super-admin only: it severs connector login for every user of the org, which
// is beyond an org admin's remit, and it must work on orgs the caller isn't a
// member of (e.g. cleaning up an orphaned auto-provisioned org).
router.delete('/admin/nc-bindings/org/:orgId', requireAuth, async (req, res) => {
    const sessionUser = req.session?.user;
    if (!sessionUser?.id) return res.status(401).json({ error: 'Not authenticated' });
    const freshUser = await userStore.getUser(sessionUser.id);
    if (!freshUser) return res.status(401).json({ error: 'Session user no longer exists' });
    const isSuperAdmin = req.session.isAdmin || freshUser.role === 'admin';
    if (!isSuperAdmin) return res.status(403).json({ error: 'Global administrator access required' });

    const orgId = String(req.params.orgId || '').trim();
    if (!orgId) return res.status(400).json({ error: 'Missing orgId' });

    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.nc_instance_id) {
        return res.status(409).json({ error: 'Organization is not bound to a Nextcloud instance', code: 'not_bound' });
    }

    const before = { ncInstanceId: org.nc_instance_id, ncBaseUrl: org.nc_base_url, ncAdminUid: org.nc_admin_uid };

    const updates = {
        ncInstanceId: null,
        ncBaseUrl: null,
        ncAdminUid: null,
        ncProvisionedAt: null,
        connectorCallbackUrl: null,
        ncOnboardingCompletedAt: null,
    };
    if (org.authMethod === 'nextcloud_connector') updates.authMethod = null;
    await userStore.updateOrganization(orgId, updates);

    // Revoke the per-org tenant key + drop the cache so the severed connector
    // can't keep authenticating with a still-valid (cached) JWT key.
    try {
        await configStore.deleteConfig(`connector_tenant_key_${orgId}`, { orgId, userId: freshUser.id });
    } catch (e) { log.warn('[NcBindingRoutes] tenant key revoke failed:', e.message); }
    invalidateTenantKeyCache(orgId);

    try {
        await userStore.logAccessAudit('org.nc_binding.remove', 'organization', orgId, freshUser.id, before, null, orgId);
    } catch (_) { /* audit is best-effort */ }

    log.info(`[NcBindingRoutes] NC binding removed from org=${orgId} (was ncInstance=${before.ncInstanceId}) by super-admin ${freshUser.id}`);
    orgHealth.event('binding.removed', {
        orgId, actorUserId: freshUser.id, actorKind: 'admin', req,
        meta: { ncInstanceId: before.ncInstanceId },
    });
    return res.json({ ok: true, organizationId: orgId });
});

module.exports = router;
