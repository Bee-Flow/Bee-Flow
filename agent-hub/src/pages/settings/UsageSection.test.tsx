/**
 * The Adoption report tab of Usage & Monitoring: present only with the
 * `advanced_usage_monitoring` licence feature (like Feedback and
 * Terminations), reachable by deep link, and without the page's
 * user/agent/model/source filter bar, which does not apply to it.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContextType } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import LicenseContext from '@/components/licensing/LicenseContext';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import UsageSection from './UsageSection';

type License = ContextType<typeof LicenseContext>;

function renderSection(features: string[], initialReport = '') {
    const value = { hasFeature: (name: string) => features.includes(name), deploymentMode: 'self-hosted' } as unknown as License;
    return renderWithClient(
        <LicenseContext.Provider value={value}>
            <UsageSection initialReport={initialReport} />
        </LicenseContext.Provider>,
    );
}

beforeEach(() => { setDemoTransport(createDemoTransport(ROUTES as unknown as DemoRoutes, createState())); });
afterEach(() => { setDemoTransport(null); });

describe('UsageSection: tabs and header', () => {
    it('orders Overview, Adoption, Spend, Quality behind advanced_usage_monitoring', () => {
        renderSection(['advanced_usage_monitoring']);
        const labels = ['Overview', 'Adoption', 'Spend', 'Quality'];
        const tabs = screen.getAllByRole('button').map(b => b.textContent ?? '').filter(x => labels.includes(x));
        expect(tabs).toEqual(labels);
    });

    it('shows Overview only without the feature, and a deep link falls back to it', () => {
        renderSection([], 'adoption');
        expect(screen.queryByRole('button', { name: 'Adoption' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Quality' })).toBeNull();
        expect(screen.getByText('Filters')).toBeVisible();
    });

    it('opens Adoption by deep link and drops the cross-cutting filter bar', async () => {
        renderSection(['advanced_usage_monitoring'], 'adoption');
        expect(await screen.findByText('107 of 148 members used AI')).toBeTruthy();
        expect(screen.queryByText('Filters')).toBeNull();
        expect(screen.getByRole('heading', { name: 'Usage & Monitoring' }).getAttribute('data-tour')).toBe('usage-summary');
    });

    it('switches to Adoption and Spend from the tab bar', async () => {
        const user = userEvent.setup();
        renderSection(['advanced_usage_monitoring']);
        await user.click(screen.getByRole('button', { name: 'Adoption' }));
        expect(await screen.findByText('Where the AI goes')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Spend' }));
        expect(await screen.findByText('Filters')).toBeVisible();
    });

    it('keeps the sub-tab when the active report tab is clicked again', async () => {
        const user = userEvent.setup();
        renderSection(['advanced_usage_monitoring'], 'adoption');
        await screen.findByText('107 of 148 members used AI');
        await user.click(screen.getByRole('button', { name: 'People' }));
        expect(screen.getByRole('button', { name: 'People' }).getAttribute('aria-pressed')).toBe('true');
        await user.click(screen.getByRole('button', { name: 'Adoption' }));
        expect(screen.getByRole('button', { name: 'People' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('opens Quality with the Feedback sub-tab for the feedback deep link', () => {
        renderSection(['advanced_usage_monitoring'], 'feedback');
        expect(screen.getByRole('button', { name: 'Feedback' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Terminations' }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByText('Filters')).toBeNull();
    });

    it('opens the Terminations sub-tab for the terminations deep link', () => {
        renderSection(['advanced_usage_monitoring'], 'terminations');
        expect(screen.getByRole('button', { name: 'Terminations' }).getAttribute('aria-pressed')).toBe('true');
    });

});
