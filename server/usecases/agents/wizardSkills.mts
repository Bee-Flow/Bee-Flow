/**
 * The skills an agent plan proposes, from the plan to stored rows.
 *
 *   draftPlannedSkills   after the wizard's plan call: every NEW skill gets a
 *                        structured draft (what it does, when to use it, steps,
 *                        rules, examples) from the skill editor's own drafter
 *   plannedSkillFields   one planned skill -> the fields `skillStore.createSkill`
 *                        takes; the ONE mapping, used by both save paths
 *   createPlannedSkills  reuse by id or name, otherwise create; used by
 *                        POST /agents/wizard/commit and POST /api/skills/from-plan
 *                        (the refine rail), so the two cannot drift apart
 *
 * ── THE DRAFTER IS THE EDITOR'S ─────────────────────────────────────
 * No second skill prompt lives here. A draft is `skillDraft.buildDraftMessages`
 * over a brief built from the plan's own lines, asked through
 * `skillDraftCall.askForDraft` (fast tier, forced `draft_skill` tool, one usage
 * row) and clamped by `skillDraft.parseSkillDraft`: exactly what "Let AI fill
 * it in" in the skill editor does.
 *
 * ── WHAT THE MODEL NEVER DECIDES ────────────────────────────────────
 * Grants and audience: `knowledgeBaseIds`, `allowedAutomationIds`,
 * `enabledIntegrations`, `isShared`, `sharedGroups` and `steps[].refs` are
 * never taken from a plan. A step ref of kind `kb` or `table` is a grant at
 * run time (skillInjection.resolveSkillGrants), so a draft that comes back
 * from the browser goes through `parseSkillDraft` again, which keeps only
 * the text of each step.
 *
 * ── A FAILED DRAFT NEVER BLOCKS THE AGENT ───────────────────────────
 * A draft that fails (no model, a throw, an unusable answer) is logged and
 * the skill stays the flat skill the plan described. Past the limit
 * (AGENT_WIZARD_SKILL_DRAFTS, default 5, 0 = no limit) the remaining new
 * skills stay flat too: each draft is one more model call.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const { envInt } = nodeRequire('../../utils/envNumber.mts') as {
    envInt: (name: string, def: number, bounds?: { min?: number; max?: number }) => number;
};
const { parseSkillDraft, buildDraftMessages } = nodeRequire('../../core/skills/skillDraft') as {
    parseSkillDraft: (structured: Record<string, unknown> | null, opts?: { mode?: 'draft' | 'improve' }) => SkillDraft | null;
    buildDraftMessages: (sentence: string) => Array<{ role: string; content: string }>;
};

export const SKILL_DRAFTS_ENV = 'AGENT_WIZARD_SKILL_DRAFTS';
export const DEFAULT_SKILL_DRAFTS = 5;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 1000;
const MAX_INSTRUCTIONS = 4000;

/** How many new skills of one plan get a structured draft; Infinity for 0 (no limit). */
export function skillDraftLimit(): number {
    const n = envInt(SKILL_DRAFTS_ENV, DEFAULT_SKILL_DRAFTS, { min: 0 });
    return n === 0 ? Infinity : n;
}

export type Activation = 'static' | 'dynamic';

/** The store's structured facets, as `parseSkillDraft` hands them back. */
export interface SkillDraft {
    name?: string;
    description?: string;
    instructions?: string;
    steps?: Array<{ id?: string; text: string; refs?: unknown[] }>;
    rulesV2?: Array<{ id?: string; polarity?: string; text: string }>;
    examplesV2?: Array<{ question?: string; good?: string; rationale?: string }>;
    outputSchema?: { type: string; properties: Record<string, { type?: string; title?: string }> } | null;
}

export interface PlannedSkill {
    id: string | null;
    name: string;
    description: string;
    instructions: string;
    activation: Activation;
    draft?: SkillDraft | null;
}

type SkillRef = { id: string; name?: string | null };

/**
 * A skill needed on every task is static (its whole text in every turn); one
 * for some situations is dynamic (one manifest line, loaded by activate_skill).
 * Anything that does not say "dynamic" is static, as every wizard skill was.
 */
export function activationOf(raw: unknown): Activation {
    if (raw === true) return 'dynamic';
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return v === 'dynamic' || v === 'situational' || v === 'when_relevant' ? 'dynamic' : 'static';
}

function text(v: unknown, max: number): string {
    return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

/** One skill of the model's plan, clamped to the fields a plan may carry. Null without a name. */
export function normalisePlannedSkill(raw: unknown): PlannedSkill | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const s = raw as Record<string, unknown>;
    const name = text(s.name, MAX_NAME);
    if (!name) return null;
    return {
        id: typeof s.id === 'string' && s.id.trim() ? s.id.trim() : null,
        name,
        description: text(s.description, MAX_DESCRIPTION),
        instructions: text(s.instructions, MAX_INSTRUCTIONS),
        activation: activationOf(s.activation ?? s.dynamicActivation),
    };
}

/** Index of the skills the caller can already see: by id, and by lower-cased name. */
function indexSkills(existing: SkillRef[]): { ids: Set<string>; byName: Map<string, string> } {
    const list = Array.isArray(existing) ? existing : [];
    return {
        ids: new Set(list.map(s => s.id)),
        byName: new Map(list.map(s => [String(s.name || '').toLowerCase().trim(), s.id])),
    };
}

/** The id of the existing skill this planned skill reuses (by id, then by name), or null. */
function reusedId(skill: { id?: string | null; name: string }, index: ReturnType<typeof indexSkills>): string | null {
    if (skill.id && index.ids.has(skill.id)) return skill.id;
    return index.byName.get(skill.name.toLowerCase().trim()) || null;
}

/** The brief the editor's drafter gets: the plan's own lines, plus the agent it is for. */
export function skillBrief(skill: PlannedSkill, agent: { name?: unknown; description?: unknown }): string {
    const agentLine = [text(agent.name, 100), text(agent.description, 300)].filter(Boolean).join(': ');
    return [
        `Skill: ${skill.name}`,
        skill.description ? `What it does: ${skill.description}` : '',
        skill.instructions ? `When to use it: ${skill.instructions}` : '',
        agentLine ? `It is a skill of this AI agent: ${agentLine}` : '',
    ].filter(Boolean).join('\n');
}

export interface DraftDeps {
    userId: string;
    userOrgId: string | null;
    existingSkills: SkillRef[];
    ask: (a: { messages: Array<{ role: string; content: string }>; userId: string; userOrgId: string | null; source: string }) =>
        Promise<{ structured: Record<string, unknown> | null } | null>;
    limit?: number;
    log?: { warn: (...a: unknown[]) => void };
}

/**
 * Give every NEW skill of the plan a structured draft, in place. A skill that
 * reuses an existing one (by id or by name) is left alone; so is every new
 * skill past the limit, and every skill whose draft fails.
 */
export async function draftPlannedSkills(plan: { name?: unknown; description?: unknown; skills?: PlannedSkill[] }, deps: DraftDeps): Promise<void> {
    const skills = Array.isArray(plan.skills) ? plan.skills : [];
    const index = indexSkills(deps.existingSkills);
    const limit = deps.limit ?? skillDraftLimit();
    const log = deps.log || (nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void });
    const fresh = skills.filter(s => !reusedId(s, index));
    const drafted = fresh.slice(0, limit);
    if (fresh.length > drafted.length) {
        log.warn(`[Wizard] ${fresh.length - drafted.length} new skill(s) stay plain: ${SKILL_DRAFTS_ENV} allows ${drafted.length} drafts per plan`);
    }
    await Promise.all(drafted.map(async (skill) => {
        try {
            const answer = await deps.ask({
                messages: buildDraftMessages(skillBrief(skill, plan)),
                userId: deps.userId,
                userOrgId: deps.userOrgId,
                source: 'skill_ai_draft',
            });
            const draft = answer ? parseSkillDraft(answer.structured, { mode: 'draft' }) : null;
            if (draft) { skill.draft = draft; return; }
            log.warn(`[Wizard] skill draft for "${skill.name}" was ${answer ? 'unusable' : 'not possible (no model)'}; it stays a plain skill`);
        } catch (err) {
            log.warn(`[Wizard] skill draft for "${skill.name}" failed; it stays a plain skill:`, (err as Error)?.message);
        }
    }));
}

/**
 * A stored-shape draft back into the drafter's tool shape, so it can pass
 * `parseSkillDraft` again. Only text survives: no step ids, no refs.
 */
function asToolArgs(name: string, draft: Record<string, unknown>): Record<string, unknown> {
    const rows = (v: unknown) => (Array.isArray(v) ? v.filter(r => r && typeof r === 'object') as Record<string, unknown>[] : []);
    const schema = draft.outputSchema as { properties?: Record<string, { type?: unknown; title?: unknown }> } | null | undefined;
    const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    return {
        name,
        description: draft.description,
        instructions: draft.instructions,
        steps: rows(draft.steps).map(s => ({ text: s.text })),
        rules: rows(draft.rulesV2).map(r => ({ polarity: r.polarity, text: r.text })),
        examples: rows(draft.examplesV2).map(e => ({ question: e.question, good: e.good, rationale: e.rationale })),
        outputFields: Object.entries(props).map(([key, p]) => ({ key, type: p?.type, title: p?.title })),
    };
}

/** What `skillStore.createSkill` takes for one planned skill, minus orgId and userId. */
export interface SkillCreateFields {
    name: string;
    description: string;
    instructions: string;
    workflow?: string;
    rules?: string;
    examples?: string;
    icon: null;
    isShared: false;
    sharedGroups: [];
    dynamicActivation: boolean;
    steps?: SkillDraft['steps'];
    rulesV2?: SkillDraft['rulesV2'];
    examplesV2?: SkillDraft['examplesV2'];
    outputSchema?: SkillDraft['outputSchema'];
}

/**
 * One planned skill -> the create fields. The draft is untrusted (it may have
 * travelled through the browser) and passes `parseSkillDraft` again; without
 * a usable draft this is exactly the plain skill the wizard always made.
 * The person's own name and one-liner win over the draft's.
 */
export function plannedSkillFields(raw: unknown): SkillCreateFields | null {
    const skill = normalisePlannedSkill(raw);
    if (!skill) return null;
    const rawDraft = (raw as Record<string, unknown>).draft;
    const draft = rawDraft && typeof rawDraft === 'object' && !Array.isArray(rawDraft)
        ? parseSkillDraft(asToolArgs(skill.name, rawDraft as Record<string, unknown>), { mode: 'draft' })
        : null;
    const common = {
        name: skill.name,
        description: skill.description || text(draft?.description, MAX_DESCRIPTION),
        instructions: text(draft?.instructions, MAX_INSTRUCTIONS) || skill.instructions,
        icon: null,
        isShared: false as const,
        sharedGroups: [] as [],
        dynamicActivation: skill.activation === 'dynamic',
    };
    if (!draft) return { ...common, workflow: '', rules: '', examples: '' };
    // No text facets next to the structure: the store renders them from it
    // (skillStructure.resolveBodyWrite), and '' there would clear them.
    return {
        ...common,
        ...(draft.steps ? { steps: draft.steps } : {}),
        ...(draft.rulesV2 ? { rulesV2: draft.rulesV2 } : {}),
        ...(draft.examplesV2 ? { examplesV2: draft.examplesV2 } : {}),
        ...(draft.outputSchema ? { outputSchema: draft.outputSchema } : {}),
    };
}

export interface CreateDeps {
    orgId: string | null;
    userId: string;
    store: {
        getAvailableSkills: (orgId: string | null, userId: string) => Promise<SkillRef[]>;
        createSkill: (args: Record<string, unknown>) => Promise<{ id?: string } & Record<string, unknown>>;
    };
    log?: { warn: (...a: unknown[]) => void };
}

/**
 * Reuse by id, then by name; otherwise create. One skill that fails is
 * skipped (logged), never the rest; a structured create the store refuses is
 * retried once as the plain skill.
 */
export async function createPlannedSkills(skills: unknown[], deps: CreateDeps):
    Promise<{ attachedSkillIds: string[]; createdSkills: Array<Record<string, unknown>> }> {
    const log = deps.log || (nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void });
    const attachedSkillIds: string[] = [];
    const createdSkills: Array<Record<string, unknown>> = [];
    const list = Array.isArray(skills) ? skills : [];
    if (list.length === 0) return { attachedSkillIds, createdSkills };

    let existing: SkillRef[] = [];
    try {
        existing = await deps.store.getAvailableSkills(deps.orgId, deps.userId);
    } catch (err) {
        log.warn('[Wizard] getAvailableSkills failed, will only create new skills:', (err as Error)?.message);
    }
    const index = indexSkills(existing || []);

    for (const raw of list) {
        const fields = plannedSkillFields(raw);
        if (!fields) continue;
        const reuse = reusedId({ id: (raw as { id?: string | null }).id ?? null, name: fields.name }, index);
        if (reuse) { if (!attachedSkillIds.includes(reuse)) attachedSkillIds.push(reuse); continue; }

        const created = await createOne(fields, deps, log);
        if (created?.id) {
            attachedSkillIds.push(created.id);
            createdSkills.push(created);
            index.byName.set(fields.name.toLowerCase().trim(), created.id);
        }
    }
    return { attachedSkillIds, createdSkills };
}

async function createOne(fields: SkillCreateFields, deps: CreateDeps, log: { warn: (...a: unknown[]) => void }) {
    const write = (f: Record<string, unknown>) => deps.store.createSkill({ orgId: deps.orgId, userId: deps.userId, ...f });
    try {
        const created = await write({ ...fields });
        if (!created?.id) log.warn('[Wizard] createSkill returned no id for', fields.name);
        return created;
    } catch (err) {
        log.warn('[Wizard] skill create failed for', fields.name, ':', (err as Error)?.message);
        if (!fields.steps && !fields.rulesV2 && !fields.examplesV2 && !fields.outputSchema) return null;
    }
    // The structure was refused: the plain skill still beats no skill.
    try {
        const { steps: _s, rulesV2: _r, examplesV2: _e, outputSchema: _o, ...plain } = fields;
        return await write({ ...plain, workflow: '', rules: '', examples: '' });
    } catch (err) {
        log.warn('[Wizard] plain skill create failed for', fields.name, ':', (err as Error)?.message);
        return null;
    }
}
