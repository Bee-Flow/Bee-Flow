// The organisation's image limits per user have one home, the Models page, in
// both deployment modes, and only for an organisation that can generate images.

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OrgImageLimitsSection from './OrgImageLimitsSection';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ORG = { id: 'org1', name: 'Acme', imageLimits: { day: 5 } };

let puts: Array<{ url: string; body: unknown }>;
let availability: { status: number; body: unknown };

const family = (available: boolean) => ({ serverConfigured: available, inCeiling: true, available, reason: available ? undefined : 'not_configured' });

beforeEach(() => {
    puts = [];
    availability = { status: 200, body: { orgId: 'org1', homeOrg: true, degraded: false, families: { imageGen: family(true) }, integrations: {} } };
    setDemoTransport(async (url: unknown, init: RequestInit = {}) => {
        const path = String(url);
        if ((init.method || 'GET') === 'PUT') {
            puts.push({ url: path, body: JSON.parse(String(init.body)) });
            return json({ success: true });
        }
        if (path.endsWith('/integration-availability')) return json(availability.body, availability.status);
        if (path.endsWith('/auth/organizations')) return json([ORG]);
        if (path.endsWith('/auth/groups')) return json([]);
        return json({}, 404);
    });
});
afterEach(() => { setDemoTransport(null); });

const choice = (isPlatformAdmin: boolean): AdminOrgChoice => ({
    isPlatformAdmin, orgId: 'org1', orgName: 'Acme', organizations: [], organizationsLoaded: true, pending: false,
    homeOrganization: { id: 'org1', name: 'Acme' }, setOrgId: () => {},
});

const renderSection = (isPlatformAdmin = false) => renderWithClient(
    <AdminOrgProvider value={choice(isPlatformAdmin)}><OrgImageLimitsSection orgId="org1" /></AdminOrgProvider>,
);

describe('OrgImageLimitsSection', () => {
    it('shows the stored limits and saves only the image limits, with its own Save', async () => {
        const user = userEvent.setup();
        renderSection();
        const day = await screen.findByLabelText('Per 24 hours');
        expect(day).toHaveValue(5);
        const save = screen.getByRole('button', { name: 'Save' });
        expect(save).toBeDisabled();

        await user.clear(day);
        await user.type(day, '10');
        await waitFor(() => expect(save).toBeEnabled());
        await user.click(save);

        await waitFor(() => expect(puts).toHaveLength(1));
        expect(puts[0].url).toMatch(/\/auth\/organizations\/org1$/);
        expect(puts[0].body).toEqual({ imageLimits: { day: 10 } });
    });

    it('says why a limit that is not a whole number is not saved', async () => {
        const user = userEvent.setup();
        renderSection();
        const hour = await screen.findByLabelText('Per hour');
        await user.type(hour, '1.5');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/whole number/);
        expect(puts).toHaveLength(0);
    });

    it('is not there for an organisation without an image model', async () => {
        availability.body = { orgId: 'org1', homeOrg: true, degraded: false, families: { imageGen: family(false) }, integrations: {} };
        renderSection(true);
        await waitFor(() => expect(screen.queryByTestId('org-image-limits')).toBeNull());
        expect(screen.queryByLabelText('Per hour')).toBeNull();
    });

    it('fails closed for an organisation admin when availability cannot be read', async () => {
        availability = { status: 500, body: {} };
        renderSection(false);
        await new Promise(r => setTimeout(r, 50));
        expect(screen.queryByLabelText('Per hour')).toBeNull();
    });

    it('fails open for a platform admin, with a note that it could not be checked', async () => {
        availability = { status: 500, body: {} };
        renderSection(true);
        expect(await screen.findByLabelText('Per hour')).toBeInTheDocument();
        expect(screen.getByText('Could not check whether this is available for this organisation')).toBeInTheDocument();
    });
});
