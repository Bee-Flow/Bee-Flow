/** @typedef {import('zod').ZodBoolean} ZodBoolean */
/** @typedef {import('zod').ZodString} ZodString */
// @typecheck
const express = require('express');
const agentStore = require('../../stores/agentStore');
require('../../core/agentRuntime');
require('../../core/aiAgent');
require('../../stores/configStore');
const { requirePermission } = require('../../auth');
require('../../stores/memoryStore');
const { resolveUserOrgIds, validateSharedGroupsForOrg } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');

const userStore = require('../../stores/userStore');
require('../../stores/usageStore');
require('../../core/entitlements/limits');
require('../../core/http/sseHelpers');
const { canModifyAgent, buildCanModifyContext } = require('./crud');
// Pure, and deliberately not reached through the store facade — see the
// same import in ./usage.js.
const { unknownUsage } = require('../../stores/agent/agentUsage');
// De regel achter "Antwoordt uit het hoofd", ÉÉN keer geschreven. Studio's
// "Vraagt aandacht" (routes/studio/attentionChecks.js, bron `agentNoKb`)
// stelt dezelfde vraag aan dezelfde functie.
const { groundingOf } = require('../../core/agentRuntime/agentGrounding');
const log = require('../../telemetry/log');

// Attach the server-side edit verdict to each agent row so clients render
// read-only editors from the SAME policy the mutating endpoints enforce
// (BFSF-271). The context is prefetched once per request — no N× lookups.
async function withCanEdit(agents, userId, /** @type {import('express').Request} */ req) {
    if (!userId) return agents.map(a => ({ ...a, can_edit: false }));
    const ctx = await buildCanModifyContext(userId, req);
    return Promise.all(agents.map(async a => ({
        ...a,
        can_edit: await canModifyAgent(a, userId, req, ctx),
    })));
}

/**
 * Attach "what is this agent grounded on" to every row (A5).
 *
 * Pure — no query in it: `config` is already on the row (parseConfig), and the rule itself is a function in
 * core/agentRuntime/agentGrounding.js that Studio's "Needs attention" also calls. The card footer of the overview renders
 * "⚠ Answers from memory — connect a knowledge base" with it, WITHOUT the client overwriting the rule itself; a second implementation
 * would let the overview and the Start screen drift apart over the same agent.
 *
 * `verdict: null` means "not determinable" (an unreadable axis), and that is a THIRD value beside grounded and ungrounded. The client must
 * stay silent about that, not warn.
 *
 * NOTE which config this is: the DRAFT config, because that is what parseConfig puts on this list (getAllAgents does not project the runtime).
 * That is the same column that attentionChecks.js reads (`SELECT id, name, config`), so the two screens look at the same column and cannot
 * diverge — but it is the edited version, not necessarily what is live. For a row with `published_version > 0` the runtime serves `published_config`,
 * and that blob never leaves the store (`_stripPublishedBlobs`). The card footer is therefore silent about such rows: see `summariseCardFooter` in
 * agent-hub/…/AgentStudio/cardFooter.js, which reads `published_version` for that purpose.
 * The FIELD does remain on it — it is a fact about the draft config, and anyone who wants to read it differently (an attention list for the builder, for example)
 * may do so.
 */
function withGrounding(agents) {
    return agents.map(a => ({ ...a, grounding: groundingOf(a?.config) }));
}

/**
 * Attach "312 conversations · last used 2 minutes ago" and, on request, the
 * used-by counters, to a list of agents (A1c).
 *
 * ── ONE BATCH QUERY, NOT ONE PER ROW ────────────────────────────────
 * `getAgentStats` reads EVERY `messages_json` of an agent into Node and calls
 * `agents.updated_at` "last updated" — on a list that is one round trip per
 * agent plus a column that answers when the agent was last EDITED, in the
 * place people read as "still in use". `getAgentChatStats` is one GROUP BY
 * over the indexed `agent_conversations.agent_id`.
 *
 * ── THE USED-BY COUNTERS ARE OPT-IN ─────────────────────────────────
 * They are a pass over the automation, app and page documents, and this list is
 * fetched on load by the sidebar's recents, Cowork and three settings screens
 * that show none of it. `?usage=1` asks for them; without it the field is
 * ABSENT rather than empty, so nothing renders "used by 0" off a number
 * nobody computed.
 *
 * ── A FAILURE IS A NULL, NEVER A ZERO ───────────────────────────────
 * Neither of these may take the list down (it is how admins reach every
 * agent), and neither may claim a count it does not have: a failed stats read
 * is `stats: null`, a failed usage pass is every kind in `partial`.
 *
 * ── WHY `othersConversationCount` IS HERE AFTER ALL (A5) ────────────
 * It did not ride along when it was only a delete question. The card footer of
 * the overview needs it as EVIDENCE: the form "Only you" claims that nobody else
 * has been in this agent, and `userCount` cannot bear that — it is
 * `COUNT(DISTINCT user_id)` over ALL conversations, so one person counts just as
 * much as a colleague who conducted forty while the owner conducted none.
 * `othersConversationCount` is `COUNT(*) FILTER (WHERE user_id <> $viewer)`, so 0
 * means that there is none from anybody else. It costs no extra query: the same
 * GROUP BY, one parameter added.
 *
 * The counter is VIEWER-RELATIVE. It therefore must never be cached or reused between users.
 */
async function withListStats(agents, /** @type {import('express').Request} */ req, viewerId = null) {
    const ids = agents.map(a => a.id).filter(Boolean);
    if (ids.length === 0) return agents;

    /** @type {Map<string, { conversationCount: number; userCount: number; othersConversationCount: number; lastUsedAt: string | null; }>} */
    let stats = null;
    try {
        stats = await agentStore.getAgentChatStats(ids, { excludeUserId: viewerId || null });
    } catch (e) {
        log.warn('[agents] list chat stats unavailable:', /** @type {Error} */ (e).message);
    }

    const wantsUsage = req.query?.usage === '1' || req.query?.usage === 'true';
    /** @type {Record<string, { counts: Record<string, number>; partial: string[]; }> | null} */
    let usage = null;
    if (wantsUsage) {
        try {
            usage = await agentStore.usageCountsForAgents(ids);
        } catch (e) {
            log.warn('[agents] list usage counters unavailable:', /** @type {Error} */ (e).message);
            usage = {};
        }
    }

    return agents.map((a) => {
        const s = stats ? stats.get(a.id) : null;
        const out = {
            ...a,
            stats: s
                ? {
                    conversationCount: s.conversationCount,
                    userCount: s.userCount,
                    // Without a read viewer "from somebody else" cannot be answered: then the FILTER counts every row
                    // and a 0 here would claim "nobody else" without evidence. `null`
                    // narrows the card footer to the neutral form.
                    othersConversationCount: viewerId ? s.othersConversationCount : null,
                    lastUsedAt: s.lastUsedAt,
                }
                : null,
        };
        if (wantsUsage) out.usage = (usage && usage[a.id]) || unknownUsage();
        return out;
    });
}

const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const { bestEffort } = require('../../utils/bestEffort');

// -- What a caller may send ------------------------------------------
//
// `?usage=1` is what makes the list count messages per agent; it was read as
// `=== '1' || === 'true'`, so `usage=yes` answered the list WITHOUT the
// counters and said nothing about it -- a tab that renders "0 conversations"
// for every row reads as an empty product, not as a dropped parameter.
//
// On PATCH /:id/publish a misspelled `sharedGroups` meant "leave the sharing
// as it is" (the route reads `undefined` that way on purpose), so an agent
// published to a new group stayed shared with the old one under a 200.

/**
 * A body that also accepts no body at all: Express 5 leaves `req.body` undefined then.
 * @param {{ isPublished: import('zod').ZodOptional<ZodBoolean>; sharedGroups: import('zod').ZodOptional<import('zod').ZodNullable<import('zod').ZodArray<ZodString>>>; }} shape
 */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const USAGE_TEXT = 'usage is "1" or "0".';
const ListQuery = z.object({
    usage: z.enum(['0', '1', 'true', 'false'], { error: () => USAGE_TEXT }).optional(),
    // The Agent Hub adds ?t=<Date.now()> to dodge caches; it means nothing here.
    // Refusing it answered every Hub load with a 400, which the Hub reads as
    // "no published agents" and shows only the user's own.
    t: z.string().optional(),
}).strict();

const GROUPS_TEXT = 'sharedGroups is a list of group ids.';
const PublishBody = bodyOf({
    isPublished: z.boolean({ error: typeError({ invalid: 'isPublished is true or false.' }) }).optional(),
    // Absent means "leave the sharing as it is"; `[]` means "share with
    // nobody". The two have to stay apart, so there is no default here.
    sharedGroups: z.array(worded(GROUPS_TEXT), { error: typeError({ invalid: GROUPS_TEXT }) }).nullish(),
});

// ============ Published Agents (public access) ============

// Get all published agents (no auth required)
router.get('/published', validate({ query: ListQuery }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof ListQuery>>} */ req, res) => {
    // Get user's groups and direct org for org-scoped filtering
    const userId = req.session?.user?.id;
    let userGroups = [];
    let userDirectOrgId = null;
    if (userId) {
        const user = await userStore.getUser(userId);
        if (user) {
            userGroups = Array.isArray(user.groups) ? user.groups : (() => { try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; } })();
            userDirectOrgId = user.organizationId || null;
        }
    }
    // Admin users see all published agents
    const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';

    // Resolve allowed agent types from user's groups
    let allowedAgentTypes = [];
    if (!isAdmin && userId) {
        const allGroups = await userStore.getAllGroups();
        const agentTypeSet = new Set();
        for (const gid of userGroups) {
            const group = allGroups.find(g => g.id === gid);
            const types = group?.allowedAgentTypes || [];
            for (const t of types) agentTypeSet.add(t);
        }
        allowedAgentTypes = [...agentTypeSet];
    }
    const hasTypeRestrictions = !isAdmin && allowedAgentTypes.length > 0;

    // Resolve user org IDs ONCE for consistent filtering across all agent types
    const orgIds = isAdmin ? null : await resolveUserOrgIds(req);

    // Only load chat agents if allowed
    let allAgents = [];
    if (!hasTypeRestrictions || allowedAgentTypes.includes('chat')) {
        const agents = isAdmin ? await agentStore.getPublishedAgents() : await agentStore.getPublishedAgentsForUser(userGroups, userDirectOrgId, orgIds);
        allAgents = [...agents];
    }

    res.json(await withCanEdit(allAgents, userId, req));
});

// Get ALL agents (for Admin Dashboard). Requires manage_agents — lower-privileged
// users would otherwise see unpublished drafts owned by colleagues in their org.
router.get('/all', requirePermission('manage_agents'), validate({ query: ListQuery }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof ListQuery>>} */ req, res) => {
    let agents = await agentStore.getAllAgents();

    const orgIds = await resolveUserOrgIds(req);
    if (orgIds !== null) {
        agents = agents.filter(a => orgIds.has(a.organization_id));
    }

    const userId = getEffectiveUserId(req);
    res.json(await withListStats(withGrounding(await withCanEdit(agents, userId, req)), req, userId));
});

// Toggle agent published status + set sharing scope
router.patch('/:id/publish', validate({ body: PublishBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Ownership, super-admin bypass, the manage_agents requirement, org
    // scoping, and the agent_editor/unpublished-draft rule are all handled
    // by canModifyAgent — no extra inline permission check needed.
    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
    }

    const { isPublished, sharedGroups } = req.body;

    // Validate sharedGroups belong to the agent's org. Undefined → leave as-is.
    let cleanedGroups;
    cleanedGroups = await validateSharedGroupsForOrg(agent.organization_id, sharedGroups);

    // When flipping to published, re-validate every cross-reference in the
    // agent's config. Owner may have lost access to a referenced KB or skill
    // since the agent was drafted (group removed, KB unpublished, skill
    // deleted). Publishing a stale config would surface as 403s at runtime
    // for every consumer who tries to chat. Validate against the *owner*
    // (not the requesting user) so an org-admin publishing on behalf of a
    // demoted owner gets the right verdict.
    if (isPublished) {
        const { validateAgentConfigReferences } = require('./crud');
        if (validateAgentConfigReferences) {
            // Throws a 400 whose message names what the owner can no longer reach.
            await validateAgentConfigReferences(agent, agent.config || {});
        }
    }

    // Use agent.owner_id (not userId) so the SQL WHERE owner_id matches even when
    // a non-owner (org admin, agent admin) is toggling publish.
    const success = await agentStore.setAgentPublished(req.params.id, isPublished, agent.owner_id, cleanedGroups);

    if (!success) {
        throw new Error('Failed to update published status');
    }

    // Publishing changes the org's compliance surface (Art-50 AI disclosure,
    // Art-35 DPIA) — re-check now instead of waiting for the 6-hour sweep.
    if (isPublished) {
        try {
            const events = require('../../compliance/events');
            events.emit(events.EVENTS.AGENT_PUBLISHED, {
                orgId: agent.organization_id || 'default',
                agentId: agent.id,
            });
        } catch (err) { bestEffort('routes/agents/published:anon', err); /* compliance bus is best-effort */ }
    }

    res.json({ success: true, isPublished, sharedGroups: cleanedGroups });
});


module.exports = router;
