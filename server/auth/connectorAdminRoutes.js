// @typecheck
/**
 * Nextcloud Connector — admin routes
 *
 * Endpoints for super-admins (or org admins of the target org) to mint and
 * rotate the per-tenant key the Bee Flow Nextcloud connector uses to sign
 * its JWTs. The customer's NC admin pastes this key into AppAPI's app
 * settings via:
 *
 *     occ app_api:app:setenv bee_flow BEEFLOW_TENANT_KEY <key>
 *
 * Keys are stored encrypted at rest in configStore under
 * `connector_tenant_key_<orgId>` (see auth/connectorJwt.js).
 *
 * ── THE ORG ID HAS TO NAME SOMETHING ────────────────────────────────
 * A super-admin passes every org check, so a mistyped `:orgId` used to be
 * answered like a real one. POST minted a key for an organisation that does
 * not exist, and connectorJwt.js — which learns the tenant from WHICH key
 * verifies a token — then signed the customer's connector in as that phantom:
 * new users were refused with "Connector tenant has no organization", and an
 * existing user without an org had the phantom id written onto their row.
 * DELETE answered `revoked: true` for the typo while the real key, the one
 * somebody meant to kill, went on working. POST now needs an organisation that
 * exists; DELETE needs a key to revoke (a key whose organisation was since
 * deleted can still be revoked — it is exactly the one that must not linger).
 *
 * POST takes no body. It always rotates, so a key that reads like it could
 * stop that (`{ "rotate": false }`) is refused rather than ignored.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../telemetry/log');
const router = express.Router();

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { requireAuth } = require('./permissions');
const { invalidateTenantKeyCache } = require('./connectorJwt');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

/** Express 5 leaves `req.body` undefined without a body; a curl POST sends none. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

async function isOrgAdminForOrg(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user || user.orgRole !== 'org_admin') return false;
    return user.organizationId === orgId;
}

// Issue (or rotate) the tenant key for a given org. Returns the key in the
// response body — this is the ONLY moment it's visible in plaintext over
// the wire. Caller must capture it and hand it to the customer admin.
router.post('/admin/connector/tenants/:orgId/key', requireAuth, validate({ body: NoBody }), async (req, res) => {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!await isOrgAdminForOrg(req, orgId)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }
    // After the admin check, so the answer never tells a non-admin which
    // organisation ids exist.
    if (!await userStore.getOrganization(orgId)) {
        return res.status(404).json({ error: 'Organization not found' });
    }

    // 32 random bytes, base64url-encoded — long enough for HS256 with comfortable margin.
    const key = crypto.randomBytes(32).toString('base64url');
    try {
        await configStore.setSecret(TENANT_KEY_PREFIX + orgId, key);
        invalidateTenantKeyCache(orgId);
        log.info(`[ConnectorAdmin] Tenant key issued for org=${orgId} by user=${req.session.user.id}`);
        res.json({
            orgId,
            tenantKey: key,
            instructions: 'Have your Nextcloud admin run: occ app_api:app:setenv bee_flow BEEFLOW_TENANT_KEY <tenantKey>',
        });
    } catch (err) {
        log.error(`[ConnectorAdmin] Failed to mint tenant key: ${err.message}`);
        res.status(500).json({ error: 'Failed to mint tenant key' });
    }
});

// Whether a key currently exists for this org. Never returns the key
// itself — this is for the admin UI to show "Configured / Not configured".
router.get('/admin/connector/tenants/:orgId/key', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!await isOrgAdminForOrg(req, orgId)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }
    try {
        const existing = await configStore.getSecret(TENANT_KEY_PREFIX + orgId);
        res.json({ orgId, configured: !!existing });
    } catch (err) {
        log.error(`[ConnectorAdmin] Failed to read tenant key state: ${err.message}`);
        res.status(500).json({ error: 'Failed to read tenant key state' });
    }
});

router.delete('/admin/connector/tenants/:orgId/key', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    if (!await isOrgAdminForOrg(req, orgId)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }
    try {
        // Nothing to revoke is a 404, not `revoked: true`: under a typo'd org
        // id that answer left the real key alive behind a success.
        if (!await configStore.getSecret(TENANT_KEY_PREFIX + orgId)) {
            return res.status(404).json({ error: 'No tenant key is configured for this organization' });
        }
        // setSecret('') effectively clears since configStore stores empty as
        // null; deleteConfig would also work if available.
        await configStore.setSecret(TENANT_KEY_PREFIX + orgId, '');
        invalidateTenantKeyCache(orgId);
        log.info(`[ConnectorAdmin] Tenant key revoked for org=${orgId} by user=${req.session.user.id}`);
        res.json({ orgId, revoked: true });
    } catch (err) {
        log.error(`[ConnectorAdmin] Failed to revoke tenant key: ${err.message}`);
        res.status(500).json({ error: 'Failed to revoke tenant key' });
    }
});

module.exports = router;
