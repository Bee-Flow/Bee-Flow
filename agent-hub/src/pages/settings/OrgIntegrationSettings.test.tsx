// Integration status page: the configuration cards follow the CHOSEN
// organisation's availability. Pinned: n8n is not shown for another
// organisation just because it is not the viewer's own (the old
// `!homeOrg → true` shortcut), and the instance-wide Maps key is not here.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availabilityAnswer, availabilityOrgOf } from '@/test/organisationHubKit';
import { withQueryClient } from '@/test/queryWrapper';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import type { IntegrationFamily } from '@/api/queries/orgIntegrationAvailability';
import OrgIntegrationSettings from './OrgIntegrationSettings';

/** Answers the availability read (with `off` families closed) and the panels' own reads; records every address. */
function stubApi({ off = [], ncBound = false }: { off?: IntegrationFamily[]; ncBound?: boolean } = {}): RecordedCall[] {
    return stubRecordingFetch(({ url }) => {
        const org = availabilityOrgOf(url);
        if (org) return jsonResponse(availabilityAnswer({ orgId: org, homeOrg: org === 'org-a', off, ncBound }));
        if (url.endsWith('/nc-integrations')) return jsonResponse({ enabled: [], ncCatalog: [{ id: 'nextcloud-talk', name: 'Talk', description: 'Chat' }] });
        if (url.endsWith('/nc-integrations/groups')) return jsonResponse({ groups: [] });
        if (url.includes('/ai/n8n/config')) return jsonResponse({ n8nUrl: '', hasApiKey: false, configured: false, workflows: [] });
        return jsonResponse({});
    });
}

afterEach(() => { vi.unstubAllGlobals(); });

const PLATFORM_ADMIN = { isAdmin: true, role: 'admin', organizationId: 'org-a', enabledIntegrations: ['n8n', 'maps'] };

describe('OrgIntegrationSettings', () => {
    it('reads the chosen organisation, not the viewer\'s: no n8n card where n8n is not granted to it', async () => {
        const asked = stubApi({ off: ['n8n', 'nextcloud'] });
        render(withQueryClient(<OrgIntegrationSettings user={PLATFORM_ADMIN} orgId="org-b" homeOrg={false} />));
        expect(await screen.findByTestId('integration-status-n8n')).toHaveAttribute('data-state', 'not_in_plan');
        expect(asked.some(a => availabilityOrgOf(a.url) === 'org-b')).toBe(true);
        expect(screen.queryByTestId('org-integrations-n8n')).toBeNull();
        expect(screen.queryByTestId('org-nc-integrations')).toBeNull();
    });

    it('shows the n8n and Nextcloud configuration where the organisation has them', async () => {
        stubApi({ ncBound: true });
        render(withQueryClient(<OrgIntegrationSettings user={{ orgRole: 'org_admin', organizationId: 'org-a' }} />));
        expect(await screen.findByTestId('org-integrations-n8n')).toBeInTheDocument();
        expect(await screen.findByTestId('org-nc-integrations')).toBeInTheDocument();
    });

    it('no longer carries the instance-wide Google Maps key', async () => {
        stubApi();
        render(withQueryClient(<OrgIntegrationSettings user={PLATFORM_ADMIN} orgId="org-a" />));
        await screen.findByTestId('integration-status-maps');
        expect(screen.queryByTestId('org-integrations-maps')).toBeNull();
        expect(screen.queryByText(/Google Maps API key/i)).toBeNull();
    });
});
