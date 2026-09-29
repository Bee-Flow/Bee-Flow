import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillsStudio from './index';
import { skillsApi } from './skillsApi';
import { queryWrapper } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * S2 deel D — de 280px-lijst links, en de tab "Gebruikt door".
 *
 * Beide schermen bestaan om ÉÉN vraag te beantwoorden: gebruikt iets deze
 * skill? De interessante gevallen zijn daarom niet de gelukte lezingen maar
 * de mislukte, want daar lijkt "ik weet het niet" precies op "nee":
 *
 *   - een skill-lijst die niet gelezen kon worden ziet er identiek uit aan
 *     een lege organisatie ("Nog geen skills — maak er een"), en de toast
 *     die het uitlegt is na vijf seconden weg;
 *   - een filter dat niets vindt zei hetzelfde, terwijl er wél skills zijn;
 *   - een gebruiks-telling die niet gelezen kon worden is geen 0, dus de
 *     regel eronder blijft leeg — niet "nog niet gekoppeld";
 *   - en op de tab "Gebruikt door" mogen "niets gebruikt dit" en het
 *     streepjes-pilletje "not used by anything" alleen op het scherm staan
 *     als er echt GEKEKEN is.
 *
 * De gebruiksregel zelf telt over soorten heen ("3 agents · 1 automation")
 * en gebruikt het sleutelpaar met de ternary om de SLEUTEL — één agent is
 * "1 agent", nooit "1 agent(s)".
 */

const GROUPS = [{ id: 'g1', name: 'Sales' }];
const AUTOMATIONS = { automations: [{ id: 'a1', title: 'Look up quote status', triggerType: 'agent_call' }] };
const KBS = [{ id: 'k1', name: 'Quote terms' }];
const TABLES = { datatables: [{ id: 't1', name: 'Pricelist' }] };

// Wat `GET /api/skills/:id/usage` deze test teruggeeft. Per test te zetten:
// `{ ok, body }` — zo kan één mock zowel een geslaagde lezing als een 500 en
// een gedeeltelijk antwoord (`unchecked`) spelen.
let usageReply = { ok: true, body: { usage: [] } };

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/usage')) {
            return { ok: usageReply.ok, status: usageReply.ok ? 200 : 500, json: async () => usageReply.body };
        }
        const body = u.includes('/auth/groups') ? GROUPS
            : u.includes('/api/automation') ? AUTOMATIONS
                : u.includes('/api/kb') ? KBS
                    : u.includes('/api/datatables') ? TABLES
                        : u.includes('/test-runs') ? { runs: [] }
                            : {};
        return { ok: true, status: 200, json: async () => body };
    }),
}));

// Zoals in SkillsStudio.test.jsx: de AI-stap-editor sleept de hele
// builder-instellingenketen mee; alleen zijn rij-contract wordt hier gebruikt.
vi.mock('../../../automation/Builder/flow/settings/aiStepEditors', () => ({
    StructuredOutputFields: ({ fields, onChange }) => (
        <button type="button" data-testid="stub-output-rows" onClick={() => onChange([...fields, { key: 'total', type: 'number' }])}>
            add output field ({fields.length})
        </button>
    ),
}));

vi.mock('./skillsApi', () => {
    const api = {
        list: vi.fn(), usageSummary: vi.fn(), get: vi.fn(), create: vi.fn(),
        update: vi.fn(), remove: vi.fn(), improve: vi.fn(), draft: vi.fn(),
        exampleConversations: vi.fn(), exampleMessages: vi.fn(), exampleFromMessage: vi.fn(),
        test: vi.fn(), testAgents: vi.fn(async () => ({ agents: [] })), testRuns: vi.fn(async () => ({ runs: [] })),
    };
    return { skillsApi: api, default: api };
});

const SKILL = {
    id: 's1',
    name: 'Explain a quote to a customer',
    description: 'Explains a quote line by line.',
    instructions: 'When someone asks what something means.',
    // De emoji leeft nog in de kolom — hij hoort alleen niet in Studio.
    icon: '🎯',
    canEdit: true,
    isShared: false,
    sharedGroups: [],
    dynamicActivation: false,
    enabledIntegrations: [],
    knowledgeBaseIds: [],
    allowedAutomationIds: [],
    outputSchema: null,
    steps: [{ id: 'st1', text: 'Fetch the quote.', refs: [] }],
    rulesV2: [],
    examplesV2: [],
    lastTest: null,
};

const OTHER = { ...SKILL, id: 's2', name: 'Chase an unpaid invoice', icon: '💸' };

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    usageReply = { ok: true, body: { usage: [] } };
    skillsApi.list.mockResolvedValue([SKILL, OTHER]);
    skillsApi.usageSummary.mockResolvedValue({ summary: {} });
    skillsApi.update.mockResolvedValue({ success: true });
});

afterEach(() => cleanup());

const renderStudio = (props = {}) => render(
    <SkillsStudio user={{ id: 'u1', orgRole: 'org_admin' }} onNavigate={() => {}} {...props} />,
);

const rowOf = (id) => screen.getAllByTestId('skill-row').find(r => r.getAttribute('data-skill-id') === id);

describe('de gebruiksregel onder een skill', () => {
    it('telt over soorten heen, met enkelvoud en meervoud uit het sleutelpaar', async () => {
        skillsApi.usageSummary.mockResolvedValue({
            summary: {
                s1: { agents: 1, automations: 2 },
                s2: { agents: 3, automations: 1 },
            },
        });
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await waitFor(() => expect(within(rowOf('s1')).getByText('1 agent · 2 automations')).toBeTruthy());
        expect(within(rowOf('s2')).getByText('3 agents · 1 automation')).toBeTruthy();
    });

    it('laat een soort die nul is weg in plaats van "0 automations" te schrijven', async () => {
        skillsApi.usageSummary.mockResolvedValue({ summary: { s1: { agents: 2, automations: 0 } } });
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await waitFor(() => expect(within(rowOf('s1')).getByText('2 agents')).toBeTruthy());
        expect(within(rowOf('s1')).queryByText(/automation/)).toBeNull();
    });

    it('zegt "not linked yet" alleen bij een telling die WEL binnenkwam', async () => {
        skillsApi.usageSummary.mockResolvedValue({ summary: { s1: { agents: 0, automations: 0 } } });
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await waitFor(() => expect(within(rowOf('s1')).getByText('not linked yet')).toBeTruthy());
        // s2 zit niet in de samenvatting: over die skill is niets bekend.
        expect(within(rowOf('s2')).queryByText('not linked yet')).toBeNull();
    });

    it('laat de regel leeg als de telling niet gelezen kon worden — de rij blijft staan', async () => {
        skillsApi.usageSummary.mockRejectedValue(new Error('boom'));
        renderStudio();
        await screen.findAllByTestId('skill-row');
        expect(within(rowOf('s1')).getByText('Explain a quote to a customer')).toBeTruthy();
        expect(within(rowOf('s1')).queryByText('not linked yet')).toBeNull();
        expect(within(rowOf('s1')).queryByText(/agent|automation/)).toBeNull();
    });
});

describe('de lijst zelf', () => {
    it('draagt het merk van de soort, niet de emoji van de skill', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        // De kolom `icon` blijft bestaan (chat-oppervlakken lezen hem), maar
        // twaalf emoji onder elkaar zeggen niet "skill" — Studio tekent één
        // merk voor de hele soort.
        expect(rowOf('s1').textContent).not.toContain('🎯');
        expect(rowOf('s2').textContent).not.toContain('💸');
        expect(rowOf('s1').querySelector('svg')).toBeTruthy();
    });

    it('zegt dat de lijst niet gelezen kon worden, in plaats van "nog geen skills"', async () => {
        skillsApi.list.mockRejectedValue(new Error('500'));
        renderStudio();
        expect(await screen.findByTestId('skills-list-error')).toBeTruthy();
        expect(screen.queryByText(/No skills yet/)).toBeNull();
    });

    it('zet dan ook geen 0 naast de titel — nul is een antwoord dat niemand gaf', async () => {
        skillsApi.list.mockRejectedValue(new Error('500'));
        renderStudio();
        await screen.findByTestId('skills-list-error');
        expect(screen.queryByTestId('skills-list-count')).toBeNull();
    });

    it('telt wat er staat zodra de lijst er WEL is', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        expect(screen.getByTestId('skills-list-count').textContent).toBe('2');
    });

    it('zegt bij een filter zonder treffers dat er niets matcht, niet dat er niets is', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        fireEvent.change(screen.getByTestId('skills-filter'), { target: { value: 'zzzz' } });
        expect(screen.queryByTestId('skill-row')).toBeNull();
        expect(screen.getByTestId('skills-list-nomatch')).toBeTruthy();
        expect(screen.queryByText(/No skills yet/)).toBeNull();
        // …en dat wordt óók gemeld. Deze zin verschijnt als reactie op typen —
        // het moment waarop een schermlezer verder niets te horen krijgt en de
        // rijen gewoon verdwijnen. De foutzin ernaast had role="status", deze
        // niet, en het is dezelfde tak in hetzelfde nieuwe scherm.
        expect(screen.getByTestId('skills-list-nomatch').getAttribute('role')).toBe('status');
    });

    /**
     * Tijdens de lezing is `rows.length` 0 omdat er nog niets binnen is, niet
     * omdat er niets is. De eigen regel in dit bestand ("alleen een telling die
     * GETELD is") geldt ook vóór het antwoord: met een `list()` die nooit
     * resolvet stond er letterlijk "Skills 0 · Loading skills…".
     */
    it('zet geen 0 naast de titel zolang de lijst nog onderweg is', async () => {
        skillsApi.list.mockReturnValue(new Promise(() => {}));
        skillsApi.usageSummary.mockReturnValue(new Promise(() => {}));
        renderStudio();
        // Twee keer: de lijst links en de landing rechts zeggen het allebei.
        expect((await screen.findAllByText('Loading skills…')).length).toBeGreaterThan(0);
        expect(screen.queryByTestId('skills-list-count')).toBeNull();
        // …en ook op de landing staat geen 0 naast "All skills".
        expect(screen.getByTestId('skills-overview').textContent).not.toMatch(/All skills\s*0/);
    });

    /**
     * De foutzin komt uit `t()`, en zonder TranslationProvider geeft
     * `useTranslation` bij ELKE render een nieuwe `t` terug (embeds,
     * geïsoleerde tests). Een `useCallback` die daarvan afhangt en vanuit een
     * mount-effect wordt aangeroepen, haalt de lijst dus eindeloos opnieuw op
     * — met een spinner die nooit weggaat. De zin wordt daarom tijdens de
     * render opgelost; deze test is wat die keuze vasthoudt.
     */
    it('haalt de lijst één keer op, niet bij elke render', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        await new Promise(r => setTimeout(r, 30));
        expect(skillsApi.list).toHaveBeenCalledTimes(1);
        expect(skillsApi.usageSummary).toHaveBeenCalledTimes(1);
    });

    it('houdt "nog geen skills" over voor een organisatie die er echt geen heeft', async () => {
        skillsApi.list.mockResolvedValue([]);
        renderStudio();
        expect(await screen.findByText(/No skills yet/)).toBeTruthy();
        expect(screen.queryByTestId('skills-list-error')).toBeNull();
        expect(screen.queryByTestId('skills-list-nomatch')).toBeNull();
    });
});

describe('de landing zonder selectie', () => {
    it('nodigt niet uit om een eerste skill te maken als de lijst niet gelezen kon worden', async () => {
        skillsApi.list.mockRejectedValue(new Error('500'));
        renderStudio();
        expect(await screen.findByTestId('skills-overview-error')).toBeTruthy();
        expect(screen.queryByText(/Create your first skill/)).toBeNull();
    });

    it('nodigt wél uit als er echt niets is', async () => {
        skillsApi.list.mockResolvedValue([]);
        renderStudio();
        expect(await screen.findByText(/Create your first skill/)).toBeTruthy();
        expect(screen.queryByTestId('skills-overview-error')).toBeNull();
    });

    /**
     * De grootste versie van dezelfde leugen. De linkerlijst zei correct "No
     * skill matches “zzzz”", en op het grootste vlak van hetzelfde scherm
     * stond tegelijk "Create your first skill" — een uitnodiging om werk over
     * te doen dat één backspace verderop staat. De landing kreeg de
     * GEFILTERDE lijst maar niet het filter, en kon de twee dus niet
     * onderscheiden.
     */
    it('nodigt ook niet uit als het filter niets vindt — er zijn wél skills', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        fireEvent.change(screen.getByTestId('skills-filter'), { target: { value: 'zzzz' } });

        expect(screen.queryByText(/Create your first skill/)).toBeNull();
        expect(screen.queryByTestId('skills-overview-empty')).toBeNull();
        const note = screen.getByTestId('skills-overview-nomatch');
        expect(note.textContent).toContain('zzzz');
        expect(note.getAttribute('role')).toBe('status');
        // De lijst links zegt hetzelfde, dus het scherm spreekt zichzelf niet
        // meer tegen.
        expect(screen.getByTestId('skills-list-nomatch')).toBeTruthy();
    });

    it('laat de uitnodiging weer zien zodra het filter leeg is', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        fireEvent.change(screen.getByTestId('skills-filter'), { target: { value: 'zzzz' } });
        expect(screen.getByTestId('skills-overview-nomatch')).toBeTruthy();
        fireEvent.change(screen.getByTestId('skills-filter'), { target: { value: '' } });
        expect(screen.queryByTestId('skills-overview-nomatch')).toBeNull();
        expect(screen.getAllByTestId('skills-overview-row').length).toBe(2);
    });
});

describe('de tab "Gebruikt door"', () => {
    const openUsage = async () => {
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-detail');
        fireEvent.click(screen.getByRole('radio', { name: /Used by/ }));
        return screen.findByTestId('used-by');
    };

    it('beweert niets over wie de skill gebruikt als de lezing mislukte', async () => {
        usageReply = { ok: false, body: { error: 'boom' } };
        await openUsage();
        expect(screen.queryByText(/No agent or automation uses this skill yet/)).toBeNull();
        expect(screen.queryByText('not used by anything')).toBeNull();
        // ...en het zegt WELKE soorten ongecontroleerd bleven.
        const note = screen.getByTestId('usage-unchecked');
        expect(note.textContent).toContain('agents');
        expect(note.textContent).toContain('automations');
    });

    it('zegt het gewoon als er echt gekeken is en niets gevonden werd', async () => {
        usageReply = { ok: true, body: { usage: [] } };
        await openUsage();
        expect(screen.getByText('No agent or automation uses this skill yet.')).toBeTruthy();
        expect(screen.getByText('not used by anything')).toBeTruthy();
        expect(screen.queryByTestId('usage-unchecked')).toBeNull();
    });

    it('draagt de soorten die de SERVER niet kon controleren door naar het scherm', async () => {
        usageReply = { ok: true, body: { usage: [], unchecked: ['automation'] } };
        await openUsage();
        expect(screen.queryByText(/No agent or automation uses this skill yet/)).toBeNull();
        expect(screen.getByTestId('usage-unchecked').textContent).toContain('automations');
        expect(screen.queryByText('not used by anything')).toBeNull();
    });

    it('toont de rijen die er wél zijn, met de telling op de tab', async () => {
        usageReply = {
            ok: true,
            body: {
                usage: [
                    { kind: 'agent', id: 'ag1', title: 'Quote assistant', role: 'chat', ownerId: null },
                    { kind: 'automation', id: 'au1', title: 'Send quote', role: 'ai_step', ownerId: null },
                ],
            },
        };
        await openUsage();
        expect(screen.getByText('Quote assistant')).toBeTruthy();
        expect(screen.getByText('Send quote')).toBeTruthy();
        expect(screen.getAllByRole('radio')[3].textContent).toContain('2');
    });

    it('zet geen telling op de tab na een mislukte lezing', async () => {
        usageReply = { ok: false, body: { error: 'boom' } };
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-detail');
        await new Promise(r => setTimeout(r, 0));
        const usedBy = screen.getAllByRole('radio')[3];
        expect(usedBy.textContent).toContain('Used by');
        expect(usedBy.textContent).not.toMatch(/\d/);
    });
});

/**
 * S3 — het overzicht mag niets aanbieden dat de server weigert.
 *
 * "Let AI fill it in" roept `POST /:id/ai/improve` aan, en dat endpoint
 * antwoordt 403 `not_editable` op een skill die dit account wel mag ZIEN maar
 * niet mag BEWERKEN (een via groepen gedeelde skill van een andere org). Een
 * knop die gegarandeerd op een weigering uitloopt is geen aanbod.
 *
 * De grens is `canEdit !== false`, niet `=== true`: een rij uit een ouder
 * leespad draagt helemaal geen `canEdit`, en die mag niet stilletjes het
 * aanbod verliezen — alleen een expliciet "nee" van de server telt.
 */
describe('het aanbod op een lege rij in het overzicht', () => {
    const EMPTY = {
        ...SKILL,
        id: 's3',
        name: 'Ongeschreven skill',
        description: '',
        steps: [],
        rulesV2: [],
        examplesV2: [],
    };
    const rowOfOverview = (id) => screen.getAllByTestId('skills-overview-row')
        .find(r => r.getAttribute('data-skill-id') === id);

    it('an editable empty skill IS offered "Let AI fill it in"', async () => {
        skillsApi.list.mockResolvedValue([{ ...EMPTY, canEdit: true }]);
        renderStudio();
        await screen.findAllByTestId('skills-overview-row');
        expect(within(rowOfOverview('s3')).getByTestId('skills-overview-fill')).toBeTruthy();
    });

    it('a read-only empty skill is not offered "Let AI fill it in"', async () => {
        skillsApi.list.mockResolvedValue([{ ...EMPTY, canEdit: false }]);
        renderStudio();
        await screen.findAllByTestId('skills-overview-row');
        const row = rowOfOverview('s3');
        expect(within(row).queryByTestId('skills-overview-fill')).toBeNull();
        // De rij verdwijnt niet: hij valt terug op de gewone testchip.
        expect(within(row).getByTestId('skills-overview-test')).toBeTruthy();
    });

    it('a row that carries no canEdit at all keeps the offer', async () => {
        const { canEdit, ...noFlag } = EMPTY;
        skillsApi.list.mockResolvedValue([noFlag]);
        renderStudio();
        await screen.findAllByTestId('skills-overview-row');
        expect(within(rowOfOverview('s3')).getByTestId('skills-overview-fill')).toBeTruthy();
    });
});

// De mock hierboven is bewust globaal: als een test hem niet zet, blijft de
// vorige stand staan en zou een groene test iets anders bewijzen dan hij zegt.
afterEach(() => { authFetch.mockClear(); });
