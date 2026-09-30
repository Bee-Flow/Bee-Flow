/**
 * The glue between the editor's draft and the refine merge — the parts of the
 * web's createHandleRefine (builderSplit/refineActions.js) that are not
 * network calls. Pure; unit-tested in refineApply.test.ts.
 */

import type { AgentDetail, AgentDraft } from './draft';
import { draftOf } from './draft';
import { buildRefineContext, type MergedAgent, type RefinedPlan, type RefineState } from './refineMerge';

/** The agent as the merge reads it: the saved concept plus its persona column. */
export function refineStateOf(agent: AgentDetail): { draft: AgentDraft; state: RefineState } {
    const draft = draftOf(agent);
    return {
        draft,
        state: {
            name: draft.name,
            description: draft.description,
            systemPrompt: draft.systemPrompt,
            avatar: draft.avatar,
            model: draft.model,
            config: draft.config,
            // Absent is "not read": the merge then leaves the column alone.
            persona: agent.persona ?? undefined,
        },
    };
}

const wizardCapabilities = (draft: AgentDraft): unknown => {
    const wizard = draft.config.wizard;
    return wizard && typeof wizard === 'object' ? (wizard as { capabilities?: unknown }).capabilities : undefined;
};

/** The { plan, current } the server is asked to refine, with skills named where known. */
export function refineContextOf(agent: AgentDetail, skillNames: ReadonlyMap<string, string>) {
    const { draft, state } = refineStateOf(agent);
    return buildRefineContext({
        name: draft.name,
        description: draft.description,
        avatar: draft.avatar,
        systemPrompt: draft.systemPrompt,
        capabilities: wizardCapabilities(draft),
        model: draft.model,
        enabledIntegrations: draft.config.enabledIntegrations ?? [],
        attachedSkills: (draft.config.attachedSkillIds ?? []).map((id) => ({ id, name: skillNames.get(id) ?? '' })),
        knowledge_base_ids: draft.config.knowledge_base_ids ?? [],
        persona: state.persona,
    });
}

/**
 * The skills after a refine: the current ones plus every EXISTING skill the
 * plan named by id. Union, never subtract. A skill the plan invents without
 * an id is not created from the phone (the web creates it); it is left out.
 */
export function resolvedSkillIds(current: readonly string[] | undefined, plan: RefinedPlan, known: ReadonlySet<string>): string[] {
    const ids = new Set(current ?? []);
    for (const skill of plan.skills ?? []) {
        if (skill.id && known.has(skill.id)) ids.add(skill.id);
    }
    return [...ids];
}

/** The merged snapshot as a draft the save sends. */
export function draftFromMerged(base: AgentDraft, merged: MergedAgent): AgentDraft {
    return {
        ...base,
        name: merged.name,
        description: merged.description,
        systemPrompt: merged.systemPrompt,
        avatar: merged.avatar,
        model: merged.model ?? '',
        config: merged.config,
    };
}
