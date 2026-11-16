// The defaults for new organisations mark an integration the server cannot
// serve (no OAuth app, key or binding), read from the availability answer of
// the dashboard's organisation: a fact of the server, the same for every
// organisation. Unknown is not "not set up".
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalDefaultsSection from './GlobalDefaultsSection';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { withQueryClient } from '@/test/queryWrapper';

const AVAILABILITY = {
    orgId: 'org-a',
    integrations: {
        gmail: { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' },
        fireflies: { serverConfigured: true, inCeiling: true, available: true },
    },
};

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const body = String(url).includes('integration-availability') ? AVAILABILITY : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

const choice = (orgId: string | null): AdminOrgChoice => ({
    isPlatformAdmin: true, orgId, orgName: null, organizations: [], organizationsLoaded: true, pending: false, homeOrganization: null, setOrgId: () => {},
});

function renderSection(orgId: string | null) {
    return render(withQueryClient(
        <AdminOrgProvider value={choice(orgId)}>
            <GlobalDefaultsSection
                enableAllDefaults={vi.fn()}
                disableAllDefaults={vi.fn()}
                categories={['Mail']}
                allIntegrations={[
                    { id: 'gmail', label: 'Gmail', category: 'Mail' },
                    { id: 'fireflies', label: 'Fireflies', category: 'Mail' },
                ]}
                isDefaultEnabled={() => true}
                toggleDefault={vi.fn()}
            />
        </AdminOrgProvider>,
    ));
}

describe('GlobalDefaultsSection', () => {
    it('marks an integration this server cannot serve, and only that one', async () => {
        renderSection('org-a');
        expect(await screen.findByTestId('not-set-up-gmail')).toHaveTextContent('Not set up on this server');
        expect(screen.queryByTestId('not-set-up-fireflies')).toBeNull();
    });

    it('marks nothing without an organisation to ask', () => {
        renderSection(null);
        expect(screen.getByText('Gmail')).toBeInTheDocument();
        expect(screen.queryByTestId('not-set-up-gmail')).toBeNull();
    });

    it('draws no page header of its own (the dashboard frame does)', () => {
        renderSection(null);
        expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });
});
