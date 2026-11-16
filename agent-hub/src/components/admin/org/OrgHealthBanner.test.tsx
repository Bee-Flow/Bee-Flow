import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, fail } from '@/test/http';
import { withQueryClient } from '@/test/render';
import OrgHealthBanner from './OrgHealthBanner';
import { useConnectorHealth } from '@/api/queries/orgAdminReads';
import { authFetch } from '@/utils/helpers';
import { asMock } from '@/test/mocks';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import type { ReactNode } from 'react';

const NC_PROBLEM = {
    code: 'connector.app_removed', severity: 'error',
    message: 'The Bee Flow app in Nextcloud is disabled or no longer installed.',
    remediation: 'Re-enable it.',
};

/** The dashboard's organisation choice: `chosen` on a server whose viewer's home is org-home. */
function inDashboard(node: ReactNode, chosen: string | null) {
    const choice: AdminOrgChoice = {
        isPlatformAdmin: true, orgId: chosen, orgName: null, organizations: [], organizationsLoaded: true,
        pending: false, homeOrganization: { id: 'org-home', name: 'Home' }, setOrgId: () => {},
    };
    return withQueryClient(<AdminOrgProvider value={choice}>{node}</AdminOrgProvider>);
}

/** Says when /mine has been read, so a test can tell "nothing to show" from "not read yet". */
function MineRead() {
    return useConnectorHealth() ? <span data-testid="mine-read" /> : null;
}

/** /mine answers `health`; the availability read says whether the home org has its Nextcloud. */
function answer(health: unknown, ncAvailable: boolean) {
    asMock(authFetch).mockImplementation((url: string) => {
        if (url.includes('integration-availability')) {
            return ok({ orgId: 'org-home', families: { nextcloud: { serverConfigured: true, inCeiling: true, available: ncAvailable, ...(ncAvailable ? {} : { reason: 'not_bound' }) } }, integrations: {} });
        }
        return ok(health);
    });
}

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

describe('OrgHealthBanner', () => {
    beforeEach(() => { cleanup(); asMock(authFetch).mockReset(); });

    it('renders the amber pending-approval banner', async () => {
        asMock(authFetch).mockImplementation(() => ok({
            health: 'users_pending_approval',
            problems: [],
            users: { total: 8, active: 4, pending: 4 },
        }));
        render(withQueryClient(<OrgHealthBanner />));
        expect(await screen.findByText('4 people are waiting for approval and cannot use AI yet.')).toBeTruthy();
        expect(screen.getByText('Approve them in the member list below to unlock access.')).toBeTruthy();
        // No org-blocked banner without error/critical problems.
        expect(screen.queryByText(/AI chat is not available/)).toBeNull();
    });

    it('renders the rose org-blocked banner with soft wording and server-sanitized problem text', async () => {
        asMock(authFetch).mockImplementation(() => ok({
            health: 'no_subscription',
            problems: [{
                code: 'chat.subscription_blocked', severity: 'critical',
                message: 'AI chat has not been activated for your workspace.',
                remediation: 'Ask your Bee Flow contact to complete the setup.',
            }],
            users: { total: 8, active: 8, pending: 0 },
        }));
        render(withQueryClient(<OrgHealthBanner />));
        expect(await screen.findByText('AI chat is not available for your organisation yet — a configuration step is still needed.')).toBeTruthy();
        expect(screen.getByText('AI chat has not been activated for your workspace.')).toBeTruthy();
        expect(screen.getByText('Ask your Bee Flow contact to complete the setup.')).toBeTruthy();
        // Soft wording only: never operator/billing internals in this surface.
        expect(screen.queryByText(/subscription/i)).toBeNull();
        expect(screen.queryByText(/billing/i)).toBeNull();
    });

    it('renders null when healthy', async () => {
        asMock(authFetch).mockImplementation(() => ok({ health: 'ok', problems: [], users: { total: 3, active: 3, pending: 0 } }));
        const { container } = render(withQueryClient(<OrgHealthBanner />));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('renders null on 403 (non-connector org) — silent-fail contract', async () => {
        asMock(authFetch).mockImplementation(() => fail(403, { error: 'forbidden' }));
        const { container } = render(withQueryClient(<OrgHealthBanner />));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('renders null on network error — silent-fail contract', async () => {
        asMock(authFetch).mockImplementation(() => Promise.reject(new Error('offline')));
        const { container } = render(withQueryClient(<OrgHealthBanner />));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('renders null on a malformed body — silent-fail contract', async () => {
        asMock(authFetch).mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
        const { container } = render(withQueryClient(<OrgHealthBanner />));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('renders null when unhealthy but with nothing actionable (no pending, no blocking problems)', async () => {
        asMock(authFetch).mockImplementation(() => ok({
            health: 'inactive',
            problems: [{ code: 'x', severity: 'info', message: 'informational' }],
            users: { total: 3, active: 3, pending: 0 },
        }));
        const { container } = render(withQueryClient(<OrgHealthBanner />));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('says one person, not "1 user(s)"', async () => {
        asMock(authFetch).mockImplementation(() => ok({ health: 'users_pending_approval', problems: [], users: { total: 2, active: 1, pending: 1 } }));
        render(withQueryClient(<OrgHealthBanner />));
        expect(await screen.findByText('1 person is waiting for approval and cannot use AI yet.')).toBeTruthy();
    });

    it('stays away when the dashboard shows another organisation than the one /mine reports', async () => {
        answer({ health: 'users_pending_approval', problems: [], users: { total: 8, active: 4, pending: 4 } }, true);
        render(inDashboard(<><OrgHealthBanner /><MineRead /></>, 'org-other'));
        await screen.findByTestId('mine-read');
        expect(screen.queryByText(/waiting for approval/)).toBeNull();
    });

    it('reports the home organisation when the dashboard shows it', async () => {
        answer({ health: 'users_pending_approval', problems: [], users: { total: 8, active: 4, pending: 4 } }, true);
        render(inDashboard(<OrgHealthBanner />, 'org-home'));
        expect(await screen.findByText('4 people are waiting for approval and cannot use AI yet.')).toBeTruthy();
    });

    it('drops a Nextcloud problem when the organisation is no longer bound to a Nextcloud', async () => {
        answer({ health: 'connector_error', problems: [NC_PROBLEM], users: { total: 3, active: 2, pending: 1 } }, false);
        render(inDashboard(<OrgHealthBanner />, null));
        // The pending banner proves /mine was read; the Nextcloud problem must not stay with it.
        expect(await screen.findByText('1 person is waiting for approval and cannot use AI yet.')).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(NC_PROBLEM.message)).toBeNull());
    });

    it('keeps a Nextcloud problem while the organisation is bound', async () => {
        answer({ health: 'connector_error', problems: [NC_PROBLEM], users: { total: 3, active: 3, pending: 0 } }, true);
        render(inDashboard(<OrgHealthBanner />, null));
        expect(await screen.findByText(NC_PROBLEM.message)).toBeTruthy();
    });
});
