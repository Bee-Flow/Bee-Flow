/**
 * The agent overview: heading, chips, search field, grid (A5 part C).
 *
 * The regressions this holds on to come from DatatablesStudio, where they have already cost money:
 *   - the four branches (loading → error → empty → rows) belong in ONE `aria-live` block, otherwise a screen reader reads out a list that has meanwhile become an error message;
 *   - a failed read may NEVER appear on the screen as "no agents yet";
 *   - the search field is there at every list length (a control that only appears above four rows is a control that moves).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/AgentOverview.test.jsx
 */
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
        // "loaded but empty" and "the read failed" must not contradict each other.
        expect(screen.queryByText('No agents yet')).toBeNull();
    });

    it('ÉÉN live region: geen role="alert" of role="status" erbinnen', () => {
        // Two nested live regions would let a screen reader announce the error twice (assertive AND polite), and with every keystroke in the search field the whole changed content is read out again. The precedent (Studio/Datatables/DatatablesStudio.jsx) keeps the children roleless.
        const { container } = draw({ agents: [], error: 'HTTP 500' });
        expect(liveRegion(container).querySelector('[role="alert"]')).toBeNull();
        cleanup();
        const loading = draw({ agents: [], loading: true });
        expect(liveRegion(loading.container).querySelector('[role="status"]')).toBeNull();
    });

    it('een chip die uit de lijst verdwijnt filtert niet stilzwijgend door', async () => {
        const user = userEvent.setup();
        // Otherwise there is an empty grid with no visible reason: the last agent of that category has been removed, or the category list arrived later.
        const { rerender } = draw({ agents: AGENTS });
        const chip = screen.getByText('Sales').closest('button');
        await user.click(chip);
        expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
        // The same rows, but without that category: the chip no longer exists.
        rerender(<AgentOverview t={t} agents={AGENTS.map(a => ({ ...a, category_id: null }))} onOpen={() => {}} />);
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
        expect(screen.queryByTestId('agent-overview-no-match')).toBeNull();
    });

    it('fout: Opnieuw proberen roept de lezing opnieuw aan', async () => {
        const user = userEvent.setup();
        const onRetry = vi.fn();
        draw({ agents: [], error: 'HTTP 500', onRetry });
        await user.click(screen.getByText('Retry'));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('leeg: de EmptyState met de ene actie', async () => {
        const user = userEvent.setup();
        const onCreate = vi.fn();
        const { container } = draw({ agents: [], onCreate });
        expect(within(liveRegion(container)).getByText('No agents yet')).toBeTruthy();
        // Twee knoppen met dezelfde tekst (kop + EmptyState); de laatste is die van de kaartloze staat.
        const buttons = screen.getAllByText('New agent');
        await user.click(buttons[buttons.length - 1]);
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
        // Not the empty state: there ARE agents, they just fall outside the filter.
        expect(screen.queryByText('No agents yet')).toBeNull();
    });

    it('een chip per gebruikte categorie, plus "No category"', () => {
        draw();
        const chips = screen.getByRole('group', { name: 'Filter by category' });
        expect(within(chips).getByText('All')).toBeTruthy();
        expect(within(chips).getByText('Sales')).toBeTruthy();
        expect(within(chips).getByText('No category')).toBeTruthy();
    });

    it('een chip filtert, en een tweede klik zet hem weer uit', async () => {
        const user = userEvent.setup();
        draw();
        const sales = screen.getByText('Sales').closest('button');
        await user.click(sales);
        expect(sales.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
        await user.click(sales);
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
    });

    it('zonder recht om te maken is er geen knop, maar wel een lijst', () => {
        draw({ onCreate: null });
        expect(screen.queryByText('New agent')).toBeNull();
        expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
    });
});
