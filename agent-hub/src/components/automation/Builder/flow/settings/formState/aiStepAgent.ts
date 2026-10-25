import type { FormRecord, JsonValue } from './types';

/**
 * R2 — the three switches of `ai_step.agentPermissions`, and the skill cap.
 *
 * Mirrors AI_STEP_AGENT_PERMISSION_KEYS / MAX_AI_STEP_SKILL_IDS in
 * server/automation/validate/constants.js. Restated rather than fetched
 * because a form has to render before any round trip — but the server clamps
 * both ends regardless (stepBuilders.sanitizeAgentPermissions rebuilds the
 * object from its own list, and mergeSkillIds truncates at the same cap), so a
 * client that drifts loses a checkbox, never a rule.
 */
const AI_STEP_AGENT_PERMISSION_KEYS = ['startAutomations', 'useKnowledge', 'useTools'];
export const MAX_AI_STEP_SKILL_IDS = 5;

/** One real boolean per name in AI_STEP_AGENT_PERMISSION_KEYS. */
export interface AiStepAgentPermissions { startAutomations: boolean; useKnowledge: boolean; useTools: boolean }

/**
 * The permissions of an ai_step, always all three, always real booleans.
 *
 * REBUILT from the three known names — never spread from what was stored. A
 * stored `{useTools: true}` spread into a draft leaves the other two
 * `undefined`, and the first reader written as `!== false` reads an undefined
 * as a yes. Absent is three noes: this surface is new, so there is no
 * yesterday's behaviour that reading absence broadly would preserve (which is
 * the one thing that justifies the opposite reading over in
 * core/agentRuntime/toolPolicy.js).
 */
export function readAgentPermissions(raw: JsonValue): AiStepAgentPermissions {
    const src: FormRecord = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const out: FormRecord = {};
    for (const key of AI_STEP_AGENT_PERMISSION_KEYS) out[key] = src[key] === true;
    return out as AiStepAgentPermissions;
}

/** The skills of an ai_step, IN THE AUTHOR'S ORDER — the first one leads. */
export function readSkillIds(raw: JsonValue): string[] {
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
