/**
 * Smoke tests pinning the BuilderSplit decomposition (./builderSplit/ modules).
 *
 * BuilderSplit had no direct suite before the split. All state and hooks still
 * live on the BuilderSplit fiber; the panes/modals/handlers were moved verbatim
 * into ./builderSplit/ and receive everything via props or factory deps. These
 * renders guard that prop/dep threading — a missed binding surfaces here as a
 * render-time TypeError/ReferenceError.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/BuilderSplit.test.jsx
 */
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: false, json: async () => ({}), text: async () => '' })),
    parseSaveError: vi.fn(async () => ({ message: 'save failed' })),
}));
// Keep the smoke test light: the markdown pipeline is irrelevant here.
vi.mock('../../renderers/MarkdownRenderer', () => ({
    default: ({ content }) => <div data-testid="markdown">{content}</div>,
}));
/**
 * Eigen vertaler in plaats van de gedeelde stub, om precies de reden die in
 * `src/test/i18n.ts` staat: die stub geeft de fallback ONGEWIJZIGD terug, dus
 * "{count} documents" blijft daar letterlijk staan. De echte hook vult de
 * placeholders wél in, en dit bestand beweert dingen over de zin die de
 * gebruiker leest ("42 documents"). Zelfde regel als de echte t():
 * een string als tweede argument is de fallback, anders zijn het de params.
 */
vi.mock('../../../hooks/useTranslation', () => {
    const t = (key, fallbackOrParams, paramsArg) => {
        const hasStringFallback = typeof fallbackOrParams === 'string';
        const params = hasStringFallback ? paramsArg : fallbackOrParams;
        let value = hasStringFallback ? fallbackOrParams : key;
        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
        }
        return value;
    };
    const useTranslation = () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} });
    return { default: useTranslation, useTranslation, TranslationProvider: ({ children }) => children };
});

import BuilderSplit from './BuilderSplit';
import { authFetch } from '../../../utils/helpers';

// De standaardmock antwoordt overal met ok:false. Een test die een geslaagde
// lezing nodig heeft zet er tijdelijk een eigen antwoordtabel voor en zet die
// daarna terug — anders lekt hij naar de volgende test.
const DEFAULT_FETCH = authFetch.getMockImplementation();
function answerWith(routes) {
    authFetch.mockImplementation(async (url) => {
        for (const [match, body] of routes) {
            if (url.includes(match)) return { ok: true, json: async () => body, text: async () => '' };
        }
        return { ok: false, json: async () => ({}), text: async () => '' };
    });
}

const agent = {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    system_prompt: 'Do the thing.',
    is_published: 0,
    config: {},
    updated_at: '2026-08-01T10:00:00Z',
    rev: 3,
};

const baseProps = {
    agent,
    plan: null,
    history: [],
    tier: 'fast',
    locale: 'en',
    onBack: () => {},
    onPublished: () => {},
};

afterEach(() => { cleanup(); authFetch.mockImplementation(DEFAULT_FETCH); });

describe('BuilderSplit (decomposed layout smoke)', () => {
    it('renders the chat rail and the config panel in edit mode', () => {
        render(<BuilderSplit {...baseProps} />);
        // Left rail (BuilderChatPanel) empty-state.
        expect(screen.getByText('Refine this agent with AI')).toBeTruthy();
        // Config panel (BuilderConfigPanel): name input + rendered instructions.
        expect(screen.getByDisplayValue('Test Agent')).toBeTruthy();
        expect(screen.getByText('Do the thing.')).toBeTruthy();
        // Action-pill bar (ActionPill via BuilderConfigPanel).
        expect(screen.getByText('agent_wizard.builder.browse_apps')).toBeTruthy();
        expect(screen.getByText('Skills')).toBeTruthy();
    });

    it('routes name edits through the extracted field updaters', () => {
        render(<BuilderSplit {...baseProps} />);
        const input = screen.getByDisplayValue('Test Agent');
        fireEvent.change(input, { target: { value: 'Renamed Agent' } });
        expect(screen.getByDisplayValue('Renamed Agent')).toBeTruthy();
    });

    it('hides the chat rail and shows the banner in read-only mode', () => {
        render(<BuilderSplit {...baseProps} readOnly />);
        expect(screen.queryByText('Refine this agent with AI')).toBeNull();
        expect(screen.getByText("Read-only — you don't have permission to edit this agent.")).toBeTruthy();
    });
});

/**
 * A2 stap 1 — de editor-chrome. Deze drie pinnen de dingen vast die de
 * herindeling stilletjes weer terug kan draaien: de rail hoort RECHTS, de
 * omschrijving hoort ALTIJD zichtbaar, en de tabs moeten echt van inhoud
 * wisselen. De vierde pint de "geen 0"-regel op een teller die de server
 * niet kon beantwoorden.
 */
describe('BuilderSplit — kop, hero en tabs', () => {
    it('zet de verfijn-rail rechts van de inhoud', () => {
        const { container } = render(<BuilderSplit {...baseProps} />);
        const main = container.querySelector('main');
        const row = main.parentElement;
        const kids = Array.from(row.children);
        expect(kids[0]).toBe(main);
        const rail = kids[kids.length - 1];
        expect(rail.tagName).toBe('ASIDE');
        // De greep zit ertussen, niet erbuiten.
        expect(kids.indexOf(screen.getByTestId('refine-rail-handle'))).toBe(1);
        // jsdom rekent geen layout uit, dus de KANT staat als bron in de
        // klassen: een rij die omgedraaid wordt zet de rail links zonder één
        // DOM-knoop te verplaatsen, en een rail rechts heeft zijn rand links.
        expect(row.className).not.toMatch(/flex-row-reverse/);
        expect(rail.className).toContain('border-l');
        expect(rail.className).not.toContain('border-r');
    });

    it('toont kop en hero, met de omschrijving zonder eerst iets uit te klappen', () => {
        render(<BuilderSplit {...baseProps} />);
        expect(screen.getByTestId('studio-section-header')).toBeTruthy();
        expect(within(screen.getByTestId('studio-section-kind')).getByTestId('agent-tile-avatar')).toBeTruthy();
        expect(screen.getByTestId('agent-hero-description').value).toBe('A test agent');
    });

    it('wisselt van tab: de Rol-inhoud verdwijnt op "Used by"', async () => {
        render(<BuilderSplit {...baseProps} />);
        expect(screen.getByText('Do the thing.')).toBeTruthy();
        fireEvent.click(screen.getAllByRole('radio', { name: /Used by/ })[0]);
        await waitFor(() => expect(screen.queryByText('Do the thing.')).toBeNull());
        // De agent-instructies zijn weg; de tab die we openden is er wel.
        expect(screen.queryByText('agent_wizard.builder.browse_apps')).toBeNull();
    });

    it('een gebruikslijst die niet gelezen kon worden toont geen teller en geen "niemand"', async () => {
        // De authFetch-mock antwoordt overal met ok:false, dus GET
        // /agents/:id/usage mislukt.
        render(<BuilderSplit {...baseProps} />);
        const usedBy = screen.getAllByRole('radio', { name: /Used by/ })[0];
        await waitFor(() => expect(usedBy.textContent.trim()).toBe('Used by'));
        expect(usedBy.textContent).not.toContain('0');
        fireEvent.click(usedBy);
        expect(await screen.findByTestId('agent-usage-error')).toBeTruthy();
        expect(screen.queryByText('Nothing uses this agent yet.')).toBeNull();
    });
});

/**
 * A2 stap 2 — de tab "Kan gebruiken" draagt Kennis en Skills.
 *
 * De drie beloftes die een herindeling het makkelijkst weer sloopt: de
 * kaarten staan er, een mislukte lezing zegt dát in plaats van een lege
 * lijst te tonen, en de teller op de tab telt wat er op de tab staat.
 */
describe('BuilderSplit — de tab "Kan gebruiken"', () => {
    const openCanUse = () => fireEvent.click(screen.getAllByRole('radio', { name: /Can use/ })[0]);

    it('toont de Kennis-kaart en de Skills-kaart', async () => {
        render(<BuilderSplit {...baseProps} />);
        openCanUse();
        expect(await screen.findByTestId('agent-knowledge-card')).toBeTruthy();
        expect(screen.getByTestId('agent-skills-card')).toBeTruthy();
        // De Rol-inhoud is weg; we kijken echt naar de andere tab.
        expect(screen.queryByText('Do the thing.')).toBeNull();
    });

    it('zegt bij een mislukte kennisbanklezing dát hij mislukte — nooit "niets gekoppeld"', async () => {
        // De standaardmock laat élke fetch falen, dus GET /api/kb?context=agent
        // ook. De agent HEEFT een koppeling, dus er valt iets te benoemen dat
        // we niet konden benoemen — precies waar de waarschuwing voor is.
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { knowledge_base_ids: ['kb1'] } }} />);
        openCanUse();
        expect(await screen.findByTestId('agent-knowledge-kbs-unreadable')).toBeTruthy();
        expect(screen.queryByTestId('agent-knowledge-empty')).toBeNull();
    });

    it('waarschuwt niet over kennisbanken die deze agent niet heeft', async () => {
        render(<BuilderSplit {...baseProps} />);
        openCanUse();
        // Nul koppelingen: dan is "niets gekoppeld" het antwoord, niet een
        // waarschuwing over een lijst die deze agent toch niet gebruikt.
        expect(await screen.findByTestId('agent-knowledge-empty')).toBeTruthy();
        expect(screen.queryByTestId('agent-knowledge-kbs-unreadable')).toBeNull();
    });

    it('tekent een gelezen kennisbank met zijn documenten en zwijgt dan over fouten', async () => {
        answerWith([
            ['/api/kb?context=agent', [{ id: 'kb1', name: 'Quote terms', document_count: 42, last_content_at: '2026-09-06T10:00:00Z' }]],
        ]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { knowledge_base_ids: ['kb1'] } }} />);
        openCanUse();
        const row = await screen.findByTestId('agent-knowledge-kb-row');
        expect(row.textContent).toContain('Quote terms');
        expect(row.textContent).toContain('42 documents');
        expect(screen.queryByTestId('agent-knowledge-kbs-unreadable')).toBeNull();
    });

    it('houdt een tabel-grant zichtbaar ook als de tabellenroute weigert', async () => {
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { tools: { datatables: { t1: { scope: 'own', columns: '*' } } } } }} />);
        openCanUse();
        const row = await screen.findByTestId('agent-knowledge-table-row');
        expect(row.textContent).toContain("live · only the asker's own rows · reads, does not write");
        expect(screen.getByTestId('agent-knowledge-tables-unreadable')).toBeTruthy();
    });

    it('telt op de tab wat er op de tab staat: kennis, tabellen en skills naast de apps', async () => {
        render(<BuilderSplit {...baseProps} agent={{
            ...agent,
            config: {
                knowledge_base_ids: ['kb1', 'kb2'],
                attachedSkillIds: ['s1'],
                tools: { datatables: { t1: { scope: 'own', columns: '*' } } },
            },
        }} />);
        const tab = screen.getAllByRole('radio', { name: /Can use/ })[0];
        await waitFor(() => expect(tab.textContent).toContain('4'));
    });
});

/**
 * BFSF-392 — the "Upload files" pill counts what the Files dialog calls
 * documents. It used to show the number of LINKED knowledge bases, so one
 * upload base holding two files read "1" on the pill and "Documents (2)" in
 * the dialog.
 */
describe('BuilderSplit — the Upload files pill', () => {
    const uploadPill = () => screen.getByRole('button', { name: /agent_wizard\.builder\.upload_files/ });

    it('shows the document count of the base the dialog uploads into', async () => {
        answerWith([
            ['/api/kb?context=agent', [
                { id: 'kb1', name: 'First', documentCount: 5, documentCountAll: 5 },
                { id: 'kb2', name: 'Uploads', documentCount: 2, documentCountAll: 3 },
            ]],
        ]);
        render(<BuilderSplit {...baseProps} agent={{
            ...agent,
            config: { knowledge_base_ids: ['kb1', 'kb2'], wizard: { primaryKbId: 'kb2' } },
        }} />);
        // Every row of the upload base, as the dialog counts them; not "2"
        // linked bases, and not the 5 of the other base.
        await waitFor(() => expect(within(uploadPill()).queryByText('3')).not.toBeNull());
    });

    it('shows no number for a base the list lacks, then the count the dialog read', async () => {
        answerWith([
            ['/api/kb?context=agent', [{ id: 'kb-other', name: 'Other', documentCount: 5, documentCountAll: 5 }]],
            ['/api/kb/kb-hidden/documents', { documents: [{ id: 'd1', title: 'one.docx' }, { id: 'd2', title: 'two.docx' }], total: 2 }],
        ]);
        const user = userEvent.setup();
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { knowledge_base_ids: ['kb-hidden'] } }} />);
        await waitFor(() => expect(authFetch.mock.calls.some(([url]) => String(url).includes('/api/kb?context=agent'))).toBe(true));
        await act(() => new Promise(resolve => setTimeout(resolve, 0)));

        const pill = uploadPill();
        expect(pill.textContent).not.toMatch(/\d/);

        await user.click(pill);
        await waitFor(() => expect(within(pill).queryByText('2')).not.toBeNull());
    });
});

/**
 * A2 stap 3 — de Tools-kaart hangt aan dezelfde tab.
 *
 * Wat hier gepind wordt is de BEDRADING, niet de kaart zelf (die heeft zijn
 * eigen suite): dat de catalogus uit de ONGEGATE bron komt, dat een mislukte
 * lezing de rijen laat staan, dat een grant op een uitgezette app zichtbaar
 * blijft, en dat een keuze in de kaart in de config landt.
 */
describe('BuilderSplit — de Tools-kaart', () => {
    const openCanUse = () => fireEvent.click(screen.getAllByRole('radio', { name: /Can use/ })[0]);

    const CATALOG = {
        apps: [
            {
                id: 'gmail',
                label: 'Gmail',
                available: true,
                actionsKnown: true,
                provider: 'google',
                actions: [
                    { name: 'gmail_search', label: 'gmail search', effect: 'reads' },
                    { name: 'gmail_compose', label: 'gmail compose', effect: 'sends' },
                ],
            },
            {
                id: 'google-drive',
                label: 'Google Drive',
                available: true,
                actionsKnown: true,
                provider: 'google',
                actions: [{ name: 'drive_search', label: 'drive search', effect: 'reads' }],
            },
        ],
        degraded: false,
        providersKnown: true,
        lendingEnabled: false,
    };

    it('leest de app-catalogus van de ongegate bron en telt de acties', async () => {
        answerWith([['/agents/tool-catalog', CATALOG]]);
        render(<BuilderSplit {...baseProps} agent={{
            ...agent,
            config: { enabledIntegrations: ['gmail'], tools: { gmail: { actions: ['gmail_search'] } } },
        }} />);
        openCanUse();

        expect(await screen.findByTestId('agent-tools-card')).toBeTruthy();
        await waitFor(() => expect(screen.getByTestId('agent-tool-row').textContent).toContain('1 of 2 actions'));
        // De route die WEL achter de automations-module hangt is niet gevraagd.
        const urls = authFetch.mock.calls.map(c => String(c[0]));
        expect(urls.some(u => u.includes('/agents/tool-catalog'))).toBe(true);
        expect(urls.some(u => u.includes('/api/automation/catalog'))).toBe(false);
    });

    it('houdt de rijen staan als de catalogus niet gelezen kon worden', async () => {
        // De standaardmock laat élke fetch falen.
        render(<BuilderSplit {...baseProps} agent={{
            ...agent, config: { enabledIntegrations: ['gmail'] },
        }} />);
        openCanUse();

        expect(await screen.findByTestId('agent-tools-unreadable')).toBeTruthy();
        expect(screen.getByTestId('agent-tool-row').textContent).toContain('Gmail');
        expect(screen.queryByTestId('agent-tools-empty')).toBeNull();
    });

    it('toont een grant op een app die niet meer aanstaat — anders kun je hem niet weghalen', async () => {
        answerWith([['/agents/tool-catalog', CATALOG]]);
        render(<BuilderSplit {...baseProps} agent={{
            ...agent,
            config: { enabledIntegrations: [], tools: { 'google-drive': { actions: [] } } },
        }} />);
        openCanUse();

        await waitFor(() => expect(screen.getAllByTestId('agent-tool-row')).toHaveLength(1));
        expect(screen.getByTestId('agent-tool-row').textContent).toContain('Google Drive');
    });

    it('laat een keuze in de kaart in de config landen', async () => {
        answerWith([['/agents/tool-catalog', CATALOG]]);
        render(<BuilderSplit {...baseProps} agent={{
            ...agent, config: { enabledIntegrations: ['google-drive'] },
        }} />);
        openCanUse();

        const row = await screen.findByTestId('agent-tool-row');
        const ask = within(row).getByRole('radio', { name: 'Confirm first' });
        await waitFor(() => expect(ask.hasAttribute('disabled')).toBe(false));
        fireEvent.click(ask);
        await waitFor(() => expect(
            within(screen.getByTestId('agent-tool-row')).getByRole('radio', { name: 'Confirm first' })
                .getAttribute('aria-checked'),
        ).toBe('true'));
    });

    it('telt gegunde routines mee in de tabteller', async () => {
        render(<BuilderSplit {...baseProps} agent={{
            ...agent,
            config: { tools: { automations: { a1: { confirm: 'ask' } }, datatables: { t1: {} } } },
        }} />);
        const tab = screen.getAllByRole('radio', { name: /Can use/ })[0];
        await waitFor(() => expect(tab.textContent).toContain('2'));
    });
});

/**
 * A2 stap 4 — de tool-KIEZER hangt aan dezelfde kaart.
 *
 * Twee dingen die de bedrading stilletjes kan verliezen: de ↗ moet de kiezer
 * op DIE app openen (en niet, zoals in stap 3, de oude apps-popover op een
 * andere tab), en wat je daar kiest moet in de config landen — in één keer,
 * met allebei de poorten (`enabledIntegrations` én `config.tools`).
 */
describe('BuilderSplit — de tool-kiezer', () => {
    const openCanUse = () => fireEvent.click(screen.getAllByRole('radio', { name: /Can use/ })[0]);

    const CATALOG = {
        apps: [
            {
                id: 'gmail', label: 'Gmail', available: true, actionsKnown: true, provider: 'google',
                actions: [
                    { name: 'gmail_search', label: 'gmail search', effect: 'reads' },
                    { name: 'gmail_compose', label: 'gmail compose', effect: 'sends' },
                ],
            },
            {
                id: 'google-drive', label: 'Google Drive', available: true, actionsKnown: true, provider: 'google',
                actions: [{ name: 'drive_search', label: 'drive search', effect: 'reads' }],
            },
        ],
        degraded: false,
        providersKnown: true,
        lendingEnabled: false,
    };

    it('opent de kiezer op de app van de rij, op dezelfde tab', async () => {
        answerWith([['/agents/tool-catalog', CATALOG]]);
        // Drive staat NIET bovenaan in de kiezer (Gmail sorteert ervoor), dus
        // deze test faalt zodra de ↗ zijn app-id onderweg kwijtraakt.
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { enabledIntegrations: ['google-drive'] } }} />);
        openCanUse();

        await waitFor(() => expect(screen.getByTestId('agent-tool-row')).toBeTruthy());
        fireEvent.click(screen.getByTestId('agent-tool-open'));

        const dialog = await screen.findByRole('dialog', { name: /Choose apps & actions/i });
        expect(within(dialog).getByRole('heading', { name: 'Google Drive' })).toBeTruthy();
        // We staan nog steeds op "Kan gebruiken" — de kaart eronder is er nog.
        expect(screen.getByTestId('agent-tools-card')).toBeTruthy();
    });

    it('laat een keuze uit de kiezer in de kaart landen', async () => {
        answerWith([['/agents/tool-catalog', CATALOG]]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { enabledIntegrations: ['gmail'] } }} />);
        openCanUse();

        await waitFor(() => expect(screen.getByTestId('agent-tool-row').textContent).toContain('2 of 2 actions'));
        fireEvent.click(screen.getByTestId('agent-tool-open'));

        const dialog = await screen.findByRole('dialog', { name: /Choose apps & actions/i });
        fireEvent.click(within(dialog).getByRole('button', { name: /^gmail compose/ }));
        fireEvent.click(within(dialog).getByTestId('agent-tool-chooser-apply'));

        await waitFor(() => expect(screen.getByTestId('agent-tool-row').textContent).toContain('1 of 2 actions'));
        // De kiezer is dicht: één sessie, één keuze, één opslag.
        expect(screen.queryByTestId('agent-tool-chooser-apply')).toBeNull();
    });

    it('zet een app aan vanuit de kiezer — de rij verschijnt op de kaart', async () => {
        answerWith([['/agents/tool-catalog', CATALOG]]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, config: { enabledIntegrations: [] } }} />);
        openCanUse();

        expect(await screen.findByTestId('agent-tools-empty')).toBeTruthy();
        fireEvent.click(screen.getByTestId('agent-tools-link'));

        const dialog = await screen.findByRole('dialog', { name: /Choose apps & actions/i });
        // De "+ Koppelen" opent zonder focus, dus eerst de app aanwijzen.
        fireEvent.click(within(dialog).getByRole('button', { name: /^Google Drive$/ }));
        fireEvent.click(within(dialog).getByRole('button', { name: /^drive search/ }));
        fireEvent.click(within(dialog).getByTestId('agent-tool-chooser-apply'));

        await waitFor(() => expect(screen.getByTestId('agent-tool-row').textContent).toContain('Google Drive'));
        expect(screen.queryByTestId('agent-tools-empty')).toBeNull();

        // En allebei de poorten gaan in DEZELFDE opslag mee: een patch met
        // alleen de acties zou een app opleveren die aanstaat noch uitstaat.
        const puts = authFetch.mock.calls.filter(([url, opts]) => opts?.method === 'PUT' && String(url).includes('/agents/agent-1'));
        const put = puts[puts.length - 1];
        expect(put).toBeTruthy();
        const body = JSON.parse(put[1].body);
        expect(body.config.enabledIntegrations).toEqual(['google-drive']);
        expect(body.config.tools['google-drive'].actions).toBe('*');
    });
});

/**
 * A2 stap 5 — de "Gedaan"-beurt en het ongedaan maken, bedraad.
 *
 * De kaart zelf is gepind in builderSplit/RefineDoneCard.test.jsx; wat hier
 * bewezen wordt is de BEDRADING: dat de klik bij de juiste versie uitkomt,
 * dat een beurt zonder herstelpunt niets aanroept, en dat "Test met een
 * vraag" echt van tab wisselt.
 */
describe('BuilderSplit — de Gedaan-beurt in de verfijn-rail', () => {
    const doneTurn = (extra = {}) => ({
        role: 'done', changes: [{ field: 'systemPrompt' }], undoVersionId: 'v9', ...extra,
    });

    it('herstelt de pre_refine-versie van precies deze beurt', async () => {
        answerWith([
            ['/versions/agent-1/v9/restore', { success: true, restoredTo: 4 }],
            ['/agents/agent-1', { ...agent, name: 'Test Agent', system_prompt: 'Do the thing.', rev: 5 }],
        ]);
        render(<BuilderSplit {...baseProps} history={[doneTurn()]} />);

        fireEvent.click(screen.getByTestId('refine-done-undo'));

        await waitFor(() => expect(
            authFetch.mock.calls.some(([url, opts]) => opts?.method === 'POST' && String(url).includes('/versions/agent-1/v9/restore')),
        ).toBe(true));
        await waitFor(() => expect(screen.getByTestId('refine-done-undo').getAttribute('data-undo-state')).toBe('undone'));
    });

    it('een beurt zonder herstelpunt roept NIETS aan — geen restore van iets anders', () => {
        render(<BuilderSplit {...baseProps} history={[doneTurn({ undoVersionId: null })]} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn.getAttribute('data-undo-state')).toBe('unavailable');
        // De mock telt door over tests heen; alleen wat NA de klik gebeurt telt.
        authFetch.mockClear();
        fireEvent.click(btn);
        expect(authFetch.mock.calls.some(([url]) => String(url).includes('/restore'))).toBe(false);
    });

    it('bij twee beurten kan alleen de nieuwste ongedaan — één niveau diep', () => {
        render(<BuilderSplit {...baseProps} history={[doneTurn({ undoVersionId: 'v8' }), doneTurn()]} />);
        const states = screen.getAllByTestId('refine-done-undo').map(b => b.getAttribute('data-undo-state'));
        expect(states).toEqual(['superseded', 'idle']);
    });

    it('een mislukte restore zegt dat de agent onveranderd bleef', async () => {
        // De standaardmock antwoordt overal ok:false — dus ook op de restore.
        render(<BuilderSplit {...baseProps} history={[doneTurn()]} />);
        fireEvent.click(screen.getByTestId('refine-done-undo'));
        expect(await screen.findByTestId('refine-done-undo-failed')).toBeTruthy();
    });

    it('herstelt ook de LIJSTEN die de kaarten tekenen, niet alleen stateRef', async () => {
        // De verfijning zette gmail aan; het ongedaan maken haalt hem weg.
        // Bleef de React-state staan, dan toont "Kan gebruiken" een app die
        // volgens de opgeslagen staat niet meer aanstaat.
        answerWith([
            ['/versions/agent-1/v9/restore', { success: true, restoredTo: 4 }],
            ['/agents/agent-1', { ...agent, config: { enabledIntegrations: [] }, rev: 5 }],
        ]);
        render(
            <BuilderSplit
                {...baseProps}
                agent={{ ...agent, config: { enabledIntegrations: ['gmail'] } }}
                history={[doneTurn()]}
            />,
        );
        fireEvent.click(screen.getAllByRole('radio', { name: /Can use/ })[0]);
        expect(await screen.findByTestId('agent-tool-row')).toBeTruthy();

        fireEvent.click(screen.getByTestId('refine-done-undo'));
        await waitFor(() => expect(screen.queryByTestId('agent-tool-row')).toBeNull());
        expect(screen.getByTestId('agent-tools-empty')).toBeTruthy();
    });

    it('"Test met een vraag" brengt je naar de Testen-tab', async () => {
        render(<BuilderSplit {...baseProps} history={[doneTurn()]} />);
        fireEvent.click(screen.getByTestId('refine-done-test'));
        expect(screen.getByTestId('agent-tests-card')).toBeTruthy();
        // De standaardmock antwoordt met ok:false, dus dit is een MISLUKTE
        // lezing — en die mag nooit als "nog niet gedraaid" op de kaart komen
        // (A4 deel D). Dat de tab dat hier al waarmaakt, is de reden dat deze
        // assertie meeverhuisde toen de placeholder verdween.
        await waitFor(() => expect(screen.getByTestId('agent-tests-score')).toHaveAttribute('data-state', 'unknown'));
    });
});

/**
 * A2 stap 5 — de persona die na een verfijning ECHT bij de server aankomt.
 *
 * `mergeRefinedPlan` rekende hem al uit; wat ontbrak was de laatste meter.
 * En hij reist EENMALIG: blijft hij op de snapshot staan, dan stuurt elke
 * latere opslag een persona mee die intussen elders veranderd kan zijn.
 */
describe('BuilderSplit — de verfijnde persona bereikt de opslag, precies één keer', () => {
    const REFINED = {
        plan: {
            name: 'Test Agent', description: 'A test agent', systemPrompt: 'Be brief.',
            capabilities: ['answer'], enabledIntegrations: [], knowledge_base_ids: [], skills: [],
        },
        preserved: {},
    };
    const putsTo = (id) => authFetch.mock.calls
        .filter(([url, opts]) => opts?.method === 'PUT' && String(url).includes(`/agents/${id}`))
        .map(([, opts]) => JSON.parse(opts.body));

    // De persona zoals de kolom hem draagt. `unknown` en `language` staan er
    // met opzet in: de verfijning noemt ze nooit, dus ze horen ONGEWIJZIGD mee
    // te reizen in plaats van teruggezet te worden op 'honest'/null.
    const STORED_PERSONA = {
        who: 'De supportcollega', tone: { chips: ['formal'], text: '' },
        does: ['antwoorden'], doesNot: ['korting toezeggen'],
        unknown: { mode: 'handoff', automationId: 'auto-1' },
        language: 'nl', mode: 'fields', freeText: '',
    };

    it('stuurt de persona mee bij de opslag van de verfijning, en niet meer daarna', async () => {
        answerWith([
            ['/agents/wizard/refine', REFINED],
            ['/versions/agent-1/pre-refine', { id: 'v-pre' }],
            ['/agents/agent-1', { ...agent, persona: STORED_PERSONA, rev: 4 }],
        ]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, persona: STORED_PERSONA }} />);

        fireEvent.change(screen.getByPlaceholderText('agent_wizard.builder.chat_placeholder'), {
            target: { value: 'make it brief' },
        });
        authFetch.mockClear();
        fireEvent.click(screen.getByLabelText('Send'));

        await waitFor(() => expect(putsTo('agent-1').length).toBe(1), { timeout: 3000 });
        const refineSave = putsTo('agent-1')[0];
        expect(refineSave.systemPrompt).toBe('Be brief.');
        expect(refineSave.persona.mode).toBe('free');
        expect(refineSave.persona.freeText).toBe('Be brief.');
        // De instellingen die de verfijning niet noemt reizen ONGEWIJZIGD mee.
        expect(refineSave.persona.unknown).toEqual({ mode: 'handoff', automationId: 'auto-1' });
        expect(refineSave.persona.language).toBe('nl');

        // Een gewone bewerking daarna draagt GEEN persona meer — anders
        // overschrijft elke opslag een rol die een ander scherm net zette.
        fireEvent.change(screen.getByDisplayValue('Test Agent'), { target: { value: 'Renamed' } });
        await waitFor(() => expect(putsTo('agent-1').length).toBe(2), { timeout: 3000 });
        expect('persona' in putsTo('agent-1')[1]).toBe(false);
    });

    it('stuurt GEEN persona mee als de kolom niet gelezen kon worden', async () => {
        // De lijstrij draagt geen persona (`_stripPersona`) en `?draft=1` geeft
        // hem hier ook niet mee. Een verse persona wegschrijven zou `unknown`
        // en `language` weggooien — instellingen die dit pad nooit las.
        answerWith([
            ['/agents/wizard/refine', REFINED],
            ['/versions/agent-1/pre-refine', { id: 'v-pre' }],
            ['/agents/agent-1', { ...agent, rev: 4 }],
        ]);
        render(<BuilderSplit {...baseProps} />);

        fireEvent.change(screen.getByPlaceholderText('agent_wizard.builder.chat_placeholder'), {
            target: { value: 'make it brief' },
        });
        authFetch.mockClear();
        fireEvent.click(screen.getByLabelText('Send'));

        await waitFor(() => expect(putsTo('agent-1').length).toBe(1), { timeout: 3000 });
        const refineSave = putsTo('agent-1')[0];
        expect(refineSave.systemPrompt).toBe('Be brief.');
        expect('persona' in refineSave).toBe(false);
    });

    it('stuurt de HUIDIGE rol mee naar /wizard/refine — bijstellen, niet opnieuw verzinnen', async () => {
        answerWith([
            ['/agents/wizard/refine', REFINED],
            ['/versions/agent-1/pre-refine', { id: 'v-pre' }],
            ['/agents/agent-1', { ...agent, persona: STORED_PERSONA, rev: 4 }],
        ]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, persona: STORED_PERSONA }} />);

        fireEvent.change(screen.getByPlaceholderText('agent_wizard.builder.chat_placeholder'), {
            target: { value: 'make it brief' },
        });
        authFetch.mockClear();
        fireEvent.click(screen.getByLabelText('Send'));

        await waitFor(() => {
            const call = authFetch.mock.calls.find(([url]) => String(url).includes('/agents/wizard/refine'));
            expect(call).toBeTruthy();
            const body = JSON.parse(call[1].body);
            expect(body.plan.persona).toEqual({
                who: 'De supportcollega',
                tone: { chips: ['formal'], text: '' },
                does: ['antwoorden'],
                doesNot: ['korting toezeggen'],
            });
        }, { timeout: 3000 });
    });

    it('neemt het prompt over dat de SERVER uit de persona rendeerde', async () => {
        // De persona is de bron van het prompt: de server rendert hem en negeert
        // de tekst die we meestuurden. Zonder die overname houdt de editor zijn
        // eigen tekst vast en schrijft de eerstvolgende opslag (die geen persona
        // draagt) die er weer overheen.
        answerWith([
            ['/agents/wizard/refine', REFINED],
            ['/versions/agent-1/pre-refine', { id: 'v-pre' }],
            // De PUT antwoordt met het GERENDERDE prompt, niet met 'Be brief.'.
            ['/agents/agent-1', { ...agent, persona: STORED_PERSONA, system_prompt: 'De supportcollega.\n\nWhat you do:\n- antwoorden', rev: 4 }],
        ]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, persona: STORED_PERSONA }} />);

        fireEvent.change(screen.getByPlaceholderText('agent_wizard.builder.chat_placeholder'), {
            target: { value: 'make it brief' },
        });
        fireEvent.click(screen.getByLabelText('Send'));

        await waitFor(() => expect(putsTo('agent-1').length).toBe(1), { timeout: 3000 });
        await waitFor(() => {
            expect(screen.getByTestId('markdown').textContent).toMatch(/What you do:/);
        }, { timeout: 3000 });
    });

    it('tekent de categorietag in de identiteitsrij — A3 haalde hem van de Rol-tab weg', async () => {
        answerWith([
            ['/agents/categories', [{ id: 'c-sales', name: 'Sales' }, { id: 'c-hr', name: 'HR' }]],
            ['/agents/agent-1', { ...agent, category_id: 'c-sales', rev: 4 }],
        ]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, category_id: 'c-sales' }} />);

        const select = await screen.findByTestId('agent-category-select', {}, { timeout: 3000 });
        expect(select.value).toBe('c-sales');
        expect(within(screen.getByTestId('agent-hero')).getByTestId('agent-category-select')).toBeTruthy();
    });
});
