/**
 * Contract readers for the editor's responses: the concept view of an agent
 * (`GET /agents/:id?draft=1`, and the PUT/POST echo), the refine plan, the
 * undo point and the publish answer.
 */

import { field, shapeOf } from '@/core/api/contract';

import { agentSpec } from './readers';
import type { AgentDetail } from '../model/draft';
import type { Persona, Preserved, RefinedPlan } from '../model/refineMerge';

export const readAgentDetail: (raw: unknown) => AgentDetail = shapeOf({
    ...agentSpec,
    system_prompt: field.strOrNull,
    persona: field.optRecord<Persona>,
    published_version: field.optNum,
    unpublishedChanges: field.optNum,
});

const readSkillRef = shapeOf({ id: field.strOrNull, name: field.str('') });

/** The plan as normalizePlan leaves it (server/routes/agents/wizard.js). Absent stays absent. */
const readPlan: (raw: unknown) => RefinedPlan = shapeOf({
    name: field.optStr,
    description: field.optStr,
    avatar: field.optStr,
    systemPrompt: field.optStr,
    capabilities: field.optStrArray,
    model: field.strOrNull,
    enabledIntegrations: field.optStrArray,
    knowledge_base_ids: field.optStrArray,
    skills: field.optList(readSkillRef),
    persona: field.raw,
});

const readPreserved: (raw: unknown) => Preserved = shapeOf({
    model: field.strOrNull,
    enabledIntegrations: field.strArray,
    attachedSkillIds: field.strArray,
    knowledge_base_ids: field.strArray,
});

export interface RefineAnswer {
    plan: RefinedPlan;
    preserved: Preserved;
}

export const readRefineAnswer: (raw: unknown) => RefineAnswer = shapeOf({
    plan: readPlan,
    preserved: readPreserved,
});

/** POST /versions/:id/pre-refine — the id of the undo point, or '' when none. */
export const readVersionRef = shapeOf({ id: field.str('') });

/** POST /agents/:id/publish-version. */
export const readPublishedVersion = shapeOf({
    publishedVersion: field.optNum,
    unpublishedChanges: field.optNum,
});
