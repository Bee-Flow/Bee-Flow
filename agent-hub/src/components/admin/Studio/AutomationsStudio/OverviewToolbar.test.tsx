import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OverviewToolbar from './OverviewToolbar';
import type { OverviewToolbarProps } from './OverviewToolbar';

/**
 * The overview's toolbar folds its state and trigger pills into one "Filter"
 * button below 84rem of its own width (a laptop), so the row stays calm. The
 * fold is CSS (a container query), so jsdom renders both forms; these tests
 * pin the folded one: what the button says and what its panel does.
 */
const STATE = [
    { value: 'all', label: 'All', count: 4 },
    { value: 'live', label: 'Live', count: 2, tone: 'success' },
    { value: 'paused', label: 'Paused', count: 1, tone: 'muted' },
];
const TRIGGER = [
    { value: 'all', label: 'Any trigger', count: 4 },
    { value: 'schedule', label: 'Schedule', count: 3 },
    { value: 'manual', label: 'Manual', count: 1 },
];

function setup(over: Partial<OverviewToolbarProps> = {}) {
    const props: OverviewToolbarProps = {
        hasRows: true,
        state: 'all',
        onState: vi.fn(),
        stateOptions: STATE,
        trigger: 'all',
        onTrigger: vi.fn(),
        triggerOptions: TRIGGER,
        narrowed: false,
        onClear: vi.fn(),
        view: 'list',
        onView: vi.fn(),
        sort: 'updated',
        onSort: vi.fn(),
        groupBy: 'status',
        onGroup: vi.fn(),
        onCreate: vi.fn(),
        ...over,
    };
    render(<OverviewToolbar {...props} />);
    return props;
}

const filterButton = () => screen.getByTestId('automations-overview-filter');

describe('OverviewToolbar', () => {
    afterEach(cleanup);

    it('the folded filter opens a panel with the state and trigger pills', async () => {
        const user = userEvent.setup();
        const props = setup();
        expect(filterButton().textContent).toBe('Filter');
        expect(filterButton().getAttribute('aria-expanded')).toBe('false');
        await user.click(filterButton());
        const panel = screen.getByRole('dialog', { name: 'Filter' });
        expect(within(panel).getByText('State')).toBeTruthy();
        expect(within(panel).getByText('Trigger')).toBeTruthy();
        await user.click(within(panel).getByRole('button', { name: /Live/ }));
        expect(props.onState).toHaveBeenCalledWith('live');
        await user.click(within(panel).getByRole('button', { name: /Schedule/ }));
        expect(props.onTrigger).toHaveBeenCalledWith('schedule');
    });

    it('names what is narrowed, and Clear filters resets and closes the panel', async () => {
        const user = userEvent.setup();
        const props = setup({ state: 'live', trigger: 'schedule', narrowed: true });
        expect(filterButton().textContent).toBe('Filter: Live · Schedule');
        await user.click(filterButton());
        await user.click(within(screen.getByRole('dialog', { name: 'Filter' })).getByRole('button', { name: 'Clear filters' }));
        expect(props.onClear).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull();
    });

    it('leaves the trigger row out when only one trigger kind is in use', async () => {
        const user = userEvent.setup();
        setup({ triggerOptions: TRIGGER.slice(0, 2) });
        await user.click(filterButton());
        const panel = screen.getByRole('dialog', { name: 'Filter' });
        expect(within(panel).queryByText('Trigger')).toBeNull();
        expect(within(panel).getByText('State')).toBeTruthy();
    });

    it('an empty library gets a title instead of filters', () => {
        setup({ hasRows: false });
        expect(screen.queryByTestId('automations-overview-filter')).toBeNull();
        expect(screen.getByText('All automations')).toBeTruthy();
    });
});
