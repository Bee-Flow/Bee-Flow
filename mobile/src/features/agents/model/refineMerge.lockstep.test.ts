/**
 * Differential lockstep: the web's refineMerge.js and this port run on the
 * same fixtures and must agree. When this fails the web side changed — update
 * the port, never the fixtures.
 */

import * as port from './refineMerge';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../../agent-hub/src/components/agents/AgentWizard/state/refineMerge.js');

const base: port.RefineState = {
    name: 'Helpdesk',
    description: 'Answers IT questions',
    systemPrompt: 'You are the helpdesk.',
    avatar: '🤖',
    model: 'tier:fast',
    config: {
        enabledIntegrations: ['gmail'],
        attachedSkillIds: ['s1'],
        knowledge_base_ids: ['kb1'],
        memoryEnabled: true,
    },
};

const FIXTURES: {
    name: string;
    current: port.RefineState;
    plan: port.RefinedPlan;
    preserved: port.Preserved;
    opts: port.MergeOptions;
}[] = [
    { name: 'tone-only refine keeps everything curated', current: base, plan: { systemPrompt: 'Be formal.', enabledIntegrations: [], knowledge_base_ids: [] }, preserved: {}, opts: {} },
    { name: 'empty plan changes nothing', current: base, plan: {}, preserved: {}, opts: {} },
    {
        name: 'apps replaced and filtered by availability',
        current: base,
        plan: { enabledIntegrations: ['agent-search', 'nope'] },
        preserved: { enabledIntegrations: ['gmail'] },
        opts: { availableIntegrationIds: ['agent-search', 'gmail'] },
    },
    { name: 'a selectable tier applies', current: base, plan: { model: 'smart' }, preserved: {}, opts: { selectableTierKeys: ['fast', 'thinking'] } },
    { name: 'an unknown tier is ignored', current: base, plan: { model: 'thinking' }, preserved: {}, opts: { selectableTierKeys: ['fast'] } },
    { name: 'skills are the resolved union', current: base, plan: {}, preserved: {}, opts: { resolvedSkillIds: ['s1', 's2', 's2'] } },
    {
        name: 'fields persona written when no free instruction and no row yet',
        current: { ...base, systemPrompt: '', noStoredPersona: true },
        plan: { systemPrompt: 'New', persona: { who: 'A clerk', does: ['file'], doesNot: [], tone: { chips: ['warm'], text: '' } } },
        preserved: {},
        opts: {},
    },
    {
        name: 'free persona over existing instructions',
        current: { ...base, persona: { mode: 'free', freeText: 'Mine', who: 'x', language: 'nl' } },
        plan: { systemPrompt: 'Rewritten', description: 'New desc', capabilities: ['a', 'b'] },
        preserved: {},
        opts: {},
    },
    {
        name: 'unread persona is never written',
        current: base,
        plan: { systemPrompt: 'Rewritten', persona: { who: 'y' } },
        preserved: {},
        opts: {},
    },
    {
        name: 'name, avatar and description patched',
        current: base,
        plan: { name: 'Service desk', avatar: '🛠️', description: '', knowledge_base_ids: ['kb2'] },
        preserved: { knowledge_base_ids: ['kb1'] },
        opts: {},
    },
];

describe('refineMerge — lockstep with the web', () => {
    it.each(FIXTURES)('$name', ({ current, plan, preserved, opts }) => {
        const mine = port.mergeRefinedPlan(current, plan, preserved, opts);
        const theirs = web.mergeRefinedPlan(current, plan, preserved, opts);
        expect(mine).toEqual(theirs);
        expect(port.diffRefinedPlan(current, mine)).toEqual(web.diffRefinedPlan(current, theirs));
    });

    it('builds the same request context', () => {
        const input = {
            ...base,
            capabilities: ['x'],
            enabledIntegrations: ['gmail'],
            attachedSkills: [{ id: 's1', name: 'S' }],
            knowledge_base_ids: ['kb1'],
            persona: { who: 'w', does: ['d'], tone: { chips: [], text: '' } },
        };
        expect(port.buildRefineContext(input)).toEqual(web.buildRefineContext(input));
        expect(port.buildRefineContext({})).toEqual(web.buildRefineContext({}));
    });

    it('reads persona fields and free instructions alike', () => {
        for (const p of [null, [], {}, { who: ' a ' }, { tone: { chips: ['x', ''] } }, { does: 'no' }]) {
            expect(port.personaFieldsOf(p)).toEqual(web.personaFieldsOf(p));
        }
        for (const s of [{}, { systemPrompt: 'x' }, { persona: { mode: 'fields' }, systemPrompt: 'x' }, { persona: { freeText: ' y ' } }]) {
            expect(port.hasFreeInstruction(s as Partial<port.RefineState>)).toBe(web.hasFreeInstruction(s));
        }
    });
});
