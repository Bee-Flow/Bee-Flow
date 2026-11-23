// @typecheck strict
/**
 * Cowork's Privacy Shield for an organisation (core/entitlements/coworkShieldFlag.js): whether the shield applies to
 * the plain prompt runs of Cowork (the runs without an agent, which call the model directly).
 *
 *   GET /api/cowork/shield/:orgId → { enabled, configured }, for a member of the organisation
 *   PUT /api/cowork/shield/:orgId → { enabled: boolean }, for an organisation admin; audited
 *
 * Mounted on routes/cowork.js's router; the admin page shows it with the organisation's Privacy Shield.
 *
 * A new organisation starts with it on; one that predates it keeps what it had (off) until an admin switches it.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, isOrgAdminForOrg } = require('../auth/permissions');
const { resolveUserOrgIds } = require('../auth');
const { validate } = require('../core/http/validate');
const { z, flag } = require('../core/http/schemaParts');
const { sessionUser } = require('../core/http/sessionUser');

const shieldFlag = () => require('../core/entitlements/coworkShieldFlag');

const ENABLED_TEXT = 'enabled is true or false.';
const ShieldBody = z.object({ enabled: flag(ENABLED_TEXT) }).strict();

router.get('/shield/:orgId', requireAuth, async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const orgIds = await resolveUserOrgIds(req);
    if (!(orgIds === null || orgIds.has(req.params.orgId))) return res.status(403).json({ error: 'Not a member of this organization' });
    res.json(await shieldFlag().resolveCoworkShieldFlag(req.params.orgId));
});

router.put('/shield/:orgId', requireAuth, validate({ body: ShieldBody }), async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdminForOrg(req, orgId))) return res.status(403).json({ error: 'Only organization admins can change this.' });
    const enabled = req.body.enabled === true;
    await shieldFlag().setCoworkShield(orgId, enabled);
    await require('../stores/userStore').logAccessAudit('cowork_shield.set', 'organization', orgId, sessionUser(req).id, null, { enabled }, orgId);
    res.json(await shieldFlag().resolveCoworkShieldFlag(orgId));
});

module.exports = router;
