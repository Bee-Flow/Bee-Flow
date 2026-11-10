import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminDashboard from './AdminDashboard';
import LicenseContext from '@/components/licensing/LicenseContext';
import { withQueryClient } from '@/test/queryWrapper';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

const superAdmin = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'] };
const securityAdmin = { id: 'u2', isAdmin: false, role: 'user', permissions: ['admin_security'] };
const nobody = { id: 'u3', isAdmin: false, role: 'user', permissions: [] };

beforeEach(() => {
    // Every panel the tests open reads from the server; an empty answer is enough here.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

function renderDashboard({ user = superAdmin, seg1, license = {} }: { user?: object; seg1?: string; license?: Partial<LicenseValue> } = {}) {
    const onNavigate = vi.fn();
    const onBack = vi.fn();
    const value = { tier: 'community', deploymentMode: 'self-hosted', serverOverride: false, hasTier: () => false, hasFeature: () => false, ...license } as LicenseValue;
    render(withQueryClient(
        <LicenseContext.Provider value={value}>
            <AdminDashboard user={user as never} onBack={onBack} onNavigate={onNavigate} adminPath={{ seg1 }} />
        </LicenseContext.Provider>,
    ));
    return { onNavigate, onBack };
}

const rail = () => screen.getByRole('navigation', { name: 'Admin Dashboard' });

describe('AdminDashboard navigation', () => {
    it('lists only the tabs a community self-hosted super-admin may open, grouped', () => {
        renderDashboard({ seg1: 'licenses' });
        const nav = within(rail());
        for (const name of ['AI Config', 'Security', 'Integrations', 'Access', 'Server licence', 'Modules', 'Languages']) {
            expect(nav.getByRole('link', { name })).toBeInTheDocument();
        }
        // Enterprise-only and cloud-only tabs stay hidden, even from the operator.
        for (const name of ['Agents', 'Monitoring', 'Compliance', 'Subscriptions', 'Product Website', 'Release Notes']) {
            expect(nav.queryByRole('link', { name })).not.toBeInTheDocument();
        }
        expect(nav.getByText('Security & access')).toBeInTheDocument();
        expect(nav.queryByText('Website')).not.toBeInTheDocument();
    });

    it('shows the enterprise and cloud tabs on an enterprise cloud install', () => {
        renderDashboard({ seg1: 'licenses', license: { tier: 'enterprise', deploymentMode: 'cloud' } });
        const nav = within(rail());
        for (const name of ['Agents', 'Monitoring', 'Compliance', 'Subscriptions', 'Product Website', 'Release Notes']) {
            expect(nav.getByRole('link', { name })).toBeInTheDocument();
        }
        expect(nav.getByText('Website')).toBeInTheDocument();
    });

    it('shows an org admin only the tabs their permission opens', () => {
        renderDashboard({ user: securityAdmin, seg1: 'licenses', license: { tier: 'enterprise', deploymentMode: 'cloud' } });
        const links = within(rail()).getAllByRole('link').map(a => a.textContent);
        expect(links).toEqual(['Security', 'Access']);
    });

    it('marks the tab from the URL as current and renders its panel', () => {
        renderDashboard({ seg1: 'modules' });
        expect(within(rail()).getByRole('link', { name: 'Modules' })).toHaveAttribute('aria-current', 'page');
        expect(within(rail()).getByRole('link', { name: 'Server licence' })).not.toHaveAttribute('aria-current');
        expect(screen.getByTestId('admin-tab-modules')).toBeInTheDocument();
    });

    it('navigates to admin/<tab> when a rail row is clicked', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderDashboard({ seg1: 'licenses' });
        await user.click(within(rail()).getByRole('link', { name: 'Modules' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/modules');
    });

    it('goes back from the rail', async () => {
        const user = userEvent.setup();
        const { onBack } = renderDashboard({ seg1: 'licenses' });
        await user.click(within(screen.getByTestId('admin-rail')).getByRole('button', { name: 'Back to chat' }));
        expect(onBack).toHaveBeenCalled();
    });

    it('opens the rail as a drawer from the narrow top bar and closes it on a choice', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderDashboard({ seg1: 'licenses' });
        await user.click(screen.getByRole('button', { name: 'Admin sections: Server licence' }));
        const drawer = await screen.findByRole('dialog', { name: 'Admin sections' });
        await user.click(within(drawer).getByRole('link', { name: 'Languages' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/languages');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('refuses the whole dashboard to a user without any admin permission', async () => {
        const user = userEvent.setup();
        const { onBack } = renderDashboard({ user: nobody });
        expect(screen.getByRole('heading', { name: 'Access Denied' })).toBeInTheDocument();
        expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Go Back' }));
        expect(onBack).toHaveBeenCalled();
    });
});

describe('AdminDashboard scope groups', () => {
    const orgAdmin = {
        id: 'u4', isAdmin: false, role: 'user', orgRole: 'org_admin', organizationId: 'org-1',
        permissions: ['org_admin', 'admin_agents', 'admin_ai_config', 'admin_security', 'admin_monitoring', 'admin_compliance', 'manage_users'],
    };
    const enterprise = { tier: 'enterprise', deploymentMode: 'self-hosted' } as const;

    it('gives a platform admin both groups: the organisation and the whole server', () => {
        renderDashboard({ seg1: 'agents', license: enterprise });
        const nav = within(rail());
        expect(nav.getByTestId('admin-rail-section-org')).toHaveTextContent('Organisations');
        expect(nav.getByTestId('admin-rail-section-org')).not.toHaveTextContent('Your organisation');
        expect(nav.getByTestId('admin-rail-section-instance')).toHaveTextContent('Whole server');
        expect(within(nav.getByTestId('admin-rail-section-org')).getAllByRole('link').map(a => a.textContent))
            .toEqual(['Agents', 'Security', 'Access', 'Compliance', 'Monitoring']);
        const server = within(nav.getByTestId('admin-rail-section-instance')).getAllByRole('link').map(a => a.textContent);
        expect(server).toEqual(expect.arrayContaining(['AI Config', 'Integrations', 'Modules', 'Server licence', 'Languages']));
        expect(server).not.toContain('Agents');
    });

    it('gives an organisation admin one group and no tab about the whole server', () => {
        renderDashboard({ user: orgAdmin, seg1: 'agents', license: enterprise });
        const nav = within(rail());
        expect(nav.getByTestId('admin-rail-section-org')).toHaveTextContent('Your organisation');
        expect(nav.queryByTestId('admin-rail-section-instance')).not.toBeInTheDocument();
        expect(nav.queryByText('Whole server')).not.toBeInTheDocument();
        expect(nav.getAllByRole('link').map(a => a.textContent)).toEqual(['Agents', 'Security', 'Access', 'Compliance', 'Monitoring']);
    });

    it('leaves the Agents tab out when the viewer has no agent section left', () => {
        const systemOnly = { ...orgAdmin, permissions: [...orgAdmin.permissions, 'admin_agents_system'], allowedAgentTypes: ['system'] };
        renderDashboard({ user: systemOnly, seg1: 'agents', license: enterprise });
        const links = within(rail()).getAllByRole('link').map(a => a.textContent);
        expect(links).not.toContain('Agents');
        expect(links[0]).toBe('Security');
    });

    it('sends an organisation admin who follows a link to a server-wide tab to the first visible tab', () => {
        renderDashboard({ user: orgAdmin, seg1: 'ai-config', license: enterprise });
        expect(within(rail()).getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
        expect(screen.queryByTestId('admin-tab-ai-config')).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Access Denied' })).not.toBeInTheDocument();
    });
});

