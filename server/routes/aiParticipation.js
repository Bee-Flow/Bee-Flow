// @typecheck
/**
 * Settings for the AI that decides by itself when to take part in team chats
 * and comment threads (projects/participation/policy.js holds the rules and
 * the storage; this router only reads and writes them).
 *
 * GET /org/:orgId   any member of the organisation   the policy + `configured`
 * PUT /org/:orgId   an admin of that organisation    replace the policy
 * GET /me           the signed-in person             `{ autoJoinOnMyMessages }`
 * PUT /me           the signed-in person             change it
 *
 * Mounted at /api/ai-participation. Bodies are closed: a misspelled switch is
 * a 400 naming it, never a silent "saved". The switches are required on a
 * save (the whole policy is replaced), the numbers are optional and clamped
 * by the policy module, so an admin typo can never turn the caps off.
 *
 * Built by a factory so the test hands in the gates and the policy; the
 * default instance uses the real ones, required lazily.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../core/http/validate');
const { forbidden, unavailable } = require('../core/http/errors');
const { bodyOf, flag, choice } = require('../core/http/schemaParts');

const { SENSITIVITIES, RANGES } = require('../projects/participation/policy');

const count = (name) => z.number({ invalid_type_error: `${name} is a number.` }).optional();

const OrgPolicyBody = bodyOf({
    autoAllowed: flag('autoAllowed is true or false: may the AI join conversations by itself?'),
    alwaysAllowed: flag('alwaysAllowed is true or false: may a chat let the AI answer every message?'),
    commentsAutoAllowed: flag('commentsAutoAllowed is true or false: may the AI join comment threads by itself?'),
    sensitivity: choice([...SENSITIVITIES], `sensitivity is ${SENSITIVITIES.join(', ')}.`).optional(),
    ...Object.fromEntries(Object.keys(RANGES).map((key) => [key, count(key)])),
}, 'The AI participation settings');

const MyPreferenceBody = bodyOf({
    autoJoinOnMyMessages: flag('autoJoinOnMyMessages is true or false: may the AI join in after your messages?'),
}, 'Your AI participation preference');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireAuth]        Express middleware: 401 without a session
 * @param {Function} [deps.resolveUserOrgIds]  (req) => Set<orgId> | null (null = every org, a super admin)
 * @param {Function} [deps.isOrgAdmin]         (req, orgId) => boolean
 * @param {object}   [deps.policy]             policy.makePolicy() surface
 */
function makeAiParticipationRouter(deps = {}) {
    const router = express.Router();
    const requireAuth = deps.requireAuth || function requireAuth(req, res, next) {
        return require('../auth/permissions').requireAuth(req, res, next);
    };
    const resolveUserOrgIds = deps.resolveUserOrgIds || ((req) => require('../auth').resolveUserOrgIds(req));
    const isOrgAdmin = deps.isOrgAdmin || ((req, orgId) => require('../auth/permissions').isOrgAdminForOrg(req, orgId));
    const policy = () => deps.policy || require('../projects/participation/policy').defaultPolicy();

    /** The organisation's members may read its policy; a stranger may not learn it exists. */
    async function assertMember(req, orgId) {
        const orgIds = await resolveUserOrgIds(req);
        const member = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!member) throw forbidden('not_org_member', 'You are not a member of this organisation.');
    }

    router.get('/org/:orgId', requireAuth, async (req, res) => {
        const { orgId } = req.params;
        await assertMember(req, orgId);
        const current = await policy().resolveOrgPolicy(orgId);
        // Never show a guess as the saved settings: the screen must say "could not load".
        if (current.unavailable) throw unavailable('policy_unavailable', 'The AI participation settings could not be read. Try again in a moment.');
        res.json({ ...current, configured: await policy().isOrgPolicyConfigured(orgId), ranges: RANGES, sensitivities: SENSITIVITIES });
    });

    router.put('/org/:orgId', requireAuth, validate({ body: OrgPolicyBody }), async (req, res) => {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            throw forbidden('not_org_admin', 'Only an admin of this organisation can change how the AI takes part.');
        }
        const saved = await policy().saveOrgPolicy(orgId, req.body, { updatedBy: req.session?.user?.id || null });
        res.json({ ...saved, configured: true, ranges: RANGES, sensitivities: SENSITIVITIES });
    });

    router.get('/me', requireAuth, async (req, res) => {
        const pref = await policy().resolveUserPreference(req.session.user.id);
        if (pref.unavailable) throw unavailable('preference_unavailable', 'Your AI participation preference could not be read. Try again in a moment.');
        res.json({ autoJoinOnMyMessages: pref.autoJoinOnMyMessages });
    });

    router.put('/me', requireAuth, validate({ body: MyPreferenceBody }), async (req, res) => {
        res.json(await policy().saveUserPreference(req.session.user.id, req.body));
    });

    return router;
}

const router = makeAiParticipationRouter();

module.exports = router;
module.exports.makeAiParticipationRouter = makeAiParticipationRouter;
