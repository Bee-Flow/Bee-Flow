/**
 * The refinement pipeline of the editor (A2 step 5, plus a confirmed A1c finding).
 *
 * Four things are fixed here, and all four are the kind that breaks silently. No
 * crash, no red test, just an agent that thinks something different from what it
 * says:
 *
 *   THE PERSONA TRAVELS ALONG. `mergeRefinedPlan` has calculated it since A1c, but
 *   the only caller threw it away. After a refinement, `agents.persona` described a
 *   prompt that no longer existed, and the next save renders those old fields over
 *   the new instructions.
 *
 *   THE UNDO POINT IS WRITTEN BEFORE THE MERGE, and only AFTER a successful answer.
 *   A failed refinement leaves no restore point.
 *
 *   A FAILED SNAPSHOT DOES NOT STOP THE REFINEMENT, but it does not lie about it
 *   either: the turn then carries `undoVersionId: null` and the card says so.
 *
 *   THE TURN CARRIES THE DIFF, not the plan that the model sent back.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/refineActions.test.js
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));

import { createHandleRefine } from './refineActions';
import { authFetch } from '../../../../utils/helpers';

const PLAN = {
    name: 'Support Bot',
    description: 'Helps with support',
    systemPrompt: 'Be brief and kind.',
    capabilities: ['answer questions'],
    enabledIntegrations: [],
    knowledge_base_ids: [],
    skills: [],
};

// Every test builds its own deps. Only what this file asserts is kept; the
// rest is an empty function.
function makeDeps(overrides = {}) {
    const chat = [];
    const calls = [];
    const stateRef = {
        current: {
            name: 'Support Bot',
            description: 'Helps with support',
            systemPrompt: 'Be helpful.',
            model: 'tier:fast',
            avatar: '🤖',
            config: { enabledIntegrations: ['gmail'], attachedSkillIds: [], knowledge_base_ids: [], wizard: { capabilities: [] } },
        },
    };
    const noop = () => {};
    return {
        calls,
        chat,
        stateRef,
        deps: {
            chat,
            setChat: (fn) => { const next = fn(chat.slice()); chat.length = 0; chat.push(...next); },
            chatInput: 'make it brief',
            setChatInput: noop,
            chatBusy: false,
            setChatBusy: noop,
            setRefining: noop,
            setInstructionsEditing: noop,
            dirtyRef: { current: false },
            flush: async () => {},
            attachedSkillIds: [],
            setAttachedSkillIds: noop,
            skillNamesById: new Map(),
            name: 'Support Bot',
            setName: noop,
            description: 'Helps with support',
            setDescription: noop,
            avatar: '🤖',
            setAvatar: noop,
            setInstructions: noop,
            setModel: noop,
            setSelectedTier: noop,
            setEnabledIntegrations: noop,
            setKnowledgeBaseIds: noop,
            stateRef,
            plan: null,
            chatTier: 'fast',
            tier: 'fast',
            locale: 'en',
            t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
            allSkills: [],
            setAllSkills: noop,
            availableIntegrations: [{ id: 'gmail' }, { id: 'slack' }],
            tiers: {},
            queueSave: () => calls.push('queueSave'),
            schedulesAllowed: false,
            agent: { id: 'agent-1' },
            refreshAgentSchedules: async () => {},
            currentPersona: undefined,
            // The default setup is "there is no row yet": the fresh agent
            // that the wizard just created. Without this flag a missing persona
            // means "not read", and then the merge deliberately writes none.
            // See the test below.
            noStoredPersona: true,
            ...overrides,
        },
    };
}

/** Answer table on URL fragment; anything not in it is a 500. */
function answerWith(routes, calls) {
    authFetch.mockImplementation(async (url, opts) => {
        calls.push(`${opts?.method || 'GET'} ${url}`);
        for (const [match, body] of routes) {
            if (url.includes(match)) {
                if (body === false) return { ok: false, status: 500, json: async () => ({}) };
                return { ok: true, json: async () => body };
            }
        }
        return { ok: false, status: 500, json: async () => ({}) };
    });
}

beforeEach(() => { authFetch.mockReset(); });

describe('createHandleRefine — de persona reist mee (A1c-bevinding)', () => {
    it('zet de gemergede persona op stateRef zodat de opslag hem meestuurt', async () => {
        const { deps, stateRef, calls } = makeDeps();
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: PLAN, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        expect(stateRef.current.systemPrompt).toBe('Be brief and kind.');
        // Without this line agents.persona describes a prompt
        // that no longer exists.
        expect(stateRef.current.persona).toBeTruthy();
        expect(stateRef.current.persona.mode).toBe('free');
        expect(stateRef.current.persona.freeText).toBe('Be brief and kind.');
    });

    it('een persona die NIET GELEZEN kon worden blijft staan — er reist er geen mee', async () => {
        // The agent exists and has a persona column, but `?draft=1` did not include
        // it (a 403, or a response without a persona). Writing a fresh persona would
        // throw away `unknown` and `language`: settings that this code never read.
        const { deps, stateRef, calls } = makeDeps({ currentPersona: undefined, noStoredPersona: false });
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: PLAN, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        expect(stateRef.current.systemPrompt).toBe('Be brief and kind.');
        expect(stateRef.current.persona).toBeUndefined();
    });

    it('een verfijning die de prompt NIET aanraakt laat de persona ongemoeid', async () => {
        const stored = { who: 'De concierge', does: ['boeken'], mode: 'fields', language: 'nl' };
        const { deps, stateRef, calls } = makeDeps({ currentPersona: stored });
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: { ...PLAN, systemPrompt: 'Be helpful.' }, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        // Identical object: the PUT sends it back the way it was, and a hand-made role
        // is not rewritten by a tone refinement.
        expect(stateRef.current.persona).toBe(stored);
    });

    it('draagt de instellingen die de verfijning niet noemt over uit de opgeslagen persona', async () => {
        const stored = { who: 'De concierge', does: ['boeken'], mode: 'fields', language: 'nl', tone: 'formal' };
        const { deps, stateRef, calls } = makeDeps({ currentPersona: stored });
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: PLAN, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        expect(stateRef.current.persona.mode).toBe('free');
        expect(stateRef.current.persona.language).toBe('nl');
        expect(stateRef.current.persona.tone).toBe('formal');
    });
});

describe('createHandleRefine — het undo-punt', () => {
    it('schrijft de pre_refine-rij NA het antwoord en VÓÓR de opslag', async () => {
        const { deps, calls } = makeDeps();
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: PLAN, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        expect(calls).toEqual([
            'POST /agents/wizard/refine',
            'POST /versions/agent-1/pre-refine',
            'queueSave',
        ]);
    });

    it('hangt de version-id aan de Gedaan-beurt', async () => {
        const { deps, chat, calls } = makeDeps();
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: PLAN, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        const done = chat.find(m => m.role === 'done');
        expect(done.undoVersionId).toBe('v-pre');
        expect(done.undoState).toBe('idle');
    });

    it('een mislukte snapshot stopt de verfijning niet, maar levert GEEN herstelpunt', async () => {
        const { deps, chat, stateRef, calls } = makeDeps();
        answerWith([
            ['/pre-refine', false],
            ['/agents/wizard/refine', { plan: PLAN, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        expect(stateRef.current.systemPrompt).toBe('Be brief and kind.');
        const done = chat.find(m => m.role === 'done');
        // null, not omitted: the card must be able to see the difference between
        // "no restore point" and "not yet asked".
        expect(done.undoVersionId).toBeNull();
    });

    it('een mislukte verfijning laat helemaal geen herstelpunt achter', async () => {
        const { deps, chat, calls } = makeDeps();
        answerWith([['/agents/wizard/refine', false]], calls);

        await createHandleRefine(deps)();

        expect(calls).toEqual(['POST /agents/wizard/refine']);
        expect(chat.some(m => m.role === 'done')).toBe(false);
        expect(chat.some(m => m.role === 'error')).toBe(true);
    });

    it('een concept zonder id vraagt er niet eens om — er valt niets te herstellen', async () => {
        const { deps, chat, calls } = makeDeps({ agent: null });
        answerWith([['/agents/wizard/refine', { plan: PLAN, preserved: {} }]], calls);

        await createHandleRefine(deps)();

        expect(calls.filter(c => c.includes('pre-refine'))).toEqual([]);
        expect(chat.find(m => m.role === 'done').undoVersionId).toBeNull();
    });
});

describe('createHandleRefine — de Gedaan-beurt draagt de diff', () => {
    it('noemt de herschreven instructies en de aangezette app', async () => {
        const { deps, chat, calls } = makeDeps();
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: { ...PLAN, enabledIntegrations: ['gmail', 'slack'] }, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        const done = chat.find(m => m.role === 'done');
        expect(done.changes).toEqual([
            { field: 'systemPrompt' },
            { field: 'apps', direction: 'added', count: 1, ids: ['slack'] },
        ]);
    });

    it('een verfijning die niets veranderde levert een lege lijst — geen plankaart', async () => {
        const { deps, chat, calls } = makeDeps();
        answerWith([
            ['/pre-refine', { id: 'v-pre' }],
            ['/agents/wizard/refine', { plan: { ...PLAN, systemPrompt: 'Be helpful.' }, preserved: {} }],
        ], calls);

        await createHandleRefine(deps)();

        const done = chat.find(m => m.role === 'done');
        expect(done.changes).toEqual([]);
        expect(chat.some(m => m.role === 'plan')).toBe(false);
    });
});
