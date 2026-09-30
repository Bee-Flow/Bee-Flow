// @typecheck
/**
 * The organisation switch for real-time co-editing of project notebooks and
 * pages (core/collab/settings.js holds the rule and the storage; this router
 * only reads and writes it).
 *
 * GET /:orgId   any member of the organisation   `{ collabEnabled, serverDisabled, configured }`
 *               (503 when the setting cannot be read: never a default shown as saved)
 * PUT /:orgId   an admin of that organisation    `{ collabEnabled }` → the same shape
 *
 * Mounted at /api/org-collab, next to /api/org-ai-context. The body is
 * closed and the switch is required: a misspelled key or the STRING "false"
 * is a 400, never a silent "saved". `serverDisabled` is the operator's kill
 * switch (COLLAB_ENABLED=0): co-editing is off whatever the organisation
 * says, so the screen can show the switch disabled instead of lying.
 *
 * Switching it off folds every co-edited document of the organisation back
 * into its notebook or page in the background (saveCollabSettings); nothing
 * is lost, open editors fall back to single-writer saves.
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

const SWITCH_TEXT = 'collabEnabled is true or false: may members edit project notebooks and pages together in real time?';

const CollabBody = bodyOf({
    collabEnabled: z.boolean({ required_error: SWITCH_TEXT, invalid_type_error: SWITCH_TEXT }),
}, 'The co-editing setting');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireAuth]        Express middleware: 401 without a session
 * @param {Function} [deps.resolveUserOrgIds]  (req) => Set<orgId> | null (null = every org, a super admin)
 * @param {Function} [deps.isOrgAdmin]         (req, orgId) => boolean
 * @param {object}   [deps.settings]           core/collab/settings surface
 * @param {Function} [deps.getConfig]          configStore.getConfig: the stored row, read fresh by GET
 */
function makeOrgCollabRouter(deps = {}) {
    const router = express.Router();
    const requireAuth = deps.requireAuth || function requireAuth(req, res, next) {
        return require('../auth/permissions').requireAuth(req, res, next);
    };
    const resolveUserOrgIds = deps.resolveUserOrgIds || ((req) => require('../auth').resolveUserOrgIds(req));
    const isOrgAdmin = deps.isOrgAdmin || ((req, orgId) => require('../auth/permissions').isOrgAdminForOrg(req, orgId));
    const settings = () => deps.settings || require('../core/collab/settings');
    const getConfig = deps.getConfig || ((key) => require('../stores/configStore').getConfig(key));

    /** The organisation's members may read its switch; a stranger may not learn it exists. */
    async function assertMember(req, orgId) {
        const orgIds = await resolveUserOrgIds(req);
        const member = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!member) throw forbidden('not_org_member', 'You are not a member of this organisation.');
    }

    /** @param {{ collab_enabled: boolean }} current @param {boolean} configured */
    function answer(current, configured) {
        return {
            collabEnabled: current.collab_enabled,
            serverDisabled: settings().killSwitchOn(),
            configured,
        };
    }

    router.get('/:orgId', requireAuth, async (req, res) => {
        const { orgId } = req.params;
        await assertMember(req, orgId);
        const s = settings();
        // Read the stored row itself, not the memoised answer: the engine
        // falls back to the default when the read fails, but a settings
        // screen must say "could not load", never show a guess as saved.
        let stored;
        try {
            stored = await getConfig(`${s.CONFIG_KEY_PREFIX}${orgId}`);
        } catch {
            throw unavailable('collab_settings_unavailable', 'The co-editing setting could not be read. Try again in a moment.');
        }
        res.json(answer(s.normalizeSettings(stored), !!stored));
    });

    router.put('/:orgId', requireAuth, validate({ body: CollabBody }), async (req, res) => {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            throw forbidden('not_org_admin', 'Only an admin of this organisation can switch co-editing on or off.');
        }
        const saved = await settings().saveCollabSettings(orgId, { collab_enabled: req.body.collabEnabled });
        res.json(answer(saved, true));
    });

    return router;
}

const router = makeOrgCollabRouter();

module.exports = router;
module.exports.makeOrgCollabRouter = makeOrgCollabRouter;
