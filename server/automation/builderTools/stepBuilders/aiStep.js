/**
 * Builder tools — builder_add_ai: the ai_step, the model-tier gate, and the
 * R2 block that hands the thinking to an agent (agentId, skillIds and the
 * three named permissions, rebuilt rather than merged).
 */

const { newId, appendAfter } = require('../draftGraph');
const { validateAndFixBindings, sanitizeForEach, unboundLoopVarError } = require('../bindings');
const { AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS } = require('../../validate/constants');
// Pure module, no I/O at load: the runner and the builder share one sanitiser.
const { sanitizeDisabledAgentSkillIds } = require('../../../core/automationRunner/aiStepSkills');

/**
 * Reject an ai_step modelTier the user doesn't have. The route attaches the
 * user's real tier set (dropdown tiers + 'auto') as `_allowedModelTiers`;
 * without it (tests / legacy callers) the check is a no-op. The error lists
 * the valid values so the model self-corrects in one round.
 *
 * De AANWEZIGHEID van de sleutel beslist, niet de inhoud. Een LEGE Set is
 * "deze workspace biedt geen enkele tier aan" — een gelezen nul — en die als
 * "geen beperking" lezen was de wijdst mogelijke uitkomst van de smalst
 * mogelijke lijst. Zelfde regel als de grants-map in toolPolicy.js: een lege
 * sectie is een keuze, geen afwezigheid.
 */
function modelTierGateError(modelTier, draftWrap) {
    if (!modelTier || modelTier === 'auto') return null;
    const allowed = draftWrap && draftWrap._allowedModelTiers;
    if (!(allowed instanceof Set)) return null;
    if (allowed.has(modelTier)) return null;
    return { error: `modelTier "${modelTier}" is not available for this user. Choose one of: ${[...allowed].join(', ')} (or omit it — the default is "auto").` };
}

// ── R2 — an ai_step that hands the thinking to an AGENT ─────────────
//
// Three fields, and all three are written on EVERY ai_step the builders make,
// exactly like `knowledgeBaseIds`: the runner then never has to tell "not set"
// from "cleared", and no reader can invent a meaning for an absent key.
//
// The identity questions — does this agent exist, is it in the automation
// owner's organisation, is it published — are DATABASE questions and are not
// answered here. validate/stepRules.js asks them against the catalog its
// caller injects (automation/agentCatalog.js builds it), and
// core/automationRunner/aiStepAgent.js asks them AGAIN at run time, which is
// the only one that can see the world as it is when the automation fires.

/** An agent/skill id as it is stored: a trimmed string, or null. */
function sanitizeAgentId(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The skills this step attaches, IN THE AUTHOR'S ORDER — the first one is the
 * leading skill, so this dedupes without sorting and never re-orders.
 *
 * Capped at MAX_AI_STEP_SKILL_IDS because that is where mergeSkillIds in
 * core/tools/skillInjection.js truncates anyway; cutting here means the author
 * is told (validate/stepRules.js warns on a longer stored list) instead of
 * finding out that their sixth skill was never in the prompt.
 */
function sanitizeSkillIds(v) {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of v) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_AI_STEP_SKILL_IDS) break;
    }
    return out;
}

/**
 * `agentPermissions`, REBUILT from the three known names — never merged.
 *
 * Absent means all three false. That is the deliberate opposite of the
 * grants-map rule in core/agentRuntime/toolPolicy.js, where a missing app
 * entry means "every action of this app": that reading exists to keep agents
 * the toolbelt they already had before the picker shipped, and an ai_step
 * bound to an agent has no such yesterday. There is no behaviour to preserve,
 * so the trap the layer has fallen into twice — a missing key growing into
 * "everything" — has nothing to stand on and is refused by construction.
 *
 * Rebuilding rather than merging is the half that actually bites in code: a
 * patch of `{useTools: true}` merged into a stored object leaves
 * `useKnowledge` as `undefined`, and the first reader written as `!== false`
 * reads that as yes. Three named keys, three real booleans, every time.
 *
 * `=== true`, not truthy: a stored `"false"`, `1` or `"no"` is a value nobody
 * can read, and a value nobody can read is not a grant.
 */
function sanitizeAgentPermissions(v) {
    const src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const out = {};
    for (const key of AI_STEP_AGENT_PERMISSION_KEYS) out[key] = src[key] === true;
    return out;
}

/**
 * The permissions BLOCK for a step, given the agent it ended up with.
 *
 * The three-booleans-always rule above is about a step BOUND TO AN AGENT: the
 * set is written out so a missing key can never grow into "everything". On a
 * step with no `agentId` there is no agent to grant anything to, and writing
 * the block anyway put an `{all false}` object on every plain AI step the
 * builder made — which the validator then flagged, correctly and forever, as
 * `ai_step.agent_permissions_orphan`: "sets agent permissions but names no
 * agent, so nothing reads them". Every AI-built automation carried that warning,
 * and no user action cleared it, because the user never set the field.
 *
 * Absent means all three false (validate/constants.js R2), so omitting the
 * block on an agent-less step says exactly what `{false,false,false}` said and
 * loses nothing. The invariant still holds where it means something: the
 * moment a step names an agent, the full set is written.
 *
 * @returns {{permissions?: object} | {error: string, _fixHint: string}}
 */
function agentPermissionsBlock(rawPermissions, agentId, { hasSkills = false } = {}) {
    if (agentId) return { permissions: sanitizeAgentPermissions(rawPermissions) };
    const granted = AI_STEP_AGENT_PERMISSION_KEYS.filter(k => rawPermissions
        && typeof rawPermissions === 'object' && rawPermissions[k] === true);
    // Handoff 5: a step that applies skills WITHOUT an agent reads the same
    // switches (a skill can bring knowledge bases, and can run an automation), so
    // there the block is kept as soon as anything is granted.
    if (hasSkills && granted.length) return { permissions: sanitizeAgentPermissions(rawPermissions) };
    // Turning a permission ON without naming an agent is a real mistake, not
    // noise: the model meant the step to be able to do something and it will
    // silently not be able to. Say so instead of dropping it.
    if (granted.length) {
        return {
            error: `agentPermissions ${granted.map(k => `"${k}"`).join(', ')} was set but the step names no agent, so nothing would read it. `
                + 'Set agentId to an agent the user has actually shown you, or drop agentPermissions — a step without an agent runs on its own prompt and needs none.',
            _fixHint: 'Either pass agentId together with agentPermissions, or omit agentPermissions entirely.',
        };
    }
    // Nothing was granted: absent and all-false mean the same thing, so leave
    // the field out and the step reads as what it is — a plain AI step.
    return { permissions: undefined };
}

function applyAddAi(draft, args, draftWrap) {
    const tierErr = modelTierGateError(args.modelTier, draftWrap);
    if (tierErr) return tierErr;
    const { inputs, error } = validateAndFixBindings(args.inputs || {}, draft);
    if (error) return { error };
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const loopErr = unboundLoopVarError(inputs, forEach);
    if (loopErr) return loopErr;
    const agentId = sanitizeAgentId(args.agentId);
    const skillIds = sanitizeSkillIds(args.skillIds);
    const permBlock = agentPermissionsBlock(args.agentPermissions, agentId, { hasSkills: skillIds.length > 0 });
    if (permBlock.error) return permBlock;
    // The agent's own skills this step switches off (handoff 5). Only on a
    // step bound to an agent, and only when there is something to say.
    const disabledAgentSkillIds = agentId ? sanitizeDisabledAgentSkillIds(args.disabledAgentSkillIds) : [];
    const step = {
        id: newId('ai'),
        type: 'ai_step',
        prompt: args.prompt,
        // Optional override of the runner's default system prompt. When
        // omitted we use the safe baseline ("You are a step inside a
        // no-code automation..."). The user can edit this from the
        // inspector's Settings tab to set a tone or role.
        systemPrompt: typeof args.systemPrompt === 'string' && args.systemPrompt.trim() ? args.systemPrompt.trim() : null,
        inputs,
        outputSchema: args.outputSchema || null,
        // Default to 'auto' so the AI step honours the org's tier classifier
        // — same default as direct chat. Builder can override per step.
        modelTier: args.modelTier || 'auto',
        label: args.label || 'AI step',
        // Coherent pair (C14): an explicit tools array IS the allowlist, so
        // allowTools derives from it (empty allowlist = no tools = off).
        // Only a null/absent array falls back to the caller's flag.
        allowTools: Array.isArray(args.tools) ? args.tools.length > 0 : !!args.allowTools,
        tools: Array.isArray(args.tools) ? args.tools.filter(t => typeof t === 'string') : null,
        // Knowledge Base grounding (BFSF-410) — mirrors App Studio's
        // ai_generate/ai_extract. Always an explicit array (never absent) so
        // the runner never has to distinguish "not set" from "cleared".
        // execAiStep re-checks every id against the running user/org before
        // ever searching it — see MAX_AI_STEP_KB_IDS in core/automationRunner/execAi.js.
        knowledgeBaseIds: Array.isArray(args.knowledgeBaseIds)
            ? args.knowledgeBaseIds.filter(id => typeof id === 'string' && id).slice(0, 10)
            : [],
        // Personal memory grounding (2026-09-04): when on, the runner searches
        // the AUTOMATION OWNER's user_memories with this step's prompt and adds
        // the hits to the system prompt — the same block chat agents get.
        // Off by default: most steps transform data and must not drift with
        // whatever the owner said in chat last week.
        useMemory: args.useMemory === true,
        // R2 — who does the thinking, and what they may do here. `null` + `[]`
        // is a plain ai_step, said out loud; the permission block joins it only
        // once there is an agent to grant anything to (agentPermissionsBlock).
        agentId,
        skillIds,
        ...(disabledAgentSkillIds.length ? { disabledAgentSkillIds } : {}),
        ...(permBlock.permissions !== undefined ? { agentPermissions: permBlock.permissions } : {}),
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

module.exports = {
    modelTierGateError,
    sanitizeAgentId,
    sanitizeSkillIds,
    sanitizeAgentPermissions,
    sanitizeDisabledAgentSkillIds,
    agentPermissionsBlock,
    applyAddAi,
};
