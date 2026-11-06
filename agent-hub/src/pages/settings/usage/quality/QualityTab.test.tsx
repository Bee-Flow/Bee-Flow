import { screen, waitFor, within } from '@testing-library/react';
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

const useRoutes = (overrides: Record<string, unknown> = {}) =>
    setDemoTransport(createDemoTransport({ ...ROUTES, ...overrides } as unknown as DemoRoutes, createState()));

const renderTab = (props: Partial<React.ComponentProps<typeof QualityTab>> = {}) =>
    renderWithClient(<QualityTab rangeParams={RANGE} showTokens {...props} />);

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

describe('QualityTab refresh', () => {
    it('refetches the feedback and terminations reports', async () => {
        const user = userEvent.setup();
        const inner = createDemoTransport(ROUTES as unknown as DemoRoutes, createState());
        const urls: string[] = [];
        setDemoTransport(((url: unknown, options?: RequestInit) => { urls.push(String(url)); return inner(url, options); }) as typeof inner);
        renderTab();
        await screen.findByText('79%');
        await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
        const before = urls.length;
        await user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(urls.length).toBeGreaterThan(before));
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

describe('QualityTab people', () => {
    it('shows pseudonyms by default, in both lists', async () => {
        const user = userEvent.setup();
        renderTab();
        expect((await screen.findAllByText('Member · K7Q2')).length).toBeGreaterThan(0);
        expect(screen.getAllByText('Anonymous').length).toBeGreaterThan(0);
        expect(screen.getByText('Names are hidden')).toBeTruthy();
        expect(screen.queryByText('Noor Bakker')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Terminations' }));
        await user.click((await screen.findAllByRole('button', { name: /Details for/ }))[0]);
        expect(screen.getAllByText('Member · K7Q2').length).toBeGreaterThan(0);
    });

    it('asks for names with reveal=true and shows the audit banner and a display name', async () => {
        const user = userEvent.setup();
        const inner = createDemoTransport(ROUTES as unknown as DemoRoutes, createState());
        const urls: string[] = [];
        setDemoTransport(((url: unknown, options?: RequestInit) => { urls.push(String(url)); return inner(url, options); }) as typeof inner);
        renderTab();
        await screen.findAllByText('Member · K7Q2');
        expect(urls.some(u => u.includes('reveal=true'))).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        expect((await screen.findAllByText('Noor Bakker')).length).toBeGreaterThan(0);
        expect(screen.getByText('Names shown · recorded in the access audit log')).toBeTruthy();
        expect(screen.queryByText('Member · K7Q2')).toBeNull();
        expect(urls.filter(u => u.includes('/api/feedback/org?') && u.includes('reveal=true')).length).toBe(1);
        expect(urls.filter(u => u.includes('/api/terminations/org') && u.includes('reveal=true')).length).toBe(0);
        await user.click(screen.getByRole('button', { name: 'Hide names' }));
        expect((await screen.findAllByText('Member · K7Q2')).length).toBeGreaterThan(0);
        expect(screen.queryByText('Noor Bakker')).toBeNull();
    });

    it('shows the refused banner and no names when the audit log could not record the reveal', async () => {
        useRoutes({
            'GET /api/feedback/org': (ctx: { query?: URLSearchParams }) => (ctx.query?.get('reveal') === 'true'
                ? new Response(JSON.stringify({ code: 'audit_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
                : (ROUTES as unknown as Record<string, (c: unknown) => unknown>)['GET /api/feedback/org'](ctx)),
        });
        const user = userEvent.setup();
        renderTab();
        await screen.findAllByText('Member · K7Q2');
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        expect(await screen.findByText('Names not revealed')).toBeTruthy();
        expect(screen.queryByText('Noor Bakker')).toBeNull();
        expect(screen.queryAllByText(/^Member · /).length).toBe(0);
        await user.click(screen.getByRole('button', { name: /Back to pseudonyms/ }));
        expect((await screen.findAllByText('Member · K7Q2')).length).toBeGreaterThan(0);
    });
});
