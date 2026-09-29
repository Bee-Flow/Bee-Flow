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
async function withCanEdit(agents, userId, req) {
    if (!userId) return agents.map(a => ({ ...a, can_edit: false }));
    const ctx = await buildCanModifyContext(userId, req);
    return Promise.all(agents.map(async a => ({
        ...a,
        can_edit: await canModifyAgent(a, userId, req, ctx),
    })));
}

/**
 * Attach "waar is deze agent op gegrond" to every row (A5).
 *
 * Puur — geen query erbij: `config` staat al op de rij (parseConfig), en de
 * regel zelf is een functie in core/agentRuntime/agentGrounding.js die Studio's
 * "Vraagt aandacht" ook aanroept. De kaartvoet van het overzicht rendert
 * hiermee "⚠ Antwoordt uit het hoofd — koppel een kennisbank" ZONDER de regel
 * client-side over te schrijven; een tweede implementatie zou het overzicht
 * en het Start-scherm over dezelfde agent uit elkaar laten lopen.
 *
 * `verdict: null` betekent "niet vast te stellen" (een onleesbare as), en dat
 * is een DERDE waarde naast gegrond en ongegrond. De client moet daarop
 * zwijgen, niet waarschuwen.
 *
 * LET OP welke config dit is: de CONCEPT-config, want dat is wat parseConfig
 * op deze lijst zet (getAllAgents projecteert de runtime niet). Dat is
 * hetzelfde vak dat attentionChecks.js leest (`SELECT id, name, config`), dus
 * de twee schermen kijken naar dezelfde kolom en kunnen niet uiteenlopen —
 * maar het is de bewerkte versie, niet per se wat live draait. Voor een rij met
 * `published_version > 0` serveert de runtime `published_config`, en die blob
 * verlaat de store nooit (`_stripPublishedBlobs`). De kaartvoet zwijgt daarom
 * over zulke rijen: zie `summariseCardFooter` in
 * agent-hub/…/AgentStudio/cardFooter.js, dat `published_version` erbij leest.
 * Het VELD blijft er wel op staan — het is een feit over de concept-config, en
 * wie het anders wil lezen (een aandachtslijst voor de bouwer, bijvoorbeeld)
 * mag dat.
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
 * They are a pass over the routine, app and page documents, and this list is
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
 * ── WAAROM `othersConversationCount` HIER WÉL OP STAAT (A5) ─────────
 * Het reed hier bewust niet mee toen het alleen een verwijder-vraag was. De
 * kaartvoet van het overzicht heeft het nodig als BEWIJS: de vorm "Only you"
 * beweert dat niemand anders in deze agent gezeten heeft, en `userCount` kan
 * dat niet dragen — dat is `COUNT(DISTINCT user_id)` over ALLE gesprekken, dus
 * één telt net zo goed als een collega die er veertig voerde terwijl de
 * eigenaar er nul voerde. `othersConversationCount` is `COUNT(*) FILTER
 * (WHERE user_id <> $viewer)`, dus 0 betekent er staat er geen van iemand
 * anders. Het kost geen extra query: dezelfde GROUP BY, één parameter erbij.
 *
 * De teller is DE KIJKER-relatief. Hij hoort daarom nooit gecachet of tussen
 * gebruikers hergebruikt te worden.
 */
async function withListStats(agents, req, viewerId = null) {
    const ids = agents.map(a => a.id).filter(Boolean);
    if (ids.length === 0) return agents;

    let stats = null;
    try {
        stats = await agentStore.getAgentChatStats(ids, { excludeUserId: viewerId || null });
    } catch (e) {
        log.warn('[agents] list chat stats unavailable:', e.message);
    }

    const wantsUsage = req.query?.usage === '1' || req.query?.usage === 'true';
    let usage = null;
    if (wantsUsage) {
        try {
            usage = await agentStore.usageCountsForAgents(ids);
        } catch (e) {
            log.warn('[agents] list usage counters unavailable:', e.message);
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
                    // Zonder een gelezen kijker is "van iemand anders" niet te
                    // beantwoorden: dan telt de FILTER elke rij mee en zou een
                    // 0 hier "niemand anders" beweren zonder bewijs. `null`
                    // versmalt de kaartvoet naar de neutrale vorm.
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
const { z } = require('zod');

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

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const USAGE_TEXT = 'usage is "1" or "0".';
const ListQuery = z.object({
    usage: z.enum(['0', '1', 'true', 'false'], { errorMap: () => ({ message: USAGE_TEXT }) }).optional(),
    // The Agent Hub adds ?t=<Date.now()> to dodge caches; it means nothing here.
    // Refusing it answered every Hub load with a 400, which the Hub reads as
    // "no published agents" and shows only the user's own.
    t: z.string().optional(),
}).strict();

const GROUPS_TEXT = 'sharedGroups is a list of group ids.';
const PublishBody = bodyOf({
    isPublished: z.boolean({ invalid_type_error: 'isPublished is true or false.' }).optional(),
    // Absent means "leave the sharing as it is"; `[]` means "share with
    // nobody". The two have to stay apart, so there is no default here.
    sharedGroups: z.array(worded(GROUPS_TEXT), { invalid_type_error: GROUPS_TEXT }).nullish(),
});

// ============ Published Agents (public access) ============

// Get all published agents (no auth required)
router.get('/published', validate({ query: ListQuery }), async (req, res) => {
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
router.get('/all', requirePermission('manage_agents'), validate({ query: ListQuery }), async (req, res) => {
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
    // by canModifyAgent (BFSF-271) — no extra inline permission check needed.
    if (!(await canModifyAgent(agent, userId, req))) {
        return res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
    }

    const { isPublished, sharedGroups } = req.body;

    // Validate sharedGroups belong to the agent's org. Undefined → leave as-is.
    let cleanedGroups;
    try {
        cleanedGroups = await validateSharedGroupsForOrg(agent.organization_id, sharedGroups);
    } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
    }

    // When flipping to published, re-validate every cross-reference in the
    // agent's config. Owner may have lost access to a referenced KB or skill
    // since the agent was drafted (group removed, KB unpublished, skill
    // deleted). Publishing a stale config would surface as 403s at runtime
    // for every consumer who tries to chat. Validate against the *owner*
    // (not the requesting user) so an org-admin publishing on behalf of a
    // demoted owner gets the right verdict.
    if (isPublished) {
        try {
            const { validateAgentConfigReferences } = require('./crud');
            if (validateAgentConfigReferences) {
                await validateAgentConfigReferences(agent, agent.config || {});
            }
        } catch (e) {
            return res.status(e.status || 400).json({ error: e.message });
        }
    }

    // Use agent.owner_id (not userId) so the SQL WHERE owner_id matches even when
    // a non-owner (org admin, agent admin) is toggling publish.
    const success = await agentStore.setAgentPublished(req.params.id, isPublished, agent.owner_id, cleanedGroups);

    if (!success) {
        return res.status(500).json({ error: 'Failed to update published status' });
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
        } catch (_) { /* compliance bus is best-effort */ }
    }

    res.json({ success: true, isPublished, sharedGroups: cleanedGroups });
});


module.exports = router;
