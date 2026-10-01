// @typecheck
/**
 * The organisation setting "Update mappings automatically when an automation
 * is opened" (M8b of the data-mapping work; automation/mappingSettings.js
 * holds the rule and the storage, this router only reads and writes it).
 *
 * GET /:orgId   any member of the organisation   `{ autoUpgradeOnOpen, configured }`
 *               (503 when the setting cannot be read: never a default shown as saved)
 * PUT /:orgId   an admin of that organisation    `{ autoUpgradeOnOpen }` → the same shape
 *
 * Mounted at /api/org-automation-mappings, next to the other org settings.
 * The body is closed and the switch is required: a misspelled key or the
 * STRING "true" is a 400, never a silent "saved" (and never an ON).
 *
 * Built by a factory so the test hands in the gates and the settings; the
 * default instance uses the real ones, required lazily.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../core/http/validate');
const { forbidden, unavailable } = require('../core/http/errors');
const { bodyOf } = require('../core/http/schemaParts');

const SWITCH_TEXT = 'autoUpgradeOnOpen is true or false: update the mappings of an automation when someone who may edit it opens it?';

const SettingBody = bodyOf({
    autoUpgradeOnOpen: z.boolean({ required_error: SWITCH_TEXT, invalid_type_error: SWITCH_TEXT }),
}, 'The mapping update setting');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireAuth]        Express middleware: 401 without a session
 * @param {Function} [deps.resolveUserOrgIds]  (req) => Set<orgId> | null (null = every org, a super admin)
 * @param {Function} [deps.isOrgAdmin]         (req, orgId) => boolean
 * @param {object}   [deps.settings]           automation/mappingSettings surface
 * @param {Function} [deps.getConfig]          configStore.getConfig: the stored row, read fresh by GET
 */
function makeOrgAutomationMappingsRouter(deps = {}) {
    const router = express.Router();
    const requireAuth = deps.requireAuth || function requireAuth(req, res, next) {
        return require('../auth/permissions').requireAuth(req, res, next);
    };
    const resolveUserOrgIds = deps.resolveUserOrgIds || ((req) => require('../auth').resolveUserOrgIds(req));
    const isOrgAdmin = deps.isOrgAdmin || ((req, orgId) => require('../auth/permissions').isOrgAdminForOrg(req, orgId));
    const settings = () => deps.settings || require('../automation/mappingSettings');
    const getConfig = deps.getConfig || ((key) => require('../stores/configStore').getConfig(key));

    /** The organisation's members may read its setting; a stranger may not learn it exists. */
    async function assertMember(req, orgId) {
        const orgIds = await resolveUserOrgIds(req);
        const member = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!member) throw forbidden('not_org_member', 'You are not a member of this organisation.');
    }

    router.get('/:orgId', requireAuth, async (req, res) => {
        const { orgId } = req.params;
        await assertMember(req, orgId);
        const s = settings();
        // The stored row itself, not the memoised answer: the engine falls
        // back to OFF when the read fails, but a settings screen must say
        // "could not load", never show a guess as saved.
        let stored;
        try {
            stored = await getConfig(`${s.CONFIG_KEY_PREFIX}${orgId}`);
        } catch {
            throw unavailable('mapping_settings_unavailable', 'The mapping update setting could not be read. Try again in a moment.');
        }
        res.json({ ...s.normalizeMappingSettings(stored), configured: !!stored });
    });

    router.put('/:orgId', requireAuth, validate({ body: SettingBody }), async (req, res) => {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            throw forbidden('not_org_admin', 'Only an admin of this organisation can change this setting.');
        }
        const saved = await settings().saveMappingSettings(orgId, { autoUpgradeOnOpen: req.body.autoUpgradeOnOpen }, req.session?.user?.id || null);
        res.json({ ...saved, configured: true });
    });

    return router;
}

const router = makeOrgAutomationMappingsRouter();

module.exports = router;
module.exports.makeOrgAutomationMappingsRouter = makeOrgAutomationMappingsRouter;
