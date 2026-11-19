// @vitest-environment node
/**
 * Adding the skills a refinement proposed. The chosen ones go to
 * POST /api/skills/from-plan (the server's one mapping, shared with the
 * wizard commit), the ids it answers are attached and saved in ONE save, and
 * a failure leaves the agent as it was with the turn saying so.
 */
import { describe, it, expect, vi } from 'vitest';

import { createPlannedSkillActions } from './plannedSkillActions';
import type { ChatMessage } from '../agentEditor.types';
import type { PlannedSkill } from '../plannedSkills';

const REPLY: PlannedSkill = {
    id: null, name: 'Reply drafts', description: 'Writes a draft reply', instructions: '', activation: 'dynamic',
    draft: { steps: [{ text: 'Read the e-mail' }] },
};

function setup(store: (body: unknown) => Promise<unknown>) {
    const chat: ChatMessage[] = [{ role: 'done' }, { role: 'skills', skills: [REPLY], skillsState: 'pending' }];
    const saves: boolean[] = [];
    let attached: string[] = [];
    let all: unknown[] | null = [];
    const stateRef = { current: { config: { attachedSkillIds: ['sk-old'] } } };
    const storePlannedSkills = vi.fn(store);
    const actions = createPlannedSkillActions({
        setChat: (fn) => { const next = typeof fn === 'function' ? fn(chat.slice()) : fn; chat.length = 0; chat.push(...next); },
        stateRef: stateRef as never,
        setAttachedSkillIds: (ids) => { attached = ids; },
        setAllSkills: (fn) => { all = typeof fn === 'function' ? fn(all as never) : fn; },
        queueSave: (immediate) => { saves.push(Boolean(immediate)); },
        storePlannedSkills: storePlannedSkills as never,
    });
    return { chat, saves, stateRef, actions, storePlannedSkills, getAttached: () => attached, getAll: () => all };
}

describe('createPlannedSkillActions', () => {
    it('stores the chosen skills through from-plan and attaches what it answers', async () => {
        const { chat, saves, stateRef, actions, storePlannedSkills, getAttached, getAll } = setup(async () => ({
            attachedSkillIds: ['sk-new'], createdSkills: [{ id: 'sk-new', name: 'Reply drafts' }],
        }));

        await actions.add(1, [REPLY]);

        expect(storePlannedSkills).toHaveBeenCalledWith({
            skills: [{ id: null, name: 'Reply drafts', description: 'Writes a draft reply', instructions: '', activation: 'dynamic', draft: { steps: [{ text: 'Read the e-mail' }] } }],
        });
        expect(stateRef.current.config.attachedSkillIds).toEqual(['sk-old', 'sk-new']);
        expect(getAttached()).toEqual(['sk-old', 'sk-new']);
        expect(getAll()).toEqual([{ id: 'sk-new', name: 'Reply drafts' }]);
        expect(saves).toEqual([true]);
        expect(chat[1]).toMatchObject({ role: 'skills', skillsState: 'added', addedCount: 1 });
    });

    it('nothing chosen is a skip: no request, no save', async () => {
        const { chat, saves, actions, storePlannedSkills } = setup(async () => ({}));
        await actions.add(1, []);
        expect(storePlannedSkills).not.toHaveBeenCalled();
        expect(saves).toEqual([]);
        expect(chat[1].skillsState).toBe('skipped');
    });

    it('a refused request leaves the agent alone and says so on the turn', async () => {
        const { chat, saves, stateRef, actions } = setup(async () => { throw new Error('403'); });
        await actions.add(1, [REPLY]);
        expect(stateRef.current.config.attachedSkillIds).toEqual(['sk-old']);
        expect(saves).toEqual([]);
        expect(chat[1].skillsState).toBe('failed');
    });

    it('skip marks the turn and touches nothing else', () => {
        const { chat, actions } = setup(async () => ({}));
        actions.skip(1);
        expect(chat[1].skillsState).toBe('skipped');
        expect(chat[0]).toEqual({ role: 'done' });
    });
});
