// @typecheck strict
/**
 * GET /api/org-privacy-shield/:orgId/app-exemption-apps — the apps a Privacy
 * Shield per-app exception can be made for ("Exceptions per app" under the
 * kinds-of-data table; core/privacy/toolPiiExemptions.mts).
 *
 * The gate of the shield's save (routes/orgPrivacyShield.js PUT /:orgId):
 * signed in, and an admin of this organisation. The answer: the registry's
 * apps that own tool names, minus those the organisation's integration
 * availability says it does not have (when that cannot be read none are left
 * out: the save checks every app against the registry anyway), each with the
 * tool classes its tools fall in, sorted by label. Ids and labels only.
 */

const express = require('express');
const log = require('../telemetry/log');
const { requireAuth, isOrgAdminForOrg } = require('../auth/permissions');
const { sessionUser } = require('../core/http/sessionUser');
const exemptions = require('../core/privacy/toolPiiExemptions.mts');

const router = express.Router({ mergeParams: true });

/**
 * @param {string} orgId
 * @param {string | null} viewerOrgId
 */
async function exemptableAppsFor(orgId, viewerOrgId) {
    const { classifyToolClass } = require('../core/privacy/orgShield');
    /** @type {Record<string, { available?: boolean }> | null} */
    let integrations = null;
    try {
        const { resolveOrgIntegrationAvailability } = require('../usecases/integrations/orgIntegrationAvailability.mts');
        integrations = (await resolveOrgIntegrationAvailability(orgId, { organizationId: viewerOrgId })).integrations || null;
    } catch (e) {
        log.warn(`[OrgPrivacyShield] integration availability for org ${orgId} could not be read: ${/** @type {Error} */ (e).message}`);
    }
    return exemptions.listExemptableApps()
        .filter(app => integrations?.[app.id]?.available !== false)
        .map(app => ({ id: app.id, label: app.label, classes: [...new Set(app.actions.map(n => classifyToolClass(n, {})))].sort() }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

router.get('/', requireAuth, async (/** @type {import('express').Request<{ orgId: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdminForOrg(req, orgId))) {
        return res.status(403).json({ error: 'Only organization admins can manage the privacy shield' });
    }
    res.json({ apps: await exemptableAppsFor(orgId, sessionUser(req).organizationId ?? null) });
});

module.exports = router;
