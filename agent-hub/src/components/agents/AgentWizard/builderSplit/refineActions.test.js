/**
 * De verfijn-pijplijn van de editor (A2 stap 5, plus een bevestigde
 * A1c-bevinding).
 *
 * Vier dingen liggen hier vast, en alle vier zijn ze het soort dat stil
 * kapot gaat — geen crash, geen rode test, alleen een agent die iets anders
 * denkt dan hij zegt:
 *
 *   DE PERSONA REIST MEE. `mergeRefinedPlan` rekent hem sinds A1c uit, maar
 *   de enige aanroeper gooide hem weg: na een verfijning beschreef
 *   `agents.persona` een prompt die niet meer bestond, en de eerstvolgende
 *   opslag rendert die oude velden zó over de nieuwe instructies heen.
 *
 *   HET UNDO-PUNT WORDT VÓÓR DE MERGE GESCHREVEN, en pas NA een geslaagd
 *   antwoord — een mislukte verfijning laat geen herstelpunt achter.
 *
 *   EEN MISLUKTE SNAPSHOT STOPT DE VERFIJNING NIET, maar liegt er ook niet
 *   over: de beurt draagt dan `undoVersionId: null` en de kaart zegt dat.
 *
 *   DE BEURT DRAAGT DE DIFF, niet het plan dat het model terugstuurde.
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

// Elke test bouwt zijn eigen deps; alleen wat dit bestand beweert wordt
// bewaard, de rest is een lege functie.
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
            // De standaardopstelling is "er is nog geen rij" — de verse agent
            // die de wizard net aanmaakte. Zonder deze vlag betekent een
            // ontbrekende persona "niet gelezen", en dan schrijft de merge er
            // met opzet geen; zie de test hieronder.
            noStoredPersona: true,
            ...overrides,
        },
    };
}

/** Antwoordtabel op URL-fragment; alles wat er niet in staat is een 500. */
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
        // Zonder deze regel beschrijft agents.persona een prompt die niet
        // meer bestaat.
        expect(stateRef.current.persona).toBeTruthy();
        expect(stateRef.current.persona.mode).toBe('free');
        expect(stateRef.current.persona.freeText).toBe('Be brief and kind.');
    });

    it('een persona die NIET GELEZEN kon worden blijft staan — er reist er geen mee', async () => {
        // De agent bestaat en heeft een persona-kolom, maar `?draft=1` gaf hem
        // niet mee (403, of een antwoord zonder persona). Een verse persona
        // wegschrijven zou `unknown` en `language` weggooien — instellingen die
        // deze code nooit gelezen heeft.
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

        // Identiek object: de PUT stuurt hem terug zoals hij was, en een
        // handgemaakte rol wordt niet door een toonverfijning herschreven.
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
        // null, niet weggelaten: de kaart moet het verschil kunnen zien tussen
        // "geen herstelpunt" en "nog niet gevraagd".
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
