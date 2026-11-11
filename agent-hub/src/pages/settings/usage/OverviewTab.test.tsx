/**
 * The Overview tab: four figures with their change since the previous period,
 * a "needs attention" card that exists only when the data gives it a row, and
 * links into the tabs that hold the rest. The adoption reads come from the demo
 * transport, the same one demo/UsageMonitoringDemo.test.tsx uses.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContextType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LicenseContext from '@/components/licensing/LicenseContext';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import OverviewTab from './OverviewTab';
import type { OverviewTabProps } from './OverviewTab.types';

type License = ContextType<typeof LicenseContext>;
type Routes = Record<string, unknown>;

const FEATURE = 'advanced_usage_monitoring';

function useRoutes(routes: Routes = ROUTES as unknown as Routes) {
    setDemoTransport(createDemoTransport(routes as DemoRoutes, createState()));
}

function baseProps(over: Partial<OverviewTabProps> = {}): OverviewTabProps {
    const state = createState();
    return {
        data: { ...state, modelsByAgent: [], modelsByUser: [] } as unknown as OverviewTabProps['data'],
        subscription: null,
        azureServices: { summary: {}, byType: [], byUser: [] },
        isCustomerView: false,
        showTokens: true,
        tierForModel: () => null,
        setFilterUser: () => {},
        setFilterModel: () => {},
        setFilterSource: () => {},
        rangeParams: { days: 30, startDate: null, endDate: null, interval: 'day' },
        compare: true,
        onOpenTab: () => {},
        ...over,
    } as OverviewTabProps;
}

function renderOverview(over: Partial<OverviewTabProps> = {}, features: string[] = [FEATURE]) {
    const value = { hasFeature: (name: string) => features.includes(name), deploymentMode: 'self-hosted' } as unknown as License;
    return renderWithClient(
        <LicenseContext.Provider value={value}>
            <OverviewTab {...baseProps(over)} />
        </LicenseContext.Provider>,
    );
}

beforeEach(() => useRoutes());
afterEach(() => { setDemoTransport(null); });

describe('OverviewTab: the four figures', () => {
    it('shows spend, active members, calls and dormant seats with their secondary facts', async () => {
        const props = baseProps();
        renderOverview();
        expect(await screen.findByText('AI-active members')).toBeTruthy();
        expect(screen.getByText('AI spend')).toBeTruthy();
        expect(screen.getByText('AI calls')).toBeTruthy();
        expect(screen.getByText('Dormant seats')).toBeTruthy();
        expect(screen.getByText(new Intl.NumberFormat().format(props.data.summary?.total_calls ?? 0))).toBeTruthy();
        expect(screen.getByText(/107 of 148 members used AI · 31 makers/)).toBeTruthy();
        expect(screen.getByText(/No sign-in for 30\+ days · 13% of seats/)).toBeTruthy();
        expect(screen.getByText('72%')).toBeTruthy();
    });

    it('shows a change next to the spend and the active members', async () => {
        renderOverview();
        await screen.findByText('AI-active members');
        const spend = screen.getByText('AI spend').parentElement as HTMLElement;
        expect(within(spend).getByTestId('delta-pill').textContent).toMatch(/^[↑↓]/);
        const members = screen.getByText('AI-active members').parentElement as HTMLElement;
        expect(within(members).getByTestId('delta-pill').textContent).toMatch(/pts$/);
    });

    it('drops every change when compare is off', async () => {
        renderOverview({ compare: false });
        await screen.findByText('AI-active members');
        expect(screen.queryAllByTestId('delta-pill')).toHaveLength(0);
    });

    it('drops every change while a cross-cutting filter is active', async () => {
        renderOverview({ hasFilters: true });
        await screen.findByText('AI-active members');
        expect(screen.queryAllByTestId('delta-pill')).toHaveLength(0);
    });

    it('leaves the adoption tiles out without the licence feature', () => {
        renderOverview({}, []);
        expect(screen.getByText('AI spend')).toBeTruthy();
        expect(screen.getByText('AI calls')).toBeTruthy();
        expect(screen.queryByText('AI-active members')).toBeNull();
        expect(screen.queryByText('Dormant seats')).toBeNull();
        expect(screen.queryByText('Where the AI goes')).toBeNull();
    });

    it('has no call tile in the customer view', async () => {
        renderOverview({ isCustomerView: true, showTokens: false });
        await screen.findByText('AI-active members');
        expect(screen.queryByText('AI calls')).toBeNull();
        expect(screen.queryByText('Top models by cost')).toBeNull();
    });
});

describe('OverviewTab: needs attention', () => {
    it('lists dormant seats from the adoption summary', async () => {
        renderOverview();
        const card = await screen.findByRole('region', { name: 'Needs attention' });
        expect(within(card).getByText('19 of 148 seats have not signed in for more than 30 days.')).toBeTruthy();
    });

    it('lists published Studio objects that had no use, and calls without a model name', async () => {
        useRoutes({
            ...(ROUTES as unknown as Routes),
            'GET /api/usage/adoption/studio': () => ({
                kinds: [{ kind: 'app', total: 5, published: 3, makers: 2, newInPeriod: 0, usage: { events: 0, people: 0, label: 'action_runs' }, cost: null, trend: [], deltaPct: null }],
                partial: false,
            }),
        });
        const state = createState();
        const models = [...state.models, { model: '', calls: 63, prompt_tokens: 0, completion_tokens: 0, estimated_cost: 0 }];
        renderOverview({ data: { ...baseProps().data, models } as unknown as OverviewTabProps['data'] });
        const card = await screen.findByRole('region', { name: 'Needs attention' });
        expect(await within(card).findByText('3 published apps had no action runs in this period.')).toBeTruthy();
        expect(within(card).getByText('63 calls carry no model name and are priced at €0.00.')).toBeTruthy();
    });

    it('renders no card at all when nothing needs attention', async () => {
        useRoutes({
            ...(ROUTES as unknown as Routes),
            'GET /api/usage/adoption/summary': () => ({
                range: { startDate: '2026-10-07', endDate: '2026-11-06', days: 30, relative: true },
                members: { total: 10, aiActive: 8, seenOnly: 2, dormant: 0, never: 0, newInPeriod: 0, seats: { used: 10, max: null } },
                makers: { total: 1, newInPeriod: 0 },
                spend: { cost: 10, calls: 10, people: 8, perActiveMember: 1 },
                adoptionRate: 80,
                prev: null,
                partial: false,
            }),
            'GET /api/usage/adoption/studio': () => ({ kinds: [], partial: false }),
        });
        renderOverview();
        await screen.findByText('AI-active members');
        expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
    });
});

describe('OverviewTab: links into the other tabs', () => {
    it('opens Spend, Adoption and the right sub-tabs', async () => {
        const user = userEvent.setup();
        const onOpenTab = vi.fn();
        renderOverview({ onOpenTab });
        await screen.findByText('All areas in Adoption');

        await user.click(screen.getByRole('button', { name: /Open Adoption/ }));
        expect(onOpenTab).toHaveBeenLastCalledWith('adoption');
        await user.click(screen.getAllByRole('button', { name: /^See who/ })[0]);
        expect(onOpenTab).toHaveBeenLastCalledWith('adoption', 'people');
        await user.click(screen.getByRole('button', { name: /All areas in Adoption/ }));
        expect(onOpenTab).toHaveBeenLastCalledWith('adoption', 'areas');
        await user.click(screen.getByRole('button', { name: /^All \d+ models in Spend/ }));
        expect(onOpenTab).toHaveBeenLastCalledWith('spend', 'models');
        await user.click(screen.getByRole('button', { name: /Table view/ }));
        expect(onOpenTab).toHaveBeenLastCalledWith('spend');
    });
});
