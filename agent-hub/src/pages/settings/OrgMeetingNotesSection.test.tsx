// The Meeting notes page of an organisation: the summary templates, then a card
// per meeting source the CHOSEN organisation can use (its integration
// availability), or one line that says where a source comes from. The Teams
// setup cards are the Microsoft 365 page's in the admin dashboard.

import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationFamily } from '@/api/queries/orgIntegrationAvailability';
import { renderWithClient } from '@/test/render';
import { jsonAnswer } from '@/test/http';
import { availabilityAnswer, availabilityOrgOf } from '@/test/organisationHubKit';
import OrgMeetingNotesSection from './OrgMeetingNotesSection';

interface Answer {
    off?: IntegrationFamily[];
    ncBound?: boolean;
    /** The availability read fails. */
    fails?: boolean;
}

/** Answers the availability of whichever organisation is asked, and an empty settings document for everything else. */
function stubApi({ off = [], ncBound = false, fails = false }: Answer = {}): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        asked.push(address);
        const org = availabilityOrgOf(address);
        if (org) return fails ? jsonAnswer({ error: 'down' }, 500) : jsonAnswer(availabilityAnswer({ orgId: org, homeOrg: org === 'org-a', off, ncBound }));
        return jsonAnswer({});
    }));
    return asked;
}

const ORG_ADMIN = { id: 'u2', permissions: ['org_admin'], organizationId: 'org-a' };
const PLATFORM_ADMIN = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'], organizationId: 'org-a' };

type Props = Partial<Parameters<typeof OrgMeetingNotesSection>[0]>;
const mount = (props: Props = {}) => renderWithClient(
    <OrgMeetingNotesSection user={ORG_ADMIN} orgId="org-a" homeOrg inDashboard {...props} />,
);

const heading = (name: string) => screen.queryByRole('heading', { name });

beforeEach(() => cleanup());
afterEach(() => vi.unstubAllGlobals());

describe('OrgMeetingNotesSection: one card per source the organisation can use', () => {
    it('shows Talk, Google Meet and Teams for a Nextcloud-bound organisation that has all three', async () => {
        stubApi({ ncBound: true });
        mount();
        expect(await screen.findByRole('heading', { name: 'Google Meet' })).toBeInTheDocument();
        expect(heading('Microsoft Teams')).toBeInTheDocument();
        expect(heading('Nextcloud Talk')).toBeInTheDocument();
        expect(heading('Summary templates')).toBeInTheDocument();
        expect(screen.queryByTestId('meeting-sources-none')).toBeNull();
    });

    it('leaves Talk out for an organisation without a Nextcloud', async () => {
        stubApi({ ncBound: false });
        mount();
        expect(await screen.findByRole('heading', { name: 'Google Meet' })).toBeInTheDocument();
        expect(heading('Nextcloud Talk')).toBeNull();
    });

    it('leaves Google Meet out without the Google family, and Teams out without the Microsoft one', async () => {
        stubApi({ off: ['google'] });
        mount();
        expect(await screen.findByRole('heading', { name: 'Microsoft Teams' })).toBeInTheDocument();
        expect(heading('Google Meet')).toBeNull();
        cleanup();
        stubApi({ off: ['microsoft'] });
        mount();
        expect(await screen.findByRole('heading', { name: 'Google Meet' })).toBeInTheDocument();
        expect(heading('Microsoft Teams')).toBeNull();
    });

    it('says where a source comes from when none applies, and still shows the summary templates', async () => {
        stubApi({ off: ['google', 'microsoft'] });
        mount();
        const none = await screen.findByTestId('meeting-sources-none');
        expect(within(none).getByRole('link', { name: /Open Access/ })).toHaveAttribute('href', expect.stringContaining('/app/admin/access'));
        expect(within(none).getByRole('link', { name: /Open Integration status/ })).toHaveAttribute('href', expect.stringContaining('/app/admin/organisation/integrations'));
        expect(heading('Summary templates')).toBeInTheDocument();
    });

    it('shows no source without Meeting Notes for the organisation', async () => {
        stubApi({ off: ['meetingNotes'], ncBound: true });
        mount();
        expect(await screen.findByTestId('meeting-sources-none')).toBeInTheDocument();
        expect(heading('Google Meet')).toBeNull();
        expect(heading('Nextcloud Talk')).toBeNull();
    });

    it('asks about the CHOSEN organisation, not the viewer\'s own', async () => {
        const asked = stubApi({ off: ['google'] });
        mount({ user: PLATFORM_ADMIN, orgId: 'org-b', homeOrg: false });
        expect(await screen.findByRole('heading', { name: 'Microsoft Teams' })).toBeInTheDocument();
        expect(asked.some(a => availabilityOrgOf(a) === 'org-b')).toBe(true);
        expect(asked.some(a => availabilityOrgOf(a) === 'org-a')).toBe(false);
    });
});

describe('OrgMeetingNotesSection: when the availability cannot be read', () => {
    it('shows the cards to a platform admin with a note that it could not check', async () => {
        stubApi({ fails: true });
        mount({ user: PLATFORM_ADMIN });
        expect(await screen.findByTestId('meeting-sources-unknown')).toBeInTheDocument();
        expect(heading('Google Meet')).toBeInTheDocument();
    });

    it('configures nothing for an organisation admin, and says it could not check rather than that nothing is available', async () => {
        stubApi({ fails: true });
        mount();
        expect(await screen.findByTestId('meeting-sources-unknown')).toBeInTheDocument();
        expect(screen.queryByTestId('meeting-sources-none')).toBeNull();
        expect(heading('Google Meet')).toBeNull();
    });
});

describe('OrgMeetingNotesSection: the Teams setup', () => {
    it('is the Microsoft 365 page\'s in the admin dashboard: the Teams card points there', async () => {
        stubApi();
        mount();
        expect(await screen.findByRole('heading', { name: 'Microsoft Teams' })).toBeInTheDocument();
        expect(screen.queryByTestId('teams-setup-guide')).toBeNull();
        expect(screen.queryByTestId('teams-consent-link')).toBeNull();
    });

    it('stays under the Teams card outside the dashboard (Settings on a phone)', async () => {
        stubApi();
        mount({ orgId: undefined, inDashboard: false });
        expect(await screen.findByTestId('teams-setup-guide')).toBeInTheDocument();
    });

    it('shows the summary templates of the viewer\'s own organisation only', async () => {
        stubApi();
        mount({ user: PLATFORM_ADMIN, orgId: 'org-b', homeOrg: false });
        expect(await screen.findByRole('heading', { name: 'Google Meet' })).toBeInTheDocument();
        expect(heading('Summary templates')).toBeNull();
        expect(screen.getAllByTestId('admin-home-org-only').length).toBeGreaterThan(0);
    });
});
