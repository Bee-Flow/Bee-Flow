import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import type { RangeParams } from '@/utils/usageHelpers';
import QualityTab from './QualityTab';

const RANGE: RangeParams = { days: 30, startDate: null, endDate: null, interval: 'day' };

beforeEach(() => { setDemoTransport(createDemoTransport(ROUTES as unknown as DemoRoutes, createState())); });
afterEach(() => { setDemoTransport(null); });

const renderTab = (props: Partial<React.ComponentProps<typeof QualityTab>> = {}) =>
    renderWithClient(<QualityTab rangeParams={RANGE} showTokens compare {...props} />);

describe('QualityTab hero', () => {
    it('shows approval and terminations from the fixtures', async () => {
        renderTab();
        const approval = await screen.findByRole('article', { name: /Approval/ });
        expect(await within(approval).findByText('79%')).toBeTruthy();
        expect(within(approval).getByText('14 ratings · 11 up, 3 down · 4 with a comment')).toBeTruthy();
        expect(within(approval).queryByTestId('delta-pill')).toBeNull();
        const term = screen.getByRole('article', { name: /Terminations/ });
        expect(await within(term).findByText('6')).toBeTruthy();
        expect(await within(term).findByText('2 likely caused by a large input')).toBeTruthy();
        expect(within(term).getByRole('img').getAttribute('aria-label')).toBe('Max tokens 3, Max iterations 1, Error 2, Aborted 0');
    });

    it('adds the coverage and share sentences only when totalCalls is known', async () => {
        const { unmount } = renderTab();
        await screen.findByText('79%');
        expect(screen.queryByText(/Ratings cover/)).toBeNull();
        unmount();
        renderTab({ totalCalls: 287 });
        expect(await screen.findByText('Ratings cover 4.9% of the 287 calls.')).toBeTruthy();
        expect(await screen.findByText('2.1% of calls · 2 likely caused by a large input')).toBeTruthy();
    });
});

describe('QualityTab views', () => {
    it('starts on the sub-tab it is given and switches', async () => {
        const user = userEvent.setup();
        renderTab({ initialSubTab: 'terminations' });
        expect(screen.getByRole('button', { name: 'Terminations' }).getAttribute('aria-pressed')).toBe('true');
        expect(await screen.findByRole('heading', { name: 'Terminations by agent' })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Feedback' }));
        expect(await screen.findByText(/Exactly the table I needed/)).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Terminations by agent' })).toBeNull();
    });

    it('filters the feedback list with a chip and opens a shared conversation', async () => {
        const user = userEvent.setup();
        renderTab();
        expect(await screen.findByRole('button', { name: /All.*14/ })).toBeTruthy();
        expect(screen.getAllByText('not shared').length).toBeGreaterThan(0);
        await user.click(screen.getByRole('button', { name: /Negative.*3/ }));
        expect(screen.queryByText(/Exactly the table I needed/)).toBeNull();
        expect(screen.getByText(/skipped the action items/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /Open conversation/ }));
        expect(await screen.findByText('Summarise the meeting and list the action items.')).toBeTruthy();
    });

    it('searches comments', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByText(/Exactly the table I needed/);
        await user.type(screen.getByRole('searchbox', { name: 'Search feedback' }), 'dutch');
        expect(screen.getByText(/Answered in English/)).toBeTruthy();
        expect(screen.queryByText(/Exactly the table I needed/)).toBeNull();
    });
});
