/**
 * The AI step editor's two previews (moved out of catalog.js, handoff 5):
 *   GET /catalog/agent/:agentId  what an agent brings to THIS step
 *   GET /catalog/skill/:skillId  a skill's output contract
 * Registered on the catalog router at the same position they always had, so
 * the route table keeps its order. The descriptions themselves live in
 * agentStepCatalog.js.
 */

'use strict';

const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { resolveIntegration } = require('../../core/integrations/integrationToolMap');

// -- What the agent-preview query may say ----------------------------
//
// The three permission switches were read as `v === '1' || v === 'true'`, so
// every other spelling -- `startAutomations=yes`, `=on`, `=True` -- read as
// OFF and the capsule drew an agent with fewer rights than the author had
// just granted it, under a 200. A misspelled switch name did the same thing
// and left no trace at all.
//
// `tools` keeps its two distinct empty states, which the editor relies on:
// ABSENT means the author set no allowlist, `tools=` (empty) means the author
// set an empty one, and execAi reads that as NO tools. So it is a string that
// may be empty -- never `.min(1)`.
const FLAG_TEXT = (name) => `${name} is "1" or "0".`;
const flag = (name) => z.enum(['0', '1', 'true', 'false'], { errorMap: () => ({ message: FLAG_TEXT(name) }) }).optional();
const AgentPreviewQuery = z.object({
    startAutomations: flag('startAutomations'),
    useKnowledge: flag('useKnowledge'),
    useTools: flag('useTools'),
    tools: z.string({ invalid_type_error: 'tools is a comma-separated list of tool names.' }).optional(),
    // Handoff 5: the step's own skills and the agent skills it switched off,
    // so the preview applies the same skill grants the run does.
    skillIds: z.string({ invalid_type_error: 'skillIds is a comma-separated list of skill ids.' }).optional(),
    disabledAgentSkillIds: z.string({ invalid_type_error: 'disabledAgentSkillIds is a comma-separated list of skill ids.' }).optional(),
}).strict();

/** A comma-separated id list from the query; absent reads as none. */
const idList = (v) => (typeof v === 'string' ? v.split(',').map((n) => n.trim()).filter(Boolean) : []);

/** The step editor's readers, required only when a preview asks for them. */
function agentStepDeps() {
    return {
        get kbStore() { return require('../../stores/knowledgeBases'); },
        get kbVisibility() { return require('../../core/kb/kbVisibility'); },
        get skillStore() { return require('../../stores/skillStore'); },
        resolveIntegration,
        log,
    };
}

function registerAgentStepRoutes(router) {
    /**
     * What an agent would actually bring to THIS ai_step — the honest version of
     * the permission capsule in the step editor (R2).
     *
     * ── WHY THE SERVER ANSWERS THIS AND NOT THE EDITOR ──────────────────
     * "Which of this agent's tools are held back because they would ask a person
     * first" is a question only core/agentRuntime/toolPolicy.js can answer: it
     * depends on the tool registry, on the agent's per-action grants, and on the
     * `sends ⇒ ask` floor that no stored config can talk its way out of. An editor
     * that re-derived it from `catalog.apps[].effect` would be a second copy of the
     * rights layer living in the browser — and the copy that drifts is always the
     * one nobody looks at. So this route runs the SAME functions the run does
     * (aiStepAgent.agentToolsForStep) and returns names.
     *
     * ── THE SUBTRACTION IS SHOWN, NEVER SILENT ──────────────────────────
     * `withheld` is the whole point. An automation runs unattended, so a tool that
     * would draw a confirmation card in chat cannot run here — and an author who
     * is not told that believes their agent does in this step exactly what it does
     * in a conversation. Each name carries WHY, and the WHY is the one the gate
     * recorded rather than one re-derived here:
     *   `permission`   a switch on this very screen is off — flip it, no approval
     *                  step will do anything;
     *   `confirm`      a person would have to approve it (put an approval step
     *                  after this one);
     *   `unavailable`  the agent's grants, an app an agent can never be granted,
     *                  or a tool registry that cannot say which app owns the name.
     *
     * ── ONE ANSWER FOR EVERY WAY OF NOT-MAY ─────────────────────────────
     * The id comes from the client, so a refusal says only `canUse: false`.
     * Deleted, never published, another organisation, not shared: one answer, for
     * the reason automation/agentCatalog.js gives at length. The PICKER may name
     * the reason (it lists only agents the caller can already see); this route
     * cannot, because it will answer about any id it is handed.
     */
    router.get('/catalog/agent/:agentId', validate({ query: AgentPreviewQuery }), async (req, res) => {
        const yes = (v) => v === '1' || v === 'true';
        const permissions = {
            startAutomations: yes(req.query.startAutomations),
            useKnowledge: yes(req.query.useKnowledge),
            useTools: yes(req.query.useTools),
        };
        // `step.tools` as the editor holds it, so the capsule counts what the RUN
        // would offer and not what the agent could bring in principle. An explicit
        // array is an allowlist and `[]` means NO tools (execAi reads it that way),
        // so the two states have to stay apart on the wire: `tools` absent = the
        // author set none, `tools=` (empty) = the author set an empty list.
        const allowList = (typeof req.query.tools === 'string')
            ? req.query.tools.split(',').map((n) => n.trim()).filter(Boolean)
            : null;
        const userId = req.session.user.id;
        const { resolveStepAgent, agentToolsForStep } = require('../../core/automationRunner/aiStepAgent');
        const { resolveUserGroups } = require('../../auth/audience');
        const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
        const principal = await resolveDatatablePrincipal(req);
        // See the picker above: a lookup outage must not be drawn as "this
        // agent cannot be used by this automation", which sends the author to a
        // publish button that changes nothing.
        if (principal.identityError) {
            return res.status(503).json({ error: `identity unavailable (${principal.identityError})` });
        }
        // The same ctx shape the runner builds (core/automationRunner/execution.js),
        // asked of the person editing — who is the automation owner in every path
        // that reaches this editor. The agent can only narrow what THEY may do.
        // `userHomeOrgId` is the field the run's own gate measures against, so
        // it is the one carried here too.
        const ctx = {
            userId,
            userHomeOrgId: principal.organizationId || null,
            orgId: principal.organizationId || null,
            userGroupIds: await resolveUserGroups(userId),
            identityError: null,
            session: req.session,
        };
        const step = {
            id: 'preview', type: 'ai_step', agentId: req.params.agentId, agentPermissions: permissions,
            skillIds: idList(req.query.skillIds),
            disabledAgentSkillIds: idList(req.query.disabledAgentSkillIds),
        };

        let binding = null;
        try {
            binding = await resolveStepAgent(step, ctx);
        } catch (_) {
            // Deliberately undifferentiated — see the header.
            return res.json({ id: req.params.agentId, canUse: false, permissions, allowed: [], withheld: [] });
        }
        if (!binding) return res.status(400).json({ error: 'agentId is required' });

        // What the step's skills grant, under the same switches the run uses
        // (core/automationRunner/aiStepSkills.js). Best effort: a skill read that
        // fails previews the agent without skill grants.
        const stepSkills = require('../../core/automationRunner/aiStepSkills');
        const skillCtx = await stepSkills.loadStepSkillContext({ step, ctx, binding });
        const skillGrants = stepSkills.grantsUnderPermissions(skillCtx.grants, permissions);
        const gate = await agentToolsForStep({
            binding, ctx, allowList,
            skillApps: skillGrants.apps,
            skillAutomationIds: skillGrants.automationIds,
        });
        // The reason comes from the gate that TOOK the tool out, never from a
        // second reading here. Re-deriving it with `confirmForTool` classified
        // every sending tool as `confirm` no matter why it actually fell out —
        // so a tool dropped by the `useTools` switch one line up on the same
        // screen was reported as "someone would have to approve this first",
        // and the advice ("put an approval step after this one") changed
        // nothing. Only the place that removed it knows why.
        const seen = new Set();
        const withheld = [];
        for (const name of gate.withheld || []) {
            if (typeof name !== 'string' || !name || seen.has(name)) continue;
            seen.add(name);
            withheld.push({ name, reason: (gate.reasons && gate.reasons[name]) || 'unavailable' });
        }
        // Handoff 5: version, scope, the knowledge bases and skills the agent
        // brings, and its tools grouped per integration (agentStepCatalog.js).
        const { describeAgentForStep } = require('./agentStepCatalog');
        const detail = await describeAgentForStep({ binding, gate, withheld, ctx, deps: agentStepDeps() });
        res.json({
            id: binding.agentId,
            canUse: true,
            name: binding.agent && binding.agent.name ? binding.agent.name : null,
            version: detail.version,
            scope: detail.scope,
            knowledgeBases: detail.knowledgeBases,
            skills: detail.skills,
            tools: detail.tools,
            // 'published' or 'live' — the only honest answer to "what would run".
            runtimeSource: binding.runtimeSource || null,
            permissions,
            allowed: (gate.tools || []).map(t => t && t.function && t.function.name).filter(Boolean),
            withheld,
            // The registry could not say which app owns a name, so the step is
            // served no registry tools at all. Not the same as "this agent has
            // none", and the capsule says so.
            degraded: !!gate.degraded,
            error: gate.catalogError || null,
        });
    });

    /**
     * One skill's output contract, for the AI step editor (handoff 5): the fields
     * a step hands on when this skill leads and the step has no schema of its
     * own ("Continues as").
     *
     * Asked as the person editing, in their home organisation: the same
     * visibility rule the run applies when it loads the step's skills. A skill
     * that does not exist and one that is not shared with them get the same 404.
     */
    router.get('/catalog/skill/:skillId', async (req, res) => {
        const userId = req.session.user.id;
        const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
        const principal = await resolveDatatablePrincipal(req);
        if (principal.identityError) {
            throw new HttpError(503, 'identity_unavailable', 'Your account could not be read just now. Try again in a moment.');
        }
        const { describeSkillForStep } = require('./agentStepCatalog');
        const skill = await describeSkillForStep({
            skillId: req.params.skillId,
            orgId: principal.organizationId || null,
            userId,
            deps: agentStepDeps(),
        });
        if (!skill) throw new HttpError(404, 'skill_not_found', 'There is no skill with this id that you can use.');
        res.json(skill);
    });
}

module.exports = { registerAgentStepRoutes, AgentPreviewQuery };
