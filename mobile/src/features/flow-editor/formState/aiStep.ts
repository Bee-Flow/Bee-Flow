/**
 * The AI step's draft and patch: prompt, model tier, tools, inputs, declared
 * output, knowledge bases, and (R2) the agent that thinks plus what it may do.
 * From agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { applyForEachPatch, sanitizeInputs } from './common';
import { fieldsToSchema, schemaToFields } from './outputSchema';
import { arrOr, or, trimmedOr } from './read';
import type { Extractor, Patcher } from './types';

/** Mirrors AI_STEP_AGENT_PERMISSION_KEYS in server/automation/validate/constants.js. */
export const AI_STEP_AGENT_PERMISSION_KEYS: readonly string[] = ['startAutomations', 'useKnowledge', 'useTools'];
export const MAX_AI_STEP_SKILL_IDS = 5;

/** Always all three, always real booleans — REBUILT, never spread; absent is three noes. */
export function readAgentPermissions(raw: unknown): Record<string, boolean> {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const out: Record<string, boolean> = {};
    for (const key of AI_STEP_AGENT_PERMISSION_KEYS) out[key] = src[key] === true;
    return out;
}

/** The skills, IN THE AUTHOR'S ORDER (the first one leads), de-duplicated. */
export function readSkillIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of raw) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export const extractAiStep: Extractor = (step, base) => ({
    ...base,
    prompt: or(step.prompt, ''),
    systemPrompt: or(step.systemPrompt, ''),
    modelTier: or(step.modelTier, 'auto'),
    allowTools: !!step.allowTools,
    // `null` = not set: with allowTools it means the legacy "all permitted tools".
    tools: arrOr(step.tools, null),
    inputs: or(step.inputs, {}),
    outputFields: schemaToFields(step.outputSchema),
    knowledgeBaseIds: arrOr(step.knowledgeBaseIds, []),
    agentId: trimmedOr(step.agentId, null),
    skillIds: readSkillIds(step.skillIds),
    // The agent's own skills switched off for THIS step (handoff 5).
    disabledAgentSkillIds: readSkillIds(step.disabledAgentSkillIds),
    agentPermissions: readAgentPermissions(step.agentPermissions),
    forEach: or(step.forEach, null),
});

function toolsPatch(draft: Record<string, unknown>): Record<string, unknown> {
    // An explicit selection persists the allowlist and derives allowTools from it;
    // an untouched legacy step keeps its allowTools and no `tools`.
    if (Array.isArray(draft.tools)) return { tools: draft.tools, allowTools: draft.tools.length > 0 };
    return { allowTools: !!draft.allowTools };
}

export const patchAiStep: Patcher = (patch, step, draft) => {
    patch.prompt = or(draft.prompt, '');
    patch.systemPrompt = trimmedOr(draft.systemPrompt, null);
    patch.modelTier = or(draft.modelTier, 'auto');
    Object.assign(patch, toolsPatch(draft));
    patch.inputs = sanitizeInputs(or(draft.inputs, {}));
    patch.outputSchema = fieldsToSchema(or(draft.outputFields, []));
    patch.knowledgeBaseIds = Array.isArray(draft.knowledgeBaseIds)
        ? draft.knowledgeBaseIds.filter((id) => typeof id === 'string' && id)
        : [];
    patch.agentId = trimmedOr(draft.agentId, null);
    patch.skillIds = readSkillIds(draft.skillIds).slice(0, MAX_AI_STEP_SKILL_IDS);
    patch.agentPermissions = readAgentPermissions(draft.agentPermissions);
    // Only meaningful with an agent: a stale list would apply to the next agent.
    patch.disabledAgentSkillIds = patch.agentId ? readSkillIds(draft.disabledAgentSkillIds) : [];
    applyForEachPatch(patch, step, draft); // C12 — was dropped both ways
};
