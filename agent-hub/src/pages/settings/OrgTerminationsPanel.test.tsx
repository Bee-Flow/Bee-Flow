import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import type { RangeParams } from '@/utils/usageHelpers';
import OrgTerminationsPanel from './OrgTerminationsPanel';

const RANGE: RangeParams = { days: 30, startDate: null, endDate: null, interval: 'day' };

function mount(overrides: Record<string, () => unknown> = {}, showTokens = true) {
    setDemoTransport(createDemoTransport({ ...ROUTES, ...overrides } as unknown as DemoRoutes, createState()));
    return renderWithClient(<OrgTerminationsPanel rangeParams={RANGE} showTokens={showTokens} />);
}

afterEach(() => { setDemoTransport(null); });

describe('OrgTerminationsPanel', () => {
    it('lists the agents with the large-input count as an amber pill', async () => {
        mount();
        const table = within(await screen.findByRole('region', { name: 'By agent' })).getByRole('table');
        const studio = within(table).getByRole('row', { name: /App Studio assistant/ });
        expect(within(studio).getAllByRole('cell').map(c => c.textContent)).toEqual(['App Studio assistant', '3', '2', '1', '0', '0', '2']);
        const chat = within(table).getByRole('row', { name: /Direct chat/ });
        expect(within(chat).getAllByRole('cell').at(-1)?.textContent).toBe('0');
    });

    it('draws the timeline and keeps the privacy note', async () => {
        mount();
        expect(await screen.findByRole('region', { name: 'Terminations over time' })).toBeTruthy();
        expect(screen.getByText(/messages are not logged/i)).toBeTruthy();
    });

    it('filters the events by type and counts them', async () => {
        const user = userEvent.setup();
        mount();
        expect(await screen.findByText('6 events')).toBeTruthy();
        await user.selectOptions(screen.getByRole('combobox', { name: 'All types' }), 'error');
        expect(screen.getByText('2 events')).toBeTruthy();
    });

    it('opens one event in place with its error details', async () => {
        const user = userEvent.setup();
        mount();
        await screen.findByText('6 events');
        const [first] = screen.getAllByRole('button', { name: /Details for Weekly report/ });
        expect(first.getAttribute('aria-expanded')).toBe('false');
        await user.click(first);
        expect(first.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('upstream timed out')).toBeTruthy();
        await user.click(first);
        expect(screen.queryByText('upstream timed out')).toBeNull();
    });

    it('hides the token column in the customer view', async () => {
        mount({}, false);
        await screen.findByText('6 events');
        expect(screen.queryByRole('columnheader', { name: 'Tokens' })).toBeNull();
    });

    it('offers a banner that narrows the events to errors once errors are frequent', async () => {
        const user = userEvent.setup();
        mount({ 'GET /api/terminations/org/summary': () => ({ total: 20, by_type: { max_tokens: 8, max_iterations: 2, error: 8, aborted: 2 } }) });
        await user.click(await screen.findByRole('button', { name: 'Review errors' }));
        expect((screen.getByRole('combobox', { name: 'All types' }) as HTMLSelectElement).value).toBe('error');
        expect(screen.getByText('2 events')).toBeTruthy();
    });
});
