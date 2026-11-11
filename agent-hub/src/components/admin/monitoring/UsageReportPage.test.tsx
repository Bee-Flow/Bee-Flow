/**
 * Adoption and Spend inside the AI Monitor: the Settings usage reports, reading the organisation
 * the dashboard chose, and open only with the advanced-monitoring capability.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { ADVANCED, ORG_ADMIN, PLATFORM_ADMIN, orgChoice, reads, renderMonitoring, serveMonitoring } from '@/test/monitoringKit';

afterEach(() => { setDemoTransport(null); });

const ADOPTION = '/api/usage/adoption/';
const SUBSCRIPTION = '/api/subscriptions/orgs/';
const HEADLINE = '107 of 148 members used AI';

describe('Monitoring > Adoption', () => {
    it('shows the organisation admin their own organisation without naming one', async () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'adoption', user: ORG_ADMIN, features: [ADVANCED], choice: orgChoice({}) });
        expect(await screen.findByText(HEADLINE)).toBeTruthy();
        expect(reads(asked, ADOPTION).length).toBeGreaterThan(0);
        expect(reads(asked, ADOPTION).every((u) => !u.searchParams.has('orgId'))).toBe(true);
    });

    it('reads the organisation a platform admin chose', async () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'adoption', user: PLATFORM_ADMIN, features: [ADVANCED], choice: orgChoice({ isPlatformAdmin: true, orgId: 'org-b', orgName: 'Org B' }) });
        expect(await screen.findByText(HEADLINE)).toBeTruthy();
        expect(reads(asked, ADOPTION).length).toBeGreaterThan(0);
        expect(reads(asked, ADOPTION).every((u) => u.searchParams.get('orgId') === 'org-b')).toBe(true);
    });

    it('asks a platform admin on all organisations to choose one, and reads no adoption', async () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'adoption', user: PLATFORM_ADMIN, features: [ADVANCED], choice: orgChoice({ isPlatformAdmin: true }) });
        expect(await screen.findByTestId('monitoring-choose-org')).toBeTruthy();
        expect(screen.queryByText(HEADLINE)).toBeNull();
        expect(reads(asked, ADOPTION)).toEqual([]);
    });

    it('waits for the organisation list before reading anything', () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'adoption', user: PLATFORM_ADMIN, features: [ADVANCED], choice: orgChoice({ isPlatformAdmin: true, pending: true }) });
        expect(screen.queryByTestId('monitoring-choose-org')).toBeNull();
        expect(reads(asked, ADOPTION)).toEqual([]);
    });
});

describe('Monitoring > Spend', () => {
    it('sends the chosen organisation with every usage read and reads that organisation\'s subscription', async () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'spend', user: PLATFORM_ADMIN, features: [ADVANCED], choice: orgChoice({ isPlatformAdmin: true, orgId: 'org-b', orgName: 'Org B' }) });
        expect(await screen.findByText('Filters')).toBeTruthy();
        await waitFor(() => expect(reads(asked, SUBSCRIPTION).map((u) => u.pathname)).toEqual([`${SUBSCRIPTION}org-b`]));
        const usage = asked.filter((u) => u.pathname.startsWith('/api/usage/') && !u.pathname.startsWith(ADOPTION) && u.searchParams.has('days'));
        expect(usage.length).toBeGreaterThan(0);
        expect(usage.every((u) => u.searchParams.get('orgId') === 'org-b')).toBe(true);
        expect(reads(asked, ADOPTION).every((u) => u.searchParams.get('orgId') === 'org-b')).toBe(true);
    });

    it('covers every organisation on all organisations, without a subscription or an adoption read', async () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'spend', user: PLATFORM_ADMIN, features: [ADVANCED], choice: orgChoice({ isPlatformAdmin: true }) });
        expect(await screen.findByText('Filters')).toBeTruthy();
        await waitFor(() => expect(asked.some((u) => u.pathname === '/api/usage/summary' && u.searchParams.has('days'))).toBe(true));
        expect(asked.filter((u) => u.pathname.startsWith('/api/usage/')).every((u) => !u.searchParams.has('orgId'))).toBe(true);
        expect(reads(asked, SUBSCRIPTION)).toEqual([]);
        expect(reads(asked, ADOPTION)).toEqual([]);
    });

    it('shows the organisation admin their own organisation', async () => {
        const asked = serveMonitoring();
        renderMonitoring({ page: 'spend', user: ORG_ADMIN, features: [ADVANCED], choice: orgChoice({}) });
        expect(await screen.findByText('Filters')).toBeTruthy();
        await waitFor(() => expect(reads(asked, ADOPTION).length).toBeGreaterThan(0));
        expect(asked.filter((u) => u.pathname.startsWith('/api/usage/')).every((u) => !u.searchParams.has('orgId'))).toBe(true);
    });
});

describe('Monitoring pages by capability', () => {
    const names = () => screen.getAllByRole('button').map((b) => b.textContent ?? '');

    it('lists every page with the advanced-monitoring capability, Adoption and Spend after Overview', () => {
        serveMonitoring();
        renderMonitoring({ page: 'overview', user: PLATFORM_ADMIN, features: [ADVANCED] });
        const labels = ['Overview', 'Adoption', 'Spend'];
        expect(names().filter((n) => labels.includes(n))).toEqual(labels);
    });

    it('lists Overview only without it, and a link to Adoption opens Overview', () => {
        serveMonitoring();
        renderMonitoring({ page: 'adoption', user: ORG_ADMIN });
        expect(screen.queryByRole('button', { name: 'Adoption' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Spend' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Feedback' })).toBeNull();
        expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeTruthy();
    });
});
