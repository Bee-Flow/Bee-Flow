import type { Skill } from '../../../../api/queries/skills';

/** A skill row as the editor reads it: any field may be missing (a mobile-minted row, a partial answer). */
export type SkillLike = Partial<Skill>;

/** The three things a step may point at (S1 `steps[].refs[].kind`). */
export type RefKind = 'automation' | 'kb' | 'table';

/** The two polarities of a rule (S1 `rules_v2[].polarity`). */
export type RulePolarity = 'must' | 'never';

/** How the "All skills" table can be ordered (artboard 1c, right). */
export type SortMode = 'used' | 'recent' | 'name';

/** The tone of the Test column's chip. */
export type TestTone = 'idle' | 'error' | 'warning' | 'ok';

export interface SkillRef {
    kind: RefKind;
    id: string;
}

export interface SkillStep {
    id: string;
    text: string;
    refs: SkillRef[];
}

export interface SkillRule {
    id: string;
    polarity: RulePolarity;
    text: string;
}

export interface SkillExample {
    id: string;
    question: string;
    good: string;
    rationale: string;
    bad: string;
    violatedRuleId: string;
    sourceConversationId: string;
}

/** The JSON-schema subset of a skill's `output_schema` the editor reads: one object per named field. */
export interface OutputSchema {
    properties?: Record<string, Record<string, unknown> | undefined>;
    [key: string]: unknown;
}

/** One entry of `GET /api/skills/usage-summary`, keyed by skill id. */
export interface SkillUsage {
    agents?: number | string | null;
    automations?: number | string | null;
    automationsUnchecked?: boolean;
    lastUsedAt?: string | null;
}

/** The `lastTest` S1 puts on every `GET /api/skills` row. */
export interface SkillLastTest {
    status?: string | null;
    adviceCount?: number | string | null;
}

export interface TestChip {
    tone: TestTone;
    label: string;
}

/** The fields of an automation row this module reads. */
export interface AutomationTriggerRow {
    id?: unknown;
    definition?: { trigger?: { kind?: unknown } | null } | null;
    triggerKind?: unknown;
    triggerType?: unknown;
    [key: string]: unknown;
}

/** The editable draft a detail view starts from — every facet normalised. */
export interface SkillDraft {
    name: string;
    description: string;
    instructions: string;
    icon: string;
    isShared: boolean;
    dynamicActivation: boolean;
    sharedGroups: string[];
    enabledIntegrations: string[];
    steps: SkillStep[];
    rulesV2: SkillRule[];
    examplesV2: SkillExample[];
    outputSchema: OutputSchema | null;
    knowledgeBaseIds: string[];
    allowedAutomationIds: string[];
}

/** The body of an autosave PUT. */
export type SkillSavePayload = Omit<SkillDraft, 'steps' | 'rulesV2' | 'examplesV2' | 'outputSchema'> & {
    steps: SkillStep[];
    rulesV2: SkillRule[];
    examplesV2: SkillExample[];
    outputSchema: OutputSchema | null;
};
