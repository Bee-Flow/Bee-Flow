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

describe('UsageSection: the Adoption tab', () => {
    it('sits after Overview behind advanced_usage_monitoring', () => {
        renderSection(['advanced_usage_monitoring']);
        const tabs = screen.getAllByRole('button').map(b => b.textContent);
        expect(tabs.indexOf('Adoption')).toBe(tabs.indexOf('Overview') + 1);
    });

    it('is absent without the feature, and a deep link falls back to Overview', () => {
        renderSection([], 'adoption');
        expect(screen.queryByRole('button', { name: 'Adoption' })).toBeNull();
        expect(screen.getByText('Filters')).toBeVisible();
    });

    it('opens by deep link and hides the cross-cutting filter bar', async () => {
        renderSection(['advanced_usage_monitoring'], 'adoption');
        expect(await screen.findByText('107 of 148 members used AI')).toBeTruthy();
        expect(screen.getByText('Filters')).not.toBeVisible();
        expect(screen.getByRole('heading', { name: 'Usage & Monitoring' }).getAttribute('data-tour')).toBe('usage-summary');
    });

    it('switches to Adoption from the tab bar', async () => {
        const user = userEvent.setup();
        renderSection(['advanced_usage_monitoring']);
        await user.click(screen.getByRole('button', { name: 'Adoption' }));
        expect(await screen.findByText('Where the AI goes')).toBeTruthy();
    });
});
