/**
 * Contract readers for /api/skills.
 *
 * Rows: server/stores/skillStore.js `mapRow`, plus the per-row `canEdit`
 * routes/skills.js attaches and the `lastTest` GET / adds
 * (getLastTestBySkillIds). The structured facets stay raw here and are
 * normalised by model/skillModel, the port of the web's own reader, so the
 * two clients cannot disagree about what a malformed step means.
 *
 * The side routes: `/usage-summary` → `{ summary }`, `/test-agents` →
 * `{ agents }` (routes/skills/test.js listAgents), `/:id/test-runs` →
 * `{ runs }` (skillStore _mapTestRun), `/ai/draft` → `{ draft }` and
 * `/:id/ai/improve` → `{ skill }` (routes/skills/ai.js).
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    LastTest,
    Skill,
    SkillProposal,
    StepResult,
    TestAgent,
    TestRun,
    UsageSummary,
    UsageSummaryEntry,
} from '../model/types';

const readLastTest: (raw: unknown) => LastTest | null = nullable(
    shapeOf({ status: field.str(''), adviceCount: field.num(0), ranAt: field.strOrNull }),
);

/**
 * `canEdit` stays undefined unless it is a real boolean: canEditSkill reads it
 * fail-closed, so an unknown verdict narrows to read-only.
 */
export const readSkill: (raw: unknown) => Skill = shapeOf({
    id: field.str(''),
    orgId: field.strOrNull,
    userId: field.str(''),
    name: field.str(''),
    description: field.str(''),
    instructions: field.str(''),
    workflow: field.str(''),
    rules: field.str(''),
    examples: field.str(''),
    icon: field.str(''),
    isShared: field.bool(false),
    dynamicActivation: field.bool(false),
    sharedGroups: field.strArray,
    automationId: field.strOrNull,
    enabledIntegrations: field.strArray,
    canEdit: field.optBool,
    steps: field.list(field.raw),
    rulesV2: field.list(field.raw),
    examplesV2: field.list(field.raw),
    outputSchema: field.recordOrNull,
    knowledgeBaseIds: field.strArray,
    allowedAutomationIds: field.strArray,
    lastTest: readLastTest,
    lastUsedAt: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

export const readSkills: (raw: unknown) => Skill[] = field.list(readSkill);

export const readSkillOrNull: (raw: unknown) => Skill | null = nullable(readSkill);

const readSummaryEntry: (raw: unknown) => UsageSummaryEntry = shapeOf({
    agents: field.num(0),
    automations: field.num(0),
    lastUsedAt: field.strOrNull,
    automationsUnchecked: field.optBool,
});

/** An entry the server did not send stays absent: an unknown count is not zero. */
export function readUsageSummary(raw: unknown): UsageSummary {
    const summary = pick(raw, 'summary');
    const out: UsageSummary = {};
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return out;
    for (const [id, entry] of Object.entries(summary)) {
        if (entry && typeof entry === 'object') out[id] = readSummaryEntry(entry);
    }
    return out;
}

const readTestAgentList = shapeListOf({ id: field.str(''), name: field.str(''), description: field.str('') });

export function readTestAgents(raw: unknown): TestAgent[] {
    return readTestAgentList(pick(raw, 'agents')).filter((a) => a.id);
}

const readStepResults = shapeListOf({
    stepId: field.str(''),
    title: field.str(''),
    evidence: field.str(''),
    status: field.str('warning'),
});

export const readTestRun: (raw: unknown) => TestRun = shapeOf({
    id: field.str(''),
    question: field.str(''),
    results: (value: unknown): StepResult[] => readStepResults(value),
    status: field.str('error'),
    advice: field.strOrNull,
    ranAt: field.strOrNull,
});

export function readTestRuns(raw: unknown): TestRun[] {
    return field.list(readTestRun)(pick(raw, 'runs'));
}

const readProposalShape = shapeOf({
    name: field.optStr,
    description: field.optStr,
    instructions: field.optStr,
    steps: field.optList(field.raw),
    rulesV2: field.optList(field.raw),
    examplesV2: field.optList(field.raw),
    outputSchema: (value: unknown) => field.optRecord<Record<string, unknown>>(value),
});

/** `{ draft }`, or null when the model's answer was not a skill. */
export function readProposal(raw: unknown): SkillProposal | null {
    const draft = pick(raw, 'draft');
    return draft && typeof draft === 'object' ? readProposalShape(draft) : null;
}

/** `{ skill }` — the STORED row the improve route wrote. */
export function readImproved(raw: unknown): Skill | null {
    return readSkillOrNull(pick(raw, 'skill') ?? raw);
}
