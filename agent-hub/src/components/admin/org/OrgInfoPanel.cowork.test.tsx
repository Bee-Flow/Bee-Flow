// The organisation's Cowork policy has its own section (the dashboard's Organisation > Cowork row), so an organisation
// that does not use the Privacy Shield reaches it too: it used to sit under a Shield step that is closed while the
// Shield is off. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import OrganisationSection from '@/pages/settings/OrganisationSection';
import { SECTIONS } from './OrgInfoPanel';
import { ORG_HUB_SECTIONS } from '@/components/admin/organisation/orgSections';

const ORG = { id: 'org1', name: 'Acme BV', tagline: '', allowedDomains: [], piiShield: { enabled: false } };
const USER = { id: 'u1', organizationId: 'org1', permissions: ['org_admin'], featureFlags: { deploymentMode: 'self-hosted' } };

let calls: RecordedCall[];
afterEach(() => { vi.unstubAllGlobals(); });

describe('the Cowork section of an organisation', () => {
    it('is a section of its own, in Settings and in the dashboard', () => {
        expect(SECTIONS.map((s) => s.id)).toContain('cowork');
        expect(ORG_HUB_SECTIONS.find((s) => s.id === 'cowork')?.labelFallback).toBe('Cowork');
    });

    it('shows the policy of the organisation, with the Privacy Shield off', async () => {
        calls = stubRecordingFetch(({ url }) => {
            const path = new URL(url, 'http://localhost').pathname;
            if (path.endsWith('/auth/organizations')) return jsonResponse([ORG]);
            if (path.endsWith('/api/cowork/policy/org1')) return jsonResponse({ ceiling: 'on_its_own', readOnly: false, unattendedApps: null, monthlyBudget: null, habitsAllowed: true });
            return jsonResponse([]);
        });
        renderWithClient(<OrganisationSection user={USER} activeSection="cowork" />);
        expect(await screen.findByRole('switch', { name: /Make every cowork read-only/ })).toBeInTheDocument();
        expect(screen.getByLabelText('Monthly AI budget for all coworks')).toBeInTheDocument();
        await waitFor(() => expect(calls.some((c) => c.url.includes('/api/cowork/policy/org1'))).toBe(true));
    });
});
