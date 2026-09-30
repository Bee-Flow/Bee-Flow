/**
 * "Let AI fill it in": one sentence to a whole skill (POST /api/skills/ai/draft).
 *
 * The answer is a PROPOSAL, never a save — the web's SkillDetail.fillIn puts it
 * through the same draft every keystroke goes through, so the person sees it
 * before it is theirs. A facet the model said nothing about keeps what the
 * draft already had; facets it did answer are normalised through the same
 * readers as a stored row, so a proposal can never smuggle in a shape the
 * editors cannot draw.
 */

import { examplesOf, rulesOf, stepsOf } from './skillModel';
import type { SkillDraft, SkillProposal } from './types';

export function applyProposal(draft: SkillDraft, proposal: SkillProposal): SkillDraft {
    return {
        ...draft,
        name: proposal.name || draft.name,
        description: proposal.description ?? draft.description,
        instructions: proposal.instructions ?? draft.instructions,
        steps: Array.isArray(proposal.steps) ? stepsOf({ steps: proposal.steps }) : draft.steps,
        rulesV2: Array.isArray(proposal.rulesV2) ? rulesOf({ rulesV2: proposal.rulesV2 }) : draft.rulesV2,
        examplesV2: Array.isArray(proposal.examplesV2) ? examplesOf({ examplesV2: proposal.examplesV2 }) : draft.examplesV2,
        outputSchema: proposal.outputSchema ?? draft.outputSchema,
    };
}

/** An editor that has nothing yet: the only state the head start is offered in. */
export function isBlankDraft(draft: SkillDraft): boolean {
    return draft.steps.length === 0 && draft.rulesV2.length === 0 && !draft.instructions.trim();
}
