/** Types of the refine merge (state/refineMerge.ts). */
import type { Persona } from '../role/personaFacts';

/** A persona as the column holds it: possibly partial, possibly unreadable. */
export type PersonaLike = Partial<Persona>;

/** The four descriptive persona fields that travel with a plan. */
export interface PersonaFields {
    who: string;
    tone: { chips: string[]; text: string };
    does: string[];
    doesNot: string[];
}

export interface RefineConfig {
    enabledIntegrations?: string[];
    attachedSkillIds?: string[];
    knowledge_base_ids?: string[];
    wizard?: { capabilities?: string[] };
    [key: string]: unknown;
}

/** The agent state a refine reads and the snapshot a merge returns. */
export interface RefineSnapshot {
    name?: string;
    description?: string;
    systemPrompt?: string;
    avatar?: string;
    model?: string;
    config?: RefineConfig;
    persona?: PersonaLike | null;
    noStoredPersona?: boolean;
}

/** A snapshot with all five text fields present, as the editor's live state has them. */
export type FullRefineSnapshot = RefineSnapshot & Required<Pick<RefineSnapshot, 'name' | 'description' | 'systemPrompt' | 'avatar' | 'model'>>;

/** What `mergeRefinedPlan` returns; the text fields are `string` when the snapshot passed in had them all. */
export interface MergedRefinePlan<Text extends string | undefined = string | undefined> {
    name: Text;
    description: Text;
    systemPrompt: Text;
    avatar: Text;
    model: Text;
    config: RefineConfig & {
        enabledIntegrations: string[];
        attachedSkillIds: string[];
        knowledge_base_ids: string[];
        wizard: { capabilities: string[] };
    };
    persona: PersonaLike | null | undefined;
}

/** The live editor state `buildRefineContext` reads. */
export interface RefineState {
    name?: string;
    description?: string;
    avatar?: string;
    systemPrompt?: string;
    capabilities?: string[];
    model?: string;
    enabledIntegrations?: string[];
    attachedSkills?: Array<{ id: string; name: string }>;
    knowledge_base_ids?: string[];
    persona?: PersonaLike | null;
}

/** The normalized AI plan (`POST /agents/wizard/refine`). */
export interface RefinePlan {
    name?: string;
    description?: string;
    systemPrompt?: string;
    avatar?: string;
    /** `null` when the server found no selectable tier (routes/agents/wizard.js normalizePlan). */
    model?: string | null;
    capabilities?: string[];
    enabledIntegrations?: string[];
    knowledge_base_ids?: string[];
    persona?: PersonaLike | null;
}

/** The server's echo of the current curated config. */
export interface RefinePreserved {
    enabledIntegrations?: string[];
    knowledge_base_ids?: string[];
}

export interface MergeOpts {
    availableIntegrationIds?: string[];
    selectableTierKeys?: string[];
    resolvedSkillIds?: string[] | null;
}

export interface RefineChange {
    field: string;
    direction?: 'added' | 'removed';
    count?: number;
    ids?: string[];
}
