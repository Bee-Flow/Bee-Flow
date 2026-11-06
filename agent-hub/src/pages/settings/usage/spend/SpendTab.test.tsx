/**
 * The Spend tab: a hero with the period's cost, then one table per sub-tab.
 * The models row opens in place, a row can narrow the page, and the cloud
 * customer view keeps its own page.
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
import type { OverviewTabProps } from '../OverviewTab.types';
import SpendTab from './SpendTab';

type License = ContextType<typeof LicenseContext>;
type Handler = (ctx: { state: ReturnType<typeof createState> }) => unknown;

const FEATURE = 'advanced_usage_monitoring';

function baseProps(over: Partial<OverviewTabProps> = {}): OverviewTabProps {
    const state = createState();
    const routes = ROUTES as unknown as Record<string, Handler>;
    return {
        data: {
            ...state,
            modelsByAgent: routes['GET /api/usage/models-by-agent']({ state }),
            modelsByUser: routes['GET /api/usage/models-by-user']({ state }),
        } as unknown as OverviewTabProps['data'],
        subscription: null,
        azureServices: { summary: {}, byType: [], byUser: [] },
        isCustomerView: false,
        showTokens: true,
        tierForModel: (model: string | null) => (model === 'claude-sonnet-5' ? 'fast' : null),
        setFilterUser: () => {},
        setFilterModel: () => {},
        setFilterSource: () => {},
        rangeParams: { days: 30, startDate: null, endDate: null, interval: 'day' },
        compare: true,
        ...over,
    } as OverviewTabProps;
}

function renderSpend(over: Partial<OverviewTabProps> = {}, features: string[] = [FEATURE]) {
    const value = { hasFeature: (name: string) => features.includes(name), deploymentMode: 'self-hosted' } as unknown as License;
    return renderWithClient(
        <LicenseContext.Provider value={value}>
            <SpendTab {...baseProps(over)} />
        </LicenseContext.Provider>,
    );
}

beforeEach(() => { setDemoTransport(createDemoTransport(ROUTES as unknown as DemoRoutes, createState())); });
afterEach(() => { setDemoTransport(null); });

describe('SpendTab: hero', () => {
    it('shows the cost, its change and a budget that is not set', async () => {
        renderSpend();
        const hero = screen.getByRole('region', { name: 'Spend summary' });
        expect(within(hero).getByText(/Estimated AI cost/)).toBeTruthy();
        expect(within(hero).getByText('none set')).toBeTruthy();
        expect(within(hero).getByRole('link', { name: /Set a budget per member or group/ }).getAttribute('href')).toBe('/app/settings/organisation/users');
        expect(await within(hero).findByTestId('delta-pill')).toBeTruthy();
    });

    it('shows the monthly budget used against the cap from the subscription', () => {
        renderSpend({ subscription: { effective_limits: { max_cost_per_month: 100 }, current_usage: { cost: 25 } } }, []);
        expect(screen.getByText('€25.00 of €100.00')).toBeTruthy();
        expect(screen.queryByText('none set')).toBeNull();
    });

    it('has no change without the adoption feature or with compare off', async () => {
        renderSpend({}, []);
        expect(screen.queryByTestId('delta-pill')).toBeNull();
    });
});

describe('SpendTab: sub-tabs', () => {
    it('switches between the five tables', async () => {
        const user = userEvent.setup();
        renderSpend();
        expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('table')).toBeTruthy();
        expect(screen.getByRole('columnheader', { name: 'Tier' })).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'People' }));
        expect(screen.getByRole('columnheader', { name: 'Member' })).toBeTruthy();
        expect(screen.getByText('Casey Hayes')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Agents' }));
        expect(screen.getByText('Support drafter')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Sources' }));
        expect(screen.getByRole('columnheader', { name: 'Source' })).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Other services' }));
        expect(screen.getByText(/Nothing was used in this period/)).toBeTruthy();
    });

    it('opens the sub-tab it is asked to', () => {
        renderSpend({ initialSubTab: 'agents' } as Partial<OverviewTabProps>);
        expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-pressed')).toBe('true');
    });
});

describe('SpendTab: models', () => {
    it('lists the models with a tier badge and a total row', () => {
        renderSpend();
        expect(screen.getByRole('button', { name: /claude-sonnet-5/ })).toBeTruthy();
        expect(within(screen.getByRole('table')).getByText('Fast')).toBeTruthy();
        expect(screen.getByText('Total · 4 models')).toBeTruthy();
    });

    it('opens a row in place with who used it and through what, and can narrow the page', async () => {
        const user = userEvent.setup();
        const setFilterModel = vi.fn();
        renderSpend({ setFilterModel });
        const row = screen.getByRole('button', { name: /claude-sonnet-5/ });
        expect(row.getAttribute('aria-expanded')).toBe('false');
        await user.click(row);
        expect(row.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('heading', { name: 'Who used it' })).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Through what' })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Filter by this model' }));
        expect(setFilterModel).toHaveBeenCalledWith('claude-sonnet-5');
        await user.click(row);
        expect(row.getAttribute('aria-expanded')).toBe('false');
    });

    it('marks a model without a name as unpriced', () => {
        const base = baseProps();
        const models = [...base.data.models, { model: '', calls: 63, prompt_tokens: 0, completion_tokens: 0, estimated_cost: 0, input_cost: 0, output_cost: 0 }];
        renderSpend({ data: { ...base.data, models } });
        expect(screen.getByText('unpriced')).toBeTruthy();
        expect(screen.getByRole('button', { name: /unknown/ })).toBeTruthy();
    });
});

describe('SpendTab: rows that narrow the page', () => {
    it('sets the member filter from the People table', async () => {
        const user = userEvent.setup();
        const setFilterUser = vi.fn();
        renderSpend({ setFilterUser });
        await user.click(screen.getByRole('button', { name: 'People' }));
        await user.click(screen.getByRole('button', { name: /Casey Hayes/ }));
        await user.click(screen.getByRole('button', { name: 'Filter by this member' }));
        expect(setFilterUser).toHaveBeenCalledWith('u_casey');
    });

    it('sets the source filter from the Sources table', async () => {
        const user = userEvent.setup();
        const setFilterSource = vi.fn();
        renderSpend({ setFilterSource });
        await user.click(screen.getByRole('button', { name: 'Sources' }));
        const buttons = screen.getAllByRole('button', { name: /Direct chat|Chat/ });
        await user.click(buttons[buttons.length - 1]);
        expect(setFilterSource).toHaveBeenCalledWith('direct_chat');
    });
});

describe('SpendTab: agents and customer view', () => {
    it('sums string token counts per agent as numbers, not as concatenated text', async () => {
        const user = userEvent.setup();
        const base = baseProps();
        renderSpend({
            data: {
                ...base.data,
                modelsByAgent: [
                    { model: 'claude-sonnet-5', agent_name: 'Direct Chat', agent_id: null, total_tokens: '98282', estimated_cost: 0.25 },
                    { model: 'gpt-5', agent_name: 'Direct Chat', agent_id: null, total_tokens: '7000', estimated_cost: 0.1 },
                ],
            },
        });
        await user.click(screen.getByRole('button', { name: 'Agents' }));
        expect(screen.getByText('105.3K')).toBeTruthy();
        expect(screen.queryByText(/98282\.7M/)).toBeNull();
        expect(screen.getByText('€0.35')).toBeTruthy();
    });

    it('shows usage against the cap and tiers instead of models for a customer', () => {
        const base = baseProps();
        renderSpend({
            isCustomerView: true,
            showTokens: false,
            data: { ...base.data, summary: { billed_cost: 10, unique_users: 3 } },
            subscription: { status: 'active', plan_name: 'Team', effective_limits: { max_cost_per_month: 100 }, current_usage: { cost: 40 }, billing: { plan_currency: 'EUR', subscription_total: 99 } },
        });
        expect(screen.getAllByText('40%').length).toBeGreaterThan(0);
        expect(screen.getByText('Team')).toBeTruthy();
        expect(screen.getByText('By tier')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Models' })).toBeNull();
    });
});
