/**
 * GET /agents/:id/tool-lending — for which apps can this agent borrow the connection
 * of its OWNER?
 *
 * ── WHY THIS ROUTE EXISTS ───────────────────────────────────────────
 * The Tools card asked that question of itself. It read
 * `GET /api/integrations/connections/grants?resourceType=agent&resourceId=…`,
 * and that route scopes unconditionally to the LOGGED-IN user (routes/integrations/connections.js — `grantorUserId: userId`). The runtime
 * borrows from `agent.owner_id`: `toolPolicy.resolveLentProviders` is called with the owner in both places (routes/agents/crud.js in
 * `applyConfigValidation`, stores/agent/agentCrud.js in `_clampRuntimeTools`).
 *
 * As long as the editor IS the owner, those two give the same answer. But an
 * agent may also be edited by the super-admin and by every org member with
 * `manage_agents` (canModifyAgent in ./crud.js) — and then they diverge, in both directions at once:
 *
 *   the editor lent something out himself  ⇒ the screen offered "as you", the
 *                                       runtime refused it (nothing of the
 *                                       owner's was lent out);
 *   the OWNER lent something out          ⇒ the screen did not offer it, while
 *                                       the runtime WOULD lend it — and the
 *                                       card meanwhile drew "As: the
 *                                       person asking".
 *
 * So the question has to be about the owner, and the answer has to come from the server: the editor may not fill in `agent.owner_id` themselves.
 *
 * ── WHAT COMES BACK, AND WHAT DELIBERATELY DOES NOT ─────────────────
 *   `apps`            the app ids for which lending is possible. Yes/no per app, nothing more.
 *   `readable`        whether that answer could be read.
 *   `runtimeCurated`  whether the agent AS THE RUNTIME READS IT has a curated grants
 *                     map (`null` = cannot be checked).
 *
 * That last field is here because the card otherwise looked at the DRAFT. The lending notices make a claim about what the runtime does NOW, and the runtime reads `published_config` once the agent has ever been published, while the editor holds the draft that is not yet saved. One checkbox in the picker made the draft "curated" and the card immediately reported that nothing more was being lent — while the published agent went on lending for another hour. Exactly the shape this route had to remove: the screen promises one thing, the runtime does another. Whoever cannot read the answer (`null`) says nothing.
 *
 * No label, no connection id, no beneficiary, no provider. The editor does not have to be the owner, and then "which connection hangs here" is a look into someone else's integrations. The translation from providers to apps therefore happens in `toolPolicy.lentAppsFor` — the same map that `normaliseToolsConfig` uses to decide whether a saved `actAs: 'owner'` survives, so that the picker and the runtime cannot disagree.
 *
 * ── UNKNOWN NARROWS ─────────────────────────────────────────────────
 * `readable: false` means: do not offer a lending choice, and say why. It is the answer for an agent without an owner, for a probe that is broken and for an attribution that is broken — never a silent empty list, because that reads as "the owner has lent nothing", and that is a claim.
 *
 * "Lending is off" is the one case that IS a read zero: there is nothing to lend, that is a fact, and the card should not show a failure notice for it. Without that distinction every installation with the default setting (lending OFF) would permanently show "could not read it".
 *
 * ── WHY THE EDIT RIGHT ──────────────────────────────────────────────
 * Same reasoning as routes/agents/usage.js: this is an answer for the editor, and it concerns the owner's connections. Whoever may not even see the agent gets the same 404 as `GET /:id`; whoever may use it but not edit it gets the editor's 403.
 *
 * ── NO QUERY ────────────────────────────────────────────────────────
 * The route reads nothing from the query, and says so out loud: the whole reason for existing is that the editor may NOT choose whose connections the answer concerns. A `?ownerId=` or `?userId=` that seems to do that was ignored and answered about the real owner, with a 200: an answer to a different question than the one asked. Now a 400 that names the key.
 *
 * Run: cd server && node --test routes/agents/toolLending.test.js
 */

const express = require('express');
const agentStore = require('../../stores/agentStore');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { canReadAgent, canModifyAgent } = require('./crud');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');

const NoQuery = z.object({}).strict();

const router = express.Router();

/**
 * The narrow answer: nothing to lend, and that was not read.
 *
 * Frozen because it is reused per request — a shared answer that gets filled once would
 * then be told to everyone.
 */
const UNREADABLE = Object.freeze({ apps: Object.freeze([]), readable: false });

/**
 * Does the agent have a curated grants map AS THE RUNTIME READS IT?
 *
 * `getForRuntime` is the same reading that both dispatch sites do: the
 * published config if the agent is published, otherwise the live one — and clamped, because that is also what is running. `null` means "cannot be checked";
 * that is not "not curated", and the card should then say nothing about it.
 */
async function runtimeCuratedOf(agentId) {
    try {
        const runtime = await agentStore.getForRuntime(agentId);
        if (!runtime) return null;
        const policy = require('../../core/agentRuntime/toolPolicy');
        return policy.hasCuratedGrants(policy.toolsConfigOf(runtime.config)) === true;
    } catch (e) {
        log.warn('[agents/tool-lending] runtime config unreadable:', e.message);
        return null;
    }
}

/**
 * The apps for which the OWNER of this agent has lent a connection.
 *
 * Every branch that does not arrive at a read yes or no ends in `UNREADABLE`.
 * The only empty list that IS read is the disabled lending feature.
 */
async function lendableAppsFor(agent) {
    let isLendingEnabled = null;
    try {
        ({ isLendingEnabled } = require('../../core/integrations/connectionResolution'));
    } catch (e) {
        log.warn('[agents/tool-lending] connection resolution unavailable:', e.message);
        return UNREADABLE;
    }
    let enabled = false;
    try {
        enabled = isLendingEnabled() === true;
    } catch (e) {
        // A flag nobody can read is not "on", but also not a read
        // "off": the card needs to know that this answer is not reliable.
        log.warn('[agents/tool-lending] lending flag unreadable:', e.message);
        return UNREADABLE;
    }
    // Lending is off: a read zero. No database work, no notice.
    if (!enabled) return { apps: [], readable: true };

    // No owner = not possible to say whose connection this would be. That is
    // NOT "yes", and it is also no reason to then filter on the editor instead — exactly the
    // confusion this route closes.
    const ownerId = agent && agent.owner_id;
    if (!ownerId) return UNREADABLE;

    const policy = require('../../core/agentRuntime/toolPolicy');
    const lentProviders = await policy.resolveLentProviders({ agentId: agent.id, ownerId });
    // `null` = lenen stond uit (hierboven al afgevangen) of de probe faalde.
    if (!(lentProviders instanceof Set)) return UNREADABLE;

    // `null` = the app→provider map is degraded; every outcome would be a guess.
    // See toolPolicy.lentAppsFor.
    const apps = policy.lentAppsFor(lentProviders);
    if (!Array.isArray(apps)) return UNREADABLE;
    return { apps, readable: true };
}

// A failed read is a 500 from the terminal handler, never an empty answer with
// `readable: true`: the card reads a failure as "cannot be checked" and then
// offers no lending choice.
router.get('/:id/tool-lending', validate({ query: NoQuery }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    // Same 404 as GET /:id for whoever may not see the agent — "you may not"
    // and "it does not exist" should not be distinguishable.
    if (!(await canReadAgent(agent, userId, req))) {
        return res.status(404).json({ error: 'Agent not found' });
    }
    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
    }

    const [lending, runtimeCurated] = await Promise.all([
        lendableAppsFor(agent),
        runtimeCuratedOf(agent.id),
    ]);
    res.json({ ...lending, runtimeCurated });
});

module.exports = router;
