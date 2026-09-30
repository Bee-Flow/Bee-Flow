import type { AgentDetail } from './draft';
import { draftFromMerged, refineContextOf, refineStateOf, resolvedSkillIds } from './refineApply';

const AGENT: AgentDetail = {
    id: 'a1',
    name: 'Helpdesk',
    description: 'IT',
    avatar: '🤖',
    model: null,
    owner_id: 'u1',
    is_published: true,
    starter_prompts: null,
    config: { enabledIntegrations: ['gmail'], attachedSkillIds: ['s1'], knowledge_base_ids: ['kb1'], wizard: { capabilities: ['answer'] } },
    organization_id: 'o1',
    shared_groups: [],
    rev: 3,
    system_prompt: 'Help.',
    persona: { mode: 'free', freeText: 'Help.' },
    can_edit: true,
};

describe('refine glue', () => {
    it('asks the server with the saved agent and the skills named', () => {
        const ctx = refineContextOf(AGENT, new Map([['s1', 'Tickets']]));
        expect(ctx.plan).toMatchObject({ name: 'Helpdesk', systemPrompt: 'Help.', capabilities: ['answer'] });
        expect(ctx.current).toEqual({
            model: '',
            enabledIntegrations: ['gmail'],
            attachedSkills: [{ id: 's1', name: 'Tickets' }],
            knowledge_base_ids: ['kb1'],
        });
    });

    it('treats a missing persona column as unread', () => {
        expect(refineStateOf({ ...AGENT, persona: undefined }).state.persona).toBeUndefined();
        expect(refineStateOf(AGENT).state.persona).toEqual({ mode: 'free', freeText: 'Help.' });
    });

    it('adds only existing skills the plan named, never subtracts', () => {
        const plan = { skills: [{ id: 's2', name: 'x' }, { id: 'ghost', name: 'y' }, { id: null, name: 'new' }] };
        expect(resolvedSkillIds(['s1'], plan, new Set(['s1', 's2']))).toEqual(['s1', 's2']);
        expect(resolvedSkillIds(undefined, {}, new Set())).toEqual([]);
    });

    it('turns the merge back into a draft', () => {
        const { draft } = refineStateOf(AGENT);
        const next = draftFromMerged(draft, { ...draft, model: null, name: 'Desk', persona: undefined });
        expect(next).toMatchObject({ name: 'Desk', model: '', starterPrompts: [] });
    });
});
