/**
 * Which agents may call an agent_call automation (automation/agentBinding.js).
 *
 *   GET /:id/agent-bindings   the linked agents as THIS viewer may see them, and
 *                             the agents they may link
 *   PUT /:id/agent-bindings   make the given agents the set of editable agents
 *                             that are linked
 *   GET /by-agent/:agentId/automation-ids
 *                             the automations linked to an agent the viewer may edit
 *
 * Every rule lives in automation/agentBinding.js; this file reads the request,
 * loads the automation and answers. Refusals are HttpErrors thrown there.
 *
 * Deliberately NOT part of PUT /:id (the definition save): a grant must not be
 * something a definition can carry, so the editor saves it through this route
 * and the definition's own save never sees it.
 *
 * Built by a factory so a test can hand in its own store, access and gate; the
 * default router uses the real ones, required lazily.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { closedObject } = require('../../core/http/schemaParts');
const { HttpError } = require('../../core/http/errors');
const { makeAutomationAccess } = require('../../automation/access');

const AGENT_IDS_TEXT = 'agentIds is the list of agents that may call this automation, [] for none.';
const BindingsBody = closedObject({
    agentIds: z.array(
        z.string({ required_error: AGENT_IDS_TEXT, invalid_type_error: AGENT_IDS_TEXT }).trim().min(1, AGENT_IDS_TEXT).max(200, AGENT_IDS_TEXT),
        { required_error: AGENT_IDS_TEXT, invalid_type_error: AGENT_IDS_TEXT },
    ).max(50, 'At most 50 agents can call one automation.'),
}, 'Linking agents');

/**
 * @param {object} [overrides]
 * @param {object} [overrides.store]        automationStore surface
 * @param {object} [overrides.binding]      the automation/agentBinding.js surface
 * @param {object} [overrides.agentStore]   agent store surface (getForRuntime, getAgents, ...)
 * @param {object} [overrides.userStore]    { getUser }
 * @param {object} [overrides.agentAccess]  { buildCanModifyContext, canModifyAgent }
 * @param {Function} [overrides.getUser]    (id) => user row
 * @param {Function} [overrides.hasPermission] (userId, perm, session) => bool
 */
function makeAgentBindingsRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const binding = () => overrides.binding || require('../../automation/agentBinding');
    const access = makeAutomationAccess({
        store: overrides.store,
        ...(overrides.getUser ? { getUser: overrides.getUser } : {}),
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });
    // The binding module reads the caller's role itself; give it the same access
    // object this router guards with, so one set of overrides covers both.
    const deps = () => ({
        access,
        ...(overrides.store ? { store: overrides.store } : {}),
        ...(overrides.agentStore ? { agentStore: overrides.agentStore } : {}),
        ...(overrides.userStore ? { userStore: overrides.userStore } : {}),
        ...(overrides.agentAccess ? { agentAccess: overrides.agentAccess } : {}),
    });

    async function loadAutomation(req, res, need) {
        const a = await store().getAutomation(req.params.id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return null; }
        if (!(await access.guard(req, res, a, need))) return null;
        return a;
    }

    router.get('/:id/agent-bindings', async (req, res) => {
        const a = await loadAutomation(req, res, 'view');
        if (!a) return;
        res.json(await binding().describeBindings({
            automation: a, viewerId: req.session.user.id, session: req.session, deps: deps(),
        }));
    });

    // The other direction, for the agent editor: which automations are linked to
    // THIS agent. Three segments, so it cannot shadow a `/:id/...` route.
    router.get('/by-agent/:agentId/automation-ids', async (req, res) => {
        const automationIds = await binding().linkedAutomationIds({
            agentId: req.params.agentId, viewerId: req.session.user.id, session: req.session, deps: deps(),
        });
        if (!automationIds) throw new HttpError(404, 'not_found', 'Not found');
        res.json({ automationIds });
    });

    router.put('/:id/agent-bindings', validate({ body: BindingsBody }), async (req, res) => {
        const a = await store().getAutomation(req.params.id);
        if (!a) throw new HttpError(404, 'not_found', 'Not found');
        // The gate decides edit rights on the automation and on each agent; a
        // viewer without any role at all is told the same as one without edit.
        const result = await binding().setAgentBindings({
            automation: a, agentIds: req.body.agentIds, actorId: req.session.user.id, session: req.session, deps: deps(),
        });
        const view = await binding().describeBindings({
            automation: a, viewerId: req.session.user.id, session: req.session, deps: deps(),
        });
        res.json({ ...view, kept: result.kept });
    });

    return router;
}

module.exports = { makeAgentBindingsRouter, BindingsBody };
