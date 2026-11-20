import type { ChatMessage } from '../agentEditor.types';
import type { EditorSnapshot, Ref, Setter } from '@/api/agentSaveTypes';
import type { Skill } from '@/api/queries/skills';
import type { PlannedSkill } from '../plannedSkills';
import { apiJson } from '@/api/typedRequest';
import { logger } from '@/utils/logger';

interface PlannedSkillDeps {
    setChat: Setter<ChatMessage[]>;
    stateRef: Ref<EditorSnapshot>;
    setAttachedSkillIds: (ids: string[]) => void;
    setAllSkills: Setter<Skill[] | null>;
    queueSave: (immediate?: boolean) => void;
    /** The request; a test hands in its own. */
    storePlannedSkills?: (body: FromPlanBody) => Promise<FromPlanAnswer>;
}

type FromPlanBody = { skills: Array<Omit<PlannedSkill, 'draft'> & { draft: Record<string, unknown> | null }> };
type FromPlanAnswer = { attachedSkillIds?: string[]; createdSkills?: Skill[] };

const storeThroughApi = (body: FromPlanBody) => apiJson<'POST /api/skills/from-plan', FromPlanAnswer>('POST /api/skills/from-plan', { body });

/**
 * "Add selected skills" and "Not now" on a skills turn of the refine rail.
 *
 * The chosen skills are stored by POST /api/skills/from-plan: the server's ONE
 * mapping from a planned skill to a stored one (structured draft, static or
 * dynamic, reuse by id or name), the same one POST /agents/wizard/commit uses.
 * The ids it answers are attached in one save, as the refinement itself is.
 */
export function createPlannedSkillActions({ setChat, stateRef, setAttachedSkillIds, setAllSkills, queueSave, storePlannedSkills = storeThroughApi }: PlannedSkillDeps) {
    const mark = (index: number, patch: Partial<ChatMessage>) => setChat(prev => {
        const m = prev[index];
        if (!m || m.role !== 'skills') return prev;
        const next = [...prev];
        next[index] = { ...m, ...patch };
        return next;
    });

    const add = async (index: number, chosen: PlannedSkill[]) => {
        if (chosen.length === 0) { mark(index, { skillsState: 'skipped' }); return; }
        mark(index, { skillsState: 'busy' });
        try {
            const body: FromPlanBody = { skills: chosen.map(({ id, name, description, instructions, activation, draft }) => ({ id, name, description, instructions, activation, draft: (draft ?? null) as Record<string, unknown> | null })) };
            const res = await storePlannedSkills(body);
            const added = Array.isArray(res?.attachedSkillIds) ? res.attachedSkillIds : [];
            const created = Array.isArray(res?.createdSkills) ? res.createdSkills : [];
            if (created.length > 0) setAllSkills(prev => [...(prev || []), ...created]);
            const current: string[] = Array.isArray(stateRef.current.config?.attachedSkillIds) ? stateRef.current.config.attachedSkillIds : [];
            const ids = Array.from(new Set([...current, ...added]));
            stateRef.current.config = { ...stateRef.current.config, attachedSkillIds: ids };
            setAttachedSkillIds(ids);
            queueSave(true);
            mark(index, { skillsState: 'added', addedCount: added.length });
        } catch (err) {
            logger.debug('planned skills not added — the turn says so', err);
            mark(index, { skillsState: 'failed' });
        }
    };

    const skip = (index: number) => mark(index, { skillsState: 'skipped' });

    return { add, skip };
}
