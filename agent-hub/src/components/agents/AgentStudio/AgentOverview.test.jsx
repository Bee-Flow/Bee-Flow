/**
 * Het agentoverzicht: kop, chips, zoekveld, raster (A5 deel C).
 *
 * De regressies die dit vasthoudt komen uit DatatablesStudio, waar ze al een
 * keer geld hebben gekost:
 *   - de vier takken (laden → fout → leeg → rijen) horen in ÉÉN
 *     `aria-live`-blok, anders leest een schermlezer een lijst voor die
 *     inmiddels een foutmelding is;
 *   - een mislukte lezing mag NOOIT als "nog geen agents" op het scherm komen;
 *   - het zoekveld staat er op elke lijstlengte (een control die pas boven
 *     vier rijen verschijnt is een control die verhuist).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/AgentOverview.test.jsx
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../hooks/useTranslation', () => import('../../../test/useTranslationMock'));

const bootstrap = { categories: [{ id: 'c1', name: 'Sales' }], orgGroups: [] };
vi.mock('../AgentWizard/AgentEditorBootstrapContext', () => ({
    AgentEditorBootstrapProvider: ({ children }) => <>{children}</>,
    useAgentEditorBootstrap: () => bootstrap,
}));

import AgentOverview from './AgentOverview';

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const AGENTS = [
    { id: 'a1', name: 'Helpdesk', description: 'answers tickets', category_id: 'c1', can_edit: true, config: {} },
    { id: 'a2', name: 'Planner', description: '', can_edit: true, config: {} },
];

function draw(props = {}) {
    return render(<AgentOverview t={t} agents={AGENTS} onOpen={() => {}} {...props} />);
}

const liveRegion = (container) => container.querySelector('[aria-live="polite"]');

afterEach(cleanup);

describe('de vier takken staan in één aria-live-blok', () => {
    it('laden: een sr-only label in het blok, geen kaarten', () => {
        const { container } = draw({ agents: [], loading: true });
        const region = liveRegion(container);
        expect(region).toBeTruthy();
        expect(within(region).getByText('Loading agents')).toBeTruthy();
        expect(screen.queryByTestId('agent-card')).toBeNull();
    });

    it('fout: de melding staat in het blok en de "nog geen agents"-zin NIET', () => {
        const { container } = draw({ agents: [], error: 'HTTP 500' });
        const region = liveRegion(container);
        expect(within(region).getByTestId('agent-overview-error').textContent).toContain('HTTP 500');
        // "geladen maar leeg" en "de lezing faalde" mogen elkaar niet tegenspreken.
        expect(screen.queryByText('No agents yet')).toBeNull();
    });

    it('ÉÉN live region: geen role="alert" of role="status" erbinnen', () => {
        // Twee live regions genest laten een schermlezer de fout twee keer
        // aankondigen (assertief én polite), en bij elke aanslag in het zoekveld
        // wordt de hele gewijzigde inhoud opnieuw voorgelezen. Het precedent
        // (Studio/Datatables/DatatablesStudio.jsx) houdt de kinderen rolloos.
        const { container } = draw({ agents: [], error: 'HTTP 500' });
        expect(liveRegion(container).querySelector('[role="alert"]')).toBeNull();
        cleanup();
        const loading = draw({ agents: [], loading: true });
        expect(liveRegion(loading.container).querySelector('[role="status"]')).toBeNull();
    });

    it('een chip die uit de lijst verdwijnt filtert niet stilzwijgend door', () => {
        // Anders staat er een leeg raster met geen enkele zichtbare reden: de
        // laatste agent van die categorie is eruit gehaald, of de categorielijst
        // kwam pas later binnen.
        const { rerender } = draw({ agents: AGENTS });
        const chip = screen.getByText('Sales').closest('button');
        fireEvent.click(chip);
        expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
        // Dezelfde rijen, maar zonder die categorie: de chip bestaat niet meer.
        rerender(<AgentOverview t={t} agents={AGENTS.map(a => ({ ...a, category_id: null }))} onOpen={() => {}} />);
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
        expect(screen.queryByTestId('agent-overview-no-match')).toBeNull();
    });

    it('fout: Opnieuw proberen roept de lezing opnieuw aan', () => {
        const onRetry = vi.fn();
        draw({ agents: [], error: 'HTTP 500', onRetry });
        fireEvent.click(screen.getByText('Retry'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('leeg: de EmptyState met de ene actie', () => {
        const onCreate = vi.fn();
        const { container } = draw({ agents: [], onCreate });
        expect(within(liveRegion(container)).getByText('No agents yet')).toBeTruthy();
        // Twee knoppen met dezelfde tekst (kop + EmptyState); de laatste is die van de kaartloze staat.
        const buttons = screen.getAllByText('New agent');
        fireEvent.click(buttons[buttons.length - 1]);
        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('rijen: een kaart per agent, in een raster van drie kolommen', () => {
        const { container } = draw();
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
        // jsdom legt niets uit; de kolommen worden als BRON gepind (dezelfde
        // reden als StudioSectionHeader.responsiveFold.test.jsx).
        const grid = within(liveRegion(container)).getByRole('list');
        expect(grid.className).toContain('lg:grid-cols-3');
    });
});

describe('teller, zoekveld en chips', () => {
    it('de kop draagt het aantal', () => {
        draw();
        expect(screen.getByTestId('agent-overview-count').textContent).toBe('2');
    });

    it('zoeken versmalt de lijst en zegt het als er niets overblijft', () => {
        draw();
        const box = screen.getByLabelText('Search agents by name, purpose or category');
        fireEvent.change(box, { target: { value: 'help' } });
        expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
        fireEvent.change(box, { target: { value: 'zzz' } });
        expect(screen.queryByTestId('agent-card')).toBeNull();
        expect(screen.getByTestId('agent-overview-no-match')).toBeTruthy();
        // Niet de lege staat: er ZIJN agents, ze vallen alleen buiten het filter.
        expect(screen.queryByText('No agents yet')).toBeNull();
    });

    it('een chip per gebruikte categorie, plus "No category"', () => {
        draw();
        const chips = screen.getByRole('group', { name: 'Filter by category' });
        expect(within(chips).getByText('All')).toBeTruthy();
        expect(within(chips).getByText('Sales')).toBeTruthy();
        expect(within(chips).getByText('No category')).toBeTruthy();
    });

    it('een chip filtert, en een tweede klik zet hem weer uit', () => {
        draw();
        const sales = screen.getByText('Sales').closest('button');
        fireEvent.click(sales);
        expect(sales.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
        fireEvent.click(sales);
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
    });

    it('zonder recht om te maken is er geen knop, maar wel een lijst', () => {
        draw({ onCreate: null });
        expect(screen.queryByText('New agent')).toBeNull();
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
    });
});
