/**
 * Skills — reusable instruction packs.
 *
 * Written from the row mapper rather than from the route handlers:
 * server/stores/skillStore.js `mapRow` is the only place that decides a NULL
 * column becomes '' (or `[]`) instead of null, and both GET routes hand back
 * exactly what it produces. So every string here is always present and
 * possibly empty, and `icon` is never empty at all — mapRow defaults it to a
 * lightning bolt.
 *
 * ── STRUCTURE, NOT TEXT ─────────────────────────────────────────────
 * A skill is edited here the way the web's Skills Studio edits it: as its
 * structured facets (`steps`, `rulesV2`, `examplesV2`, `outputSchema`, the
 * grants). The text columns `workflow` / `rules` / `examples` are regenerated
 * server-side from the structure (skillStructure.resolveBodyWrite), so they
 * are read for display only and never sent back — a body carrying both would
 * make the text win and re-mint every step id.
 */

/** The three things a step may point at (S1 `steps[].refs[].kind`). */
export type RefKind = 'automation' | 'kb' | 'table';

export interface StepRef {
    kind: RefKind;
    id: string;
}

export interface SkillStep {
    id: string;
    text: string;
    refs: StepRef[];
}

export type RulePolarity = 'must' | 'never';

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

/** The Test column: the newest `skill_test_runs` row, per skill (GET / only). */
export interface LastTest {
    status: string;
    adviceCount: number;
    ranAt: string | null;
}

/** A JSON schema of the fields a skill hands back (`skills.output_schema`). */
export type OutputSchema = Record<string, unknown>;

export interface Skill {
    id: string;
    /** null for a personal skill — the org-less bucket owned by one user. */
    orgId: string | null;
    userId: string;
    name: string;
    description: string;
    /** "When to use it" on the web. Capped at SKILL_INSTRUCTIONS_MAX. */
    instructions: string;
    /** Text renderings of the structure, for reading. Never sent back. */
    workflow: string;
    rules: string;
    examples: string;
    icon: string;
    /** Visible to the whole org, or to `sharedGroups` when that is non-empty. */
    isShared: boolean;
    /**
     * Load the pack only when the model judges it relevant. A skill with an
     * `automationId` is treated as dynamic whatever this flag says.
     */
    dynamicActivation: boolean;
    sharedGroups: string[];
    /** The legacy scalar automation: when set it REPLACES the skill body. */
    automationId: string | null;
    enabledIntegrations: string[];
    /**
     * May THIS viewer edit the skill? The server's verdict, attached per row
     * from the same rule PUT enforces. Read fail-closed (`=== true`).
     */
    canEdit?: boolean;
    /** Raw structured facets, normalised by model/skillModel before use. */
    steps: unknown[];
    rulesV2: unknown[];
    examplesV2: unknown[];
    outputSchema: OutputSchema | null;
    knowledgeBaseIds: string[];
    allowedAutomationIds: string[];
    lastTest: LastTest | null;
    lastUsedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * What the editor holds and the autosave sends — the web's `draftOf`. Every
 * facet is normalised, so an editor never meets `undefined.length`.
 */
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

/** `GET /api/skills/usage-summary` — one entry per skill the server could count. */
export interface UsageSummaryEntry {
    agents: number;
    automations: number;
    lastUsedAt: string | null;
    automationsUnchecked?: boolean;
}

export type UsageSummary = Record<string, UsageSummaryEntry>;

/** One graded step of a test run (skillTest.parseGrading). */
export interface StepResult {
    stepId: string;
    title: string;
    evidence: string;
    status: string;
}

export interface TestRun {
    id: string;
    question: string;
    results: StepResult[];
    status: string;
    advice: string | null;
    ranAt: string | null;
}

export interface TestAgent {
    id: string;
    name: string;
    description: string;
}

/** The AI draft (POST /ai/draft): any facet may be missing. */
export interface SkillProposal {
    name?: string;
    description?: string;
    instructions?: string;
    steps?: unknown[];
    rulesV2?: unknown[];
    examplesV2?: unknown[];
    outputSchema?: OutputSchema | null;
}

/** routes/skills.js rejects anything longer, on both POST and PUT. */
export const SKILL_INSTRUCTIONS_MAX = 4000;

/**
 * How many skills may be active for one turn. Mirrors SKILL_CAP in agent-hub
 * SkillsPopover.jsx: every active pack is prepended to the system prompt.
 */
export const ACTIVE_SKILL_CAP = 5;
