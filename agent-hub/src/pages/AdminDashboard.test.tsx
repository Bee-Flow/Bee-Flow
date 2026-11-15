import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminDashboard from './AdminDashboard';
import EntitlementsContext, { type EntitlementsValue } from '@/components/licensing/EntitlementsContext';
import LicenseContext from '@/components/licensing/LicenseContext';
import { withQueryClient } from '@/test/queryWrapper';
import { availabilityAnswer, availabilityOrgOf } from '@/test/organisationHubKit';
import { setCurrentUser } from '@/utils/scopedStorage';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

const superAdmin = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'] };
const securityAdmin = { id: 'u2', isAdmin: false, role: 'user', permissions: ['admin_security'] };
const nobody = { id: 'u3', isAdmin: false, role: 'user', permissions: [] };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** The organisations GET /auth/organizations lists (the Nextcloud instances row reads them); none by default. */
let serverOrgs: object[] = [];

beforeEach(() => {
    serverOrgs = [];
    // The dashboard remembers the last licence answer of this tab (useSteadyLicenceTier), per signed-in person.
    window.sessionStorage.clear();
    setCurrentUser(null);
    // Every panel the tests open reads from the server; an empty answer is enough here,
    // except the chosen organisation's integration availability, which the rail's rows
    // read: this organisation has no Learning Center, meeting notes or GitHub.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const orgId = availabilityOrgOf(String(url));
        if (orgId) return json(availabilityAnswer({ orgId, off: ['learningCenter', 'meetingNotes', 'github'] }));
        return String(url).endsWith('/auth/organizations') ? json(serverOrgs) : json({});
    }));
});

function renderDashboard({ user = superAdmin, seg1, seg2, license = {}, capabilities = [] }: { user?: object; seg1?: string; seg2?: string; license?: Partial<LicenseValue>; capabilities?: string[] } = {}) {
    const onNavigate = vi.fn();
    const onBack = vi.fn();
    const value = { tier: 'community', deploymentMode: 'self-hosted', serverOverride: false, hasTier: () => false, hasFeature: () => false, ...license } as LicenseValue;
    const entitlements = { loading: false, degraded: false, error: null, can: (id: string) => capabilities.includes(id), inCeiling: (id: string) => capabilities.includes(id) } as EntitlementsValue;
    render(withQueryClient(
        <EntitlementsContext.Provider value={entitlements}>
            <LicenseContext.Provider value={value}>
                <AdminDashboard user={user as never} onBack={onBack} onNavigate={onNavigate} adminPath={{ seg1, seg2 }} />
            </LicenseContext.Provider>
        </EntitlementsContext.Provider>,
    ));
    return { onNavigate, onBack };
}

const rail = () => screen.getByRole('navigation', { name: 'Admin Dashboard' });
/** The rows of a part of the rail, by name (a server-wide row's mark adds no text). */
const rowNames = (el: HTMLElement) => within(el).getAllByRole('link').map(a => a.textContent?.trim());

describe('AdminDashboard navigation', () => {
    // Changed on purpose (wave 2): the target tree's labels; the hubs' sections are rows and child rows.
    it('lists only the tabs a community self-hosted super-admin may open, grouped', () => {
        renderDashboard({ seg1: 'licenses' });
        const nav = within(rail());
        for (const name of ['Organisation info', 'People', 'AI configuration', 'Privacy Shield', 'Access', 'Usage & monitoring', 'Sign-in & SSO', 'Licence & features', 'Server licence', 'Feature switches', 'Modules', 'Languages']) {
            expect(nav.getByRole('link', { name })).toBeInTheDocument();
        }
        // The organisation's integration status (Connections) and the server's platform services.
        expect(within(nav.getByTestId('admin-rail-section-instance')).getByRole('link', { name: 'Platform services' })).toHaveAttribute('href', expect.stringContaining('/admin/integrations'));
        expect(within(nav.getByTestId('admin-rail-section-org')).getByRole('link', { name: 'Integration status' })).toHaveAttribute('href', expect.stringContaining('/admin/organisation/integrations'));
        // Enterprise-only and cloud-only tabs stay hidden, even from the operator (the guardrail console is Enterprise).
        for (const name of ['Agents', 'Compliance', 'Subscriptions', 'Product Website', 'Release Notes', 'Guardrail library', 'Appearance']) {
            expect(nav.queryByRole('link', { name })).not.toBeInTheDocument();
        }
        expect(nav.getByText('Security & access')).toBeInTheDocument();
        expect(nav.queryByText('Website')).not.toBeInTheDocument();
    });

    it('shows the enterprise and cloud tabs on an enterprise cloud install', () => {
        renderDashboard({ seg1: 'licenses', license: { tier: 'enterprise', deploymentMode: 'cloud' }, capabilities: ['compliance_hub_gdpr'] });
        const nav = within(rail());
        for (const name of ['Agents', 'Compliance', 'Subscriptions', 'Release Notes']) {
            expect(nav.getByRole('link', { name })).toBeInTheDocument();
        }
        // The builder leaves the dashboard chrome: its row says so.
        const website = nav.getByRole('link', { name: 'Product Website Opens full screen' });
        expect(within(website).getByTestId('admin-rail-full-screen')).toBeInTheDocument();
        // Changed on purpose (wave 2): the whole-server block has its group headings too.
        const server = within(nav.getByTestId('admin-rail-section-instance'));
        expect(server.getByText('Website')).toBeInTheDocument();
        expect(server.getByRole('link', { name: 'Release Notes' })).toBeInTheDocument();
    });

    // Compliance follows the capability, as Settings did: the plan name is not the rule.
    it('offers Compliance on the capability, below Enterprise, and not without it', () => {
        renderDashboard({ seg1: 'licenses', capabilities: ['compliance_hub_gdpr'] });
        expect(within(rail()).getByRole('link', { name: 'Compliance' })).toBeInTheDocument();
    });

    it('hides Compliance on an Enterprise plan that lacks the capability', () => {
        renderDashboard({ seg1: 'licenses', license: { tier: 'enterprise', deploymentMode: 'cloud' } });
        expect(within(rail()).queryByRole('link', { name: 'Compliance' })).not.toBeInTheDocument();
    });

    // Changed on purpose (wave 2): admin_security opens People; the Privacy Shield is for an admin of the home organisation.
    it('shows an org admin only the tabs their permission opens', () => {
        renderDashboard({ user: securityAdmin, seg1: 'licenses', license: { tier: 'enterprise', deploymentMode: 'cloud' } });
        const links = within(rail()).getAllByRole('link').map(a => a.textContent);
        expect(links).toEqual(['People', 'Access']);
    });

    it('marks the tab from the URL as current and renders its panel', () => {
        renderDashboard({ seg1: 'modules' });
        expect(within(rail()).getByRole('link', { name: 'Modules' })).toHaveAttribute('aria-current', 'page');
        expect(within(rail()).getByRole('link', { name: 'Licence & features' })).not.toHaveAttribute('aria-current');
        expect(screen.getByTestId('admin-tab-modules')).toBeInTheDocument();
    });

    it('heads every page with its rail row: the label and the row\'s description, at the width of the page', () => {
        renderDashboard({ seg1: 'licenses', seg2: 'server' });
        const header = within(screen.getByTestId('admin-tab-licenses')).getByTestId('admin-page-header');
        expect(within(header).getByRole('heading', { level: 2, name: 'Server licence' })).toBeInTheDocument();
        expect(header).toHaveTextContent('The licence key of this server and what it includes.');
        expect(screen.getByTestId('admin-tab-licenses').querySelector('[data-admin-page-width]')).toHaveAttribute('data-admin-page-width', 'settings');
    });

    // Changed on purpose (wave 3): the feature switches open on their own note, so the row adds no description that repeats it.
    it('says what the feature switches do once', () => {
        renderDashboard({ seg1: 'licenses', seg2: 'features' });
        const tab = screen.getByTestId('admin-tab-licenses');
        expect(within(within(tab).getByTestId('admin-page-header')).getByRole('heading', { level: 2, name: 'Feature switches' })).toBeInTheDocument();
        expect(tab.textContent?.split('Switch platform features on or off for everyone on this server.')).toHaveLength(2);
    });

    it('heads a tool that fills the pane too, above the tool', () => {
        renderDashboard({ seg1: 'languages' });
        const tab = screen.getByTestId('admin-tab-languages');
        expect(within(within(tab).getByTestId('admin-page-header')).getByRole('heading', { level: 2, name: 'Languages' })).toBeInTheDocument();
        expect(tab.querySelector('[data-admin-page-width]')).toHaveAttribute('data-admin-page-width', 'fill');
    });

    // The hubs whose rows render the section body only (no padding of their own): the frame pads them.
    it.each([
        ['ai-config', 'retrieval', 'settings'],
        ['ai-config', 'providers', 'wide'],
        ['security', 'sso', 'settings'],
        ['access', 'grants', 'wide'],
    ])('pads the %s/%s page in the frame, at the %s width', (seg1, seg2, width) => {
        renderDashboard({ seg1, seg2 });
        const page = screen.getByTestId(`admin-tab-${seg1}`).querySelector('[data-admin-page-width]');
        expect(page).toHaveAttribute('data-admin-page-width', width);
        expect(page).toHaveClass('p-6');
    });

    it('shows a hub\'s child rows under its row while it is open, the first one current on the hub\'s own address', () => {
        renderDashboard({ seg1: 'licenses' });
        const children = within(screen.getByTestId('admin-rail-children-licenses'));
        expect(children.getByRole('link', { name: 'Server licence' })).toHaveAttribute('aria-current', 'page');
        expect(children.getByRole('link', { name: 'Feature switches' })).toHaveAttribute('href', expect.stringContaining('/admin/licenses/features'));
        expect(screen.queryByTestId('admin-rail-children-ai-config')).not.toBeInTheDocument();
    });

    // Changed on purpose (wave 4): Subscriptions had its own section column; its sections are child rows now.
    it('lists the Subscriptions sections as child rows, with no second column in the pane', () => {
        renderDashboard({ seg1: 'subscriptions', seg2: 'audit', license: { deploymentMode: 'cloud' } });
        const children = within(screen.getByTestId('admin-rail-children-subscriptions'));
        expect(children.getByRole('link', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
        expect(children.getByRole('link', { name: 'Plans' })).toHaveAttribute('href', expect.stringContaining('/admin/subscriptions/plans'));
        const pane = within(screen.getByTestId('admin-tab-subscriptions'));
        expect(pane.queryByRole('navigation')).not.toBeInTheDocument();
        expect(within(pane.getByTestId('admin-page-header')).getByRole('heading', { level: 2, name: 'Audit' })).toBeInTheDocument();
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

    it('tells a member of an organisation without a plan whom to ask, on the licence page the gate sends them to', () => {
        renderDashboard({ user: nobody, seg1: 'organisation', seg2: 'license', license: { deploymentMode: 'cloud' } });
        expect(screen.getByTestId('admin-access-denied-no-plan')).toHaveTextContent('Ask an administrator of your organisation');
        expect(screen.queryByRole('heading', { name: 'Access Denied' })).not.toBeInTheDocument();
    });
});

describe('AdminDashboard scope groups', () => {
    const orgAdmin = {
        id: 'u4', isAdmin: false, role: 'user', orgRole: 'org_admin', organizationId: 'org-1',
        permissions: ['org_admin', 'admin_agents', 'admin_ai_config', 'admin_security', 'admin_monitoring', 'admin_compliance', 'manage_users'],
    };
    const enterprise = { tier: 'enterprise', deploymentMode: 'self-hosted' } as const;
    const COMPLIANCE = ['compliance_hub_gdpr'];

    it('gives a platform admin both groups: the organisation and the whole server', async () => {
        renderDashboard({ seg1: 'agents', license: { ...enterprise, hasTier: () => true }, capabilities: COMPLIANCE });
        const nav = within(rail());
        // Changed on purpose (wave 3): the Nextcloud instances row goes once the organisations say none has a Nextcloud.
        await waitFor(() => expect(nav.queryByRole('link', { name: 'Nextcloud instances' })).not.toBeInTheDocument());
        expect(nav.getByTestId('admin-rail-section-org')).toHaveTextContent('Organisations');
        expect(nav.getByTestId('admin-rail-section-org')).not.toHaveTextContent('Your organisation');
        expect(nav.getByTestId('admin-rail-section-instance')).toHaveTextContent('Whole server');
        // The Organisation tab's sections are rows in their groups; the account says cloud, so Licence & usage is one.
        // With "All organisations" chosen there is no organisation to read: a platform admin's rows fail open.
        // Changed on purpose (wave 2): the target tree of the organisation block.
        expect(rowNames(nav.getByTestId('admin-rail-section-org'))).toEqual([
            'Organisation info', 'Licence & usage', 'People', 'Projects', 'Learning Center', 'Usage & monitoring',
            'Agents', 'Knowledge bases', 'Models', 'Conversations', 'Memory', 'Meeting notes',
            'Preferred sign-in method', 'Access', 'Privacy Shield', 'Encryption', 'MCP client access', 'Compliance',
            'Integration status', 'MCP servers', 'Nextcloud', 'Microsoft 365', 'GitHub sync', 'Automations',
        ]);
        expect(nav.queryByRole('link', { name: 'Organisation' })).not.toBeInTheDocument();
        expect(rowNames(nav.getByTestId('admin-rail-section-instance'))).toEqual([
            'AI configuration', 'System agents',
            'Organisations', 'Roles & permissions', 'Sign-in & SSO', 'Guardrail library',
            'Platform services', 'MCP servers',
            'Licence & features', 'Modules', 'Appearance', 'Languages',
            'Support inbox',
        ]);
    });

    it('draws Nextcloud instances once an organisation on the server has a Nextcloud', async () => {
        serverOrgs = [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B', nc_instance_id: 'nc-1' }];
        renderDashboard({ seg1: 'licenses' });
        const server = within(within(rail()).getByTestId('admin-rail-section-instance'));
        expect(await server.findByRole('link', { name: 'Nextcloud instances' })).toHaveAttribute('href', expect.stringContaining('/admin/nextcloud-instances'));
    });

    it('gives an organisation admin one group and no tab about the whole server', async () => {
        renderDashboard({ user: orgAdmin, seg1: 'agents', license: enterprise, capabilities: COMPLIANCE });
        const nav = within(rail());
        // The rows that follow the organisation's availability come once it is read (closed until then).
        await nav.findByRole('link', { name: 'MCP servers' });
        expect(nav.getByTestId('admin-rail-section-org')).toHaveTextContent('Your organisation');
        expect(nav.queryByTestId('admin-rail-section-instance')).not.toBeInTheDocument();
        expect(nav.queryByText('Whole server')).not.toBeInTheDocument();
        // Changed on purpose (wave 2): the target tree; the Privacy Shield needs an admin of the home organisation.
        // Changed on purpose (wave 3): Nextcloud for the admin's own unbound organisation while pairing is offered.
        expect(rowNames(rail())).toEqual([
            'Organisation info', 'Licence & usage', 'People', 'Projects', 'Usage & monitoring',
            'Agents', 'Models', 'Conversations', 'Memory',
            'Preferred sign-in method', 'Access', 'Encryption', 'MCP client access', 'Compliance',
            'Integration status', 'MCP servers', 'Nextcloud', 'Microsoft 365', 'Automations',
        ]);
        expect(nav.queryByTestId('server-wide-mark')).not.toBeInTheDocument();
    });

    it('leaves the Agents tab out when the viewer has no agent section left', () => {
        const systemOnly = { ...orgAdmin, permissions: [...orgAdmin.permissions, 'admin_agents_system'], allowedAgentTypes: ['system'] };
        renderDashboard({ user: systemOnly, seg1: 'agents', license: enterprise });
        const links = rowNames(rail());
        expect(links).not.toContain('Agents');
        expect(links.slice(0, 3)).toEqual(['Organisation info', 'Licence & usage', 'People']);
    });

    it('opens the Organisation tab for an organisation admin by role alone, and falls back to it without Agents', async () => {
        const byRole = { id: 'u5', isAdmin: false, role: 'user', orgRole: 'admin', organizationId: 'org-1', permissions: [] };
        renderDashboard({ user: byRole, license: enterprise });
        await within(rail()).findByRole('link', { name: 'MCP servers' });
        // No 'org_admin' permission: the organisation-admin role opens it (and Access and People, which take org_admin too).
        // Changed on purpose (wave 3): Nextcloud for the admin's own unbound organisation while pairing is offered.
        expect(rowNames(rail())).toEqual([
            'Organisation info', 'Licence & usage', 'People', 'Projects', 'Usage & monitoring',
            'Models', 'Conversations', 'Memory',
            'Preferred sign-in method', 'Access', 'Encryption', 'MCP client access',
            'Integration status', 'MCP servers', 'Nextcloud', 'Microsoft 365', 'Automations',
        ]);
        // admin/ alone falls back to the Organisation tab, which opens its first section.
        expect(within(rail()).getByRole('link', { name: 'Organisation info' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('admin-tab-organisation')).toBeInTheDocument();
    });

    // Changed on purpose (wave 2): the refused tab is said so on its own address; it used to swap in Agents.
    it('refuses a server-wide tab an organisation admin follows a link to, with the rail still there', () => {
        renderDashboard({ user: orgAdmin, seg1: 'ai-config', license: enterprise });
        expect(screen.getByTestId('admin-access-denied-section')).toBeInTheDocument();
        expect(screen.queryByTestId('admin-tab-ai-config')).not.toBeInTheDocument();
        expect(screen.queryByTestId('admin-tab-agents')).not.toBeInTheDocument();
        expect(within(rail()).getByRole('link', { name: 'Agents' })).not.toHaveAttribute('aria-current');
    });

    it('waits for the licence before refusing a tier-gated tab: a fresh load of a deep link does not flash "access denied"', () => {
        // While the licence status loads the tier reads as Community, so Agents (Enterprise) is not open yet.
        renderDashboard({ seg1: 'agents', license: { loading: true } });
        expect(screen.getByTestId('admin-gates-pending')).toBeInTheDocument();
        expect(screen.queryByTestId('admin-access-denied-section')).not.toBeInTheDocument();
    });

    it('keeps the Agents row when a re-read of the licence fails (a 429 on a fast reload)', () => {
        // Sign-in names the person (AuthedApp), whose memory this is.
        setCurrentUser(orgAdmin.id);
        renderDashboard({ user: orgAdmin, seg1: 'agents', license: enterprise });
        expect(within(rail()).getByRole('link', { name: 'Agents' })).toBeInTheDocument();
        cleanup();
        // A full reload in the same tab: the read answers 429, so the context's tier is its Community default.
        renderDashboard({ user: orgAdmin, seg1: 'agents', license: { error: 'HTTP 429' } });
        expect(within(rail()).getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('admin-tab-agents')).toBeInTheDocument();
    });
});

