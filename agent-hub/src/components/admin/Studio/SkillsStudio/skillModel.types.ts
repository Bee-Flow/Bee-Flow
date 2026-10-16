import type { SchemaProp } from '../../../automation/Builder/mapping/toolInput/toolInputHelpers';

/** One field of an output schema; `x-unit` is the unit a field is measured in. */
export type OutputSchemaProp = SchemaProp & { 'x-unit'?: string };

/** A skill's `output_schema`: JSON Schema (`properties`), or the flat `{ name: 'string' }` form. */
export interface OutputSchema {
    properties?: Record<string, OutputSchemaProp>;
    [key: string]: unknown;
}

export interface StepRef { kind: string; id: string }
export interface Step { id: string; text: string; refs: StepRef[] }
export interface Rule { id: string; polarity: string; text: string }
export interface Example {
    id: string;
    question: string;
    good: string;
    rationale: string;
    bad: string;
    violatedRuleId: string;
    sourceConversationId: string;
}

/**
 * A step ref as a row may carry it: anything, until `stepsOf` normalises it.
 * `kind` and `polarity` are required here only for `includes()`; the normalisers
 * tolerate their absence.
 */
interface RawRef { kind: string; id?: string | number | null }
interface RawStep { id?: unknown; text?: unknown; refs?: RawRef[] | null }
interface RawRule { id?: unknown; polarity: string; text?: unknown }
interface RawExample {
    id?: unknown;
    question?: unknown;
    good?: unknown;
    rationale?: unknown;
    bad?: unknown;
    violatedRuleId?: unknown;
    sourceConversationId?: unknown;
}

export interface LastTest { status?: string | null; adviceCount?: number | string | null }

export interface Skill {
    id: string;
    name?: string;
    description?: string;
    instructions?: string;
    icon?: string;
    isShared?: boolean;
    dynamicActivation?: boolean;
    sharedGroups?: string[] | null;
    enabledIntegrations?: string[] | null;
    steps?: (RawStep | null)[] | null;
    rulesV2?: RawRule[] | null;
    examplesV2?: (RawExample | null)[] | null;
    outputSchema?: OutputSchema | null;
    knowledgeBaseIds?: string[] | null;
    allowedAutomationIds?: string[] | null;
    lastUsedAt?: string | null;
    canEdit?: boolean;
    lastTest?: LastTest | null;
}

/** One `usage-summary` entry. */
export interface UsageSummary {
    agents?: number | string;
    automations?: number | string;
    automationsUnchecked?: boolean;
    lastUsedAt?: string | null;
}

export type UsageSummaryMap = Record<string, UsageSummary | undefined>;
export type SortMode = 'used' | 'recent' | 'name';
export type SkillIdField = 'sharedGroups' | 'enabledIntegrations' | 'knowledgeBaseIds' | 'allowedAutomationIds';

/** The editable draft a detail view starts from. */
export interface SkillDraft {
    name: string;
    description: string;
    instructions: string;
    icon: string;
    isShared: boolean;
    dynamicActivation: boolean;
    sharedGroups: string[];
    enabledIntegrations: string[];
    steps: Step[];
    rulesV2: Rule[];
    examplesV2: Example[];
    outputSchema: OutputSchema | null;
    knowledgeBaseIds: string[];
    allowedAutomationIds: string[];
}

export interface TestChip { tone: string; label: string }

/** The automation row shapes `isAgentCallable` accepts (one per endpoint). */
export interface CallableAutomation {
    definition?: { trigger?: { kind?: string | null } | null } | null;
    triggerKind?: string | null;
    triggerType?: string | null;
}
