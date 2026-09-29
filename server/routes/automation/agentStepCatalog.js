/**
 * What an agent, and a skill, bring to ONE AI step: the data behind the step
 * editor's "Who does the thinking" block (Studio → Automations, handoff 5,
 * round 3). Served by GET /catalog/agent/:agentId and
 * GET /catalog/skill/:skillId in routes/automation/catalog.js.
 *
 * The permission gate itself (which tools the step gets, which are withheld
 * and why) is aiStepAgent.agentToolsForStep, the function the run uses; this
 * module only DESCRIBES: the agent's version and scope, the knowledge bases
 * and skills it brings (as the editor may see them), its tools grouped per
 * integration, and a skill's output contract.
 *
 * Every dependency comes in through `deps` so each answer is tested without a
 * database. Each list fails on its own to `null` ("could not be read"), never
 * to `[]`, which the editor would draw as "this agent has none".
 */

'use strict';

const { outputFieldsOf, skillOutputSchema } = require('../../core/automationRunner/aiStepSkills');

/** The integration a tool belongs to, for grouping chips. */
function integrationOfTool(name, def, resolveIntegration) {
    if (def && def.__automation && def.__automation.id) return { integration: 'automations', label: 'Automations' };
    if (def && def.__step && def.__step.id) return { integration: 'building_blocks', label: 'Building blocks' };
    if (name === 'activate_skill') return { integration: 'skills', label: 'Skills' };
    if (def && def._mcp && def._mcp.serverId) {
        return { integration: `mcp:${def._mcp.serverId}`, label: def._mcp.serverName || def._mcp.serverId };
    }
    if (def && def._custom && (def._custom.integrationId || def._custom.id)) {
        const id = def._custom.integrationId || def._custom.id;
        return { integration: `custom:${id}`, label: def._custom.name || 'Custom integration' };
    }
    let r = null;
    try { r = typeof resolveIntegration === 'function' ? resolveIntegration(name) : null; } catch (_) { r = null; }
    if (r && r.integration) return { integration: r.integration, label: r.label || r.integration };
    return { integration: 'other', label: 'Other tools' };
}

/**
 * The agent's tools for this step, grouped per integration, in first-seen
 * order: allowed ones first, then withheld ones.
 *
 * A group is `withheld: true` only when EVERY tool in it is withheld; its
 * `reason` is then the reason they share (or the first one when they differ).
 * `withheldTools` lists the per-tool reasons either way.
 *
 * @param {object} args
 * @param {string[]} args.allowed   names the step gets
 * @param {Array<{name:string,reason:string}>} args.withheld
 * @param {Array}    [args.toolDefs] definitions seen by the gate, for grouping
 * @param {Function} [args.resolveIntegration]
 * @returns {Array<{integration:string,label:string,tools:string[],withheld:boolean,reason:string|null,withheldTools:Array<{name:string,reason:string}>}>}
 */
function groupToolsByIntegration({ allowed = [], withheld = [], toolDefs = [], resolveIntegration = null }) {
    const defs = new Map();
    for (const d of Array.isArray(toolDefs) ? toolDefs : []) {
        const n = d && d.function && d.function.name;
        if (typeof n === 'string' && n && !defs.has(n)) defs.set(n, d);
    }
    const groups = new Map();
    const add = (name, reason) => {
        const { integration, label } = integrationOfTool(name, defs.get(name), resolveIntegration);
        let g = groups.get(integration);
        if (!g) {
            g = { integration, label, tools: [], withheldTools: [] };
            groups.set(integration, g);
        }
        if (g.tools.includes(name)) return;
        g.tools.push(name);
        if (reason) g.withheldTools.push({ name, reason });
    };
    for (const n of allowed) if (typeof n === 'string' && n) add(n, null);
    for (const w of withheld) if (w && typeof w.name === 'string' && w.name) add(w.name, w.reason || 'unavailable');
    return [...groups.values()].map((g) => {
        const all = g.withheldTools.length === g.tools.length && g.tools.length > 0;
        return {
            integration: g.integration,
            label: g.label,
            tools: g.tools,
            withheld: all,
            reason: all ? g.withheldTools[0].reason : null,
            withheldTools: g.withheldTools,
        };
    });
}

/** 'org' when the agent is published to its organisation, else 'personal'. */
function agentScope(agent) {
    return agent && agent.is_published === true && agent.organization_id ? 'org' : 'personal';
}

/** The published version that runs, or null while only the live concept exists. */
function agentVersion(agent) {
    const v = Number(agent && agent.published_version);
    return Number.isInteger(v) && v > 0 ? v : null;
}

function _ids(list) {
    return Array.isArray(list) ? [...new Set(list.filter((id) => typeof id === 'string' && id))] : [];
}

/**
 * The agent's knowledge bases that the person editing may read, with names.
 * The same visibility rule the run applies (core/kb/kbVisibility), so the
 * editor never names a base the step would not search.
 */
async function visibleKnowledgeBases(kbIds, ctx, deps) {
    const ids = _ids(kbIds);
    if (!ids.length) return [];
    const rows = new Map();
    const store = {
        getKB: async (id) => {
            if (!rows.has(id)) rows.set(id, await deps.kbStore.getKB(id));
            return rows.get(id);
        },
        canUserAccessKB: (...args) => deps.kbStore.canUserAccessKB(...args),
    };
    const allowed = await deps.kbVisibility.filterKbIdsForUser(ids, {
        userId: ctx.userId,
        orgIds: ctx.orgId ? new Set([ctx.orgId]) : new Set(),
        userGroups: Array.isArray(ctx.userGroupIds) ? ctx.userGroupIds : [],
        context: 'automation_step_editor',
        deps: { kbStore: store },
    });
    return allowed.map((id) => {
        const row = rows.get(id);
        return { id, name: (row && row.name) || id };
    });
}

/** The agent's own skills as the person editing may see them, in the agent's order. */
async function agentSkills(skillIds, ctx, deps) {
    const ids = _ids(skillIds);
    if (!ids.length) return [];
    if (!ctx.orgId) return [];
    const rows = await deps.skillStore.getSkillsByIds(ids, ctx.orgId, ctx.userId);
    const byId = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && r.id).map((r) => [r.id, r]));
    return ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).name || id, fromAgent: true }));
}

/**
 * Everything the preview adds beside the gate's `allowed`/`withheld`.
 *
 * @returns {Promise<{ version: number|null, scope: 'org'|'personal',
 *   knowledgeBases: Array<{id,name}>|null, skills: Array<{id,name,fromAgent}>|null,
 *   tools: Array|null }>}
 */
async function describeAgentForStep({ binding, gate, withheld, ctx, deps }) {
    const agent = (binding && binding.agent) || {};
    const config = (binding && binding.config) || {};
    const log = deps.log || { warn: () => {} };
    let knowledgeBases = null;
    try { knowledgeBases = await visibleKnowledgeBases(config.knowledge_base_ids, ctx, deps); } catch (e) {
        log.warn('[automation/catalog] agent knowledge bases unavailable:', e && e.message);
    }
    let skills = null;
    try { skills = await agentSkills(config.attachedSkillIds, ctx, deps); } catch (e) {
        log.warn('[automation/catalog] agent skills unavailable:', e && e.message);
    }
    const allowed = ((gate && gate.tools) || []).map((t) => t && t.function && t.function.name).filter(Boolean);
    return {
        version: agentVersion(agent),
        scope: agentScope(agent),
        knowledgeBases,
        skills,
        tools: groupToolsByIntegration({
            allowed,
            withheld: withheld || [],
            toolDefs: (gate && gate.toolDefs) || [],
            resolveIntegration: deps.resolveIntegration,
        }),
    };
}

/**
 * One skill's output contract for the step editor, or null when the person
 * editing cannot use it (one answer for missing and not shared).
 *
 * @returns {Promise<null | { id, name, description, version, outputSchema, outputFields }>}
 */
async function describeSkillForStep({ skillId, orgId, userId, deps }) {
    if (typeof skillId !== 'string' || !skillId.trim()) return null;
    const skill = await deps.skillStore.getSkill(skillId.trim(), orgId || null, userId);
    if (!skill) return null;
    const schema = skillOutputSchema(skill);
    return {
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description || null,
        version: Number.isInteger(skill.version) && skill.version > 0 ? skill.version : null,
        outputSchema: schema,
        outputFields: outputFieldsOf(schema),
    };
}

module.exports = {
    integrationOfTool,
    groupToolsByIntegration,
    agentScope,
    agentVersion,
    visibleKnowledgeBases,
    agentSkills,
    describeAgentForStep,
    describeSkillForStep,
};
