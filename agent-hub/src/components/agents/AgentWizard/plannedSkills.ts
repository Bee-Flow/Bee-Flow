// The skills an agent plan proposes (POST /agents/wizard/refine), as the
// refine rail shows them before anything is stored. The server drafts every
// NEW skill with the skill editor's own drafter (usecases/agents/wizardSkills)
// and stores the chosen ones through POST /api/skills/from-plan, the same
// mapping POST /agents/wizard/commit uses.

export type SkillActivation = 'static' | 'dynamic';

/** The structured draft of a new skill, as `skillDraft.parseSkillDraft` returns it. */
interface PlannedSkillDraft {
    description?: string;
    instructions?: string;
    steps?: Array<{ id?: string; text: string }>;
    rulesV2?: Array<{ id?: string; polarity?: string; text: string }>;
    examplesV2?: Array<{ question?: string; good?: string; rationale?: string }>;
    outputSchema?: Record<string, unknown> | null;
}

export interface PlannedSkill {
    id: string | null;
    name: string;
    description: string;
    instructions: string;
    activation: SkillActivation;
    draft?: PlannedSkillDraft | null;
}

/** One skill of the plan as the server sent it; only a named skill counts. */
function toPlannedSkill(raw: unknown): PlannedSkill | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name) return null;
    const draft = s.draft && typeof s.draft === 'object' ? (s.draft as PlannedSkillDraft) : null;
    return {
        id: typeof s.id === 'string' && s.id ? s.id : null,
        name,
        description: typeof s.description === 'string' ? s.description : '',
        instructions: typeof s.instructions === 'string' ? s.instructions : '',
        activation: s.activation === 'dynamic' ? 'dynamic' : 'static',
        ...(draft ? { draft } : {}),
    };
}

/** Split a plan's skills: the ones that already exist are attached, the new ones are proposed. */
export function splitPlannedSkills(rawSkills: unknown, existing: Array<{ id: string; name?: string | null }>): { attachIds: string[]; proposals: PlannedSkill[] } {
    const attachIds: string[] = [];
    const proposals: PlannedSkill[] = [];
    const ids = new Set(existing.map(s => s.id));
    const byName = new Map(existing.map(s => [String(s.name || '').toLowerCase().trim(), s.id]));
    for (const raw of Array.isArray(rawSkills) ? rawSkills : []) {
        const s = toPlannedSkill(raw);
        if (!s) continue;
        if (s.id) {
            // An id the caller cannot see is not attached, and not proposed either.
            if (ids.has(s.id)) attachIds.push(s.id);
            continue;
        }
        const sameName = byName.get(s.name.toLowerCase());
        if (sameName) attachIds.push(sameName);
        else if (!proposals.some(p => p.name.toLowerCase() === s.name.toLowerCase())) proposals.push(s);
    }
    return { attachIds, proposals };
}
