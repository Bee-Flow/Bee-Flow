// Integration status: each family's state for the chosen organisation, with
// the link to where it changes, per audience (an organisation admin never gets
// a link to a whole-server page), and the empty and unknown states.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FamilyAvailability, IntegrationFamily, OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { INTEGRATION_CATALOG } from '@/config/integrationCatalog';
import IntegrationStatusOverview from './IntegrationStatusOverview';

const yes: FamilyAvailability = { serverConfigured: true, inCeiling: true, available: true };
const notGranted: FamilyAvailability = { serverConfigured: true, inCeiling: false, available: false, reason: 'not_granted_to_org' };
const notSetUp: FamilyAvailability = { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' };
const FAMILY_IDS: IntegrationFamily[] = ['google', 'microsoft', 'nextcloud', 'github', 'n8n', 'maps', 'mcp', 'meetingNotes', 'projects', 'learningCenter', 'automations', 'imageGen'];

function answer(families: Partial<Record<IntegrationFamily, FamilyAvailability>>, integrations: Record<string, FamilyAvailability> = {}): OrgIntegrationAvailability {
    return {
        orgId: 'org-b', homeOrg: false, degraded: false,
        families: Object.fromEntries(FAMILY_IDS.map(id => [id, families[id] ?? notGranted])) as Record<IntegrationFamily, FamilyAvailability>,
        nextcloud: { bound: false, apps: [], pairingAvailable: true },
        microsoft: { directoryConnected: false },
        github: { syncConfigured: false },
        signIn: { password: true, google: false, microsoft: false, ssoLicensed: false },
        // The server answers every catalogue id; the ones a test does not name are not granted.
        integrations: { ...Object.fromEntries(INTEGRATION_CATALOG.map(i => [i.id, notGranted])), ...integrations },
    };
}

const row = (id: string) => screen.getByTestId(`integration-status-${id}`);

describe('IntegrationStatusOverview', () => {
    it('shows each family with its state and the place to change it', () => {
        render(<IntegrationStatusOverview read={{ data: answer({ n8n: yes, github: notGranted, maps: notSetUp }) }} platformAdmin />);
        expect(row('n8n')).toHaveAttribute('data-state', 'available');
        expect(row('github')).toHaveAttribute('data-state', 'not_granted');
        expect(within(row('github')).getByRole('link', { name: /Access/ })).toHaveAttribute('href', '/app/admin/access/grants');
        expect(within(row('maps')).getByRole('link', { name: /Platform services/ })).toHaveAttribute('href', '/app/admin/integrations/connected-apps');
    });

    it('gives an organisation admin the reason but no link to a whole-server page', () => {
        render(<IntegrationStatusOverview read={{ data: answer({ maps: notSetUp }) }} platformAdmin={false} />);
        expect(within(row('maps')).queryByRole('link')).toBeNull();
        expect(screen.getByText(/Your platform administrator can set it up/)).toBeInTheDocument();
    });

    it('lists the per-user apps as "each member connects", by category', async () => {
        const user = userEvent.setup();
        render(<IntegrationStatusOverview read={{ data: answer({ n8n: yes }, { fireflies: yes, nmbrs: notGranted }) }} platformAdmin={false} />);
        await user.click(screen.getByRole('button', { name: /Productivity/ }));
        expect(row('fireflies')).toHaveAttribute('data-state', 'per_user');
        expect(within(row('fireflies')).getByRole('link', { name: /Settings › Connections/ })).toHaveAttribute('href', '/app/settings/integrations');
        expect(row('nmbrs')).toHaveAttribute('data-state', 'not_granted');
    });

    it('says per audience when nothing is available', () => {
        const { unmount } = render(<IntegrationStatusOverview read={{ data: answer({}) }} platformAdmin={false} />);
        expect(screen.getByTestId('integration-status-empty')).toHaveTextContent('Ask your platform administrator');
        unmount();
        render(<IntegrationStatusOverview read={{ data: answer({}) }} platformAdmin />);
        const empty = screen.getByTestId('integration-status-empty');
        expect(empty).toHaveTextContent('Platform services');
        expect(within(empty).getByRole('link', { name: /Platform services/ })).toBeInTheDocument();
    });

    it('an organisation admin whose read failed gets a retry and no rows', async () => {
        const refetch = vi.fn();
        const user = userEvent.setup();
        render(<IntegrationStatusOverview read={{ data: null, isError: true, refetch }} platformAdmin={false} />);
        expect(screen.queryByTestId('integration-status-n8n')).toBeNull();
        await user.click(screen.getByRole('button', { name: /Try again/ }));
        expect(refetch).toHaveBeenCalled();
    });

    it('a platform admin whose read failed still sees every row, marked unknown', () => {
        render(<IntegrationStatusOverview read={{ data: null, isError: true }} platformAdmin />);
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(row('n8n')).toHaveAttribute('data-state', 'unknown');
    });
});
