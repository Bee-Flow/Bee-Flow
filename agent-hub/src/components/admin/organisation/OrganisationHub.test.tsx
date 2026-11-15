// The admin dashboard's Organisation tab, rendered in the dashboard: which
// organisation its sections work on (the scope bar's choice for a platform
// admin, the home organisation for anyone else), what they send, and its
// sections as rows of the dashboard rail (no menu of its own).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_ADMIN_BY_ROLE, entitlements, renderOrgTab, stubOrgApi } from '@/test/organisationHubKit';

let asked: string[];
beforeEach(() => { asked = stubOrgApi(); });

const policyReads = () => asked.filter(u => u.includes('/api/org/mcp-access')).map(u => u.slice(u.indexOf('/api/org/mcp-access')));
const nav = () => within(screen.getByTestId('admin-rail-section-org'));
/** The rows under one eyebrow of the rail's organisation block. */
const groupRows = (eyebrow: string) => within(nav().getByText(eyebrow).parentElement as HTMLElement).getAllByRole('link');
const picker = () => screen.queryByRole('combobox', { name: 'Organisation' });

describe('the Organisation tab for a platform admin', () => {
    it('with All organisations chosen, a section asks for a choice and reads nothing', async () => {
        renderOrgTab({ section: 'mcp-access' });
        expect(await screen.findByTestId('admin-choose-org')).toHaveTextContent('Choose an organisation above to manage it');
        expect(policyReads()).toEqual([]);
        expect(screen.getByTestId('admin-scope-bar')).toHaveTextContent('Showing every organisation on this server');
    });

    it('with one organisation chosen, the section reads and is keyed by that organisation; a new choice reads the new one', async () => {
        const user = userEvent.setup();
        renderOrgTab({ section: 'mcp-access', search: '?org=org-b' });
        await waitFor(() => expect(policyReads()).toContain('/api/org/mcp-access?orgId=org-b'));
        expect(screen.queryByTestId('admin-choose-org')).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-scope-bar')).toHaveTextContent('Showing Org B only');

        await user.selectOptions(picker() as HTMLElement, 'Org A');
        await waitFor(() => expect(policyReads()).toContain('/api/org/mcp-access?orgId=org-a'));
        await user.selectOptions(picker() as HTMLElement, 'All organisations');
        expect(await screen.findByTestId('admin-choose-org')).toBeInTheDocument();
    });

    it('edits the chosen organisation\'s details, not the first one on the server', async () => {
        renderOrgTab({ section: 'info', search: '?org=org-b' });
        expect(await screen.findByDisplayValue('Org B')).toBeInTheDocument();
        expect(screen.queryByDisplayValue('Org A')).not.toBeInTheDocument();
    });

    it('works the GitHub sync of the chosen organisation', async () => {
        asked = stubOrgApi({ github: true });
        renderOrgTab({ section: 'github-sync', search: '?org=org-b' });
        await waitFor(() => expect(asked.some(u => u.includes('/api/integrations/github-sync/status?orgId=org-b'))).toBe(true));
        expect(screen.queryByTestId('admin-home-org-only')).not.toBeInTheDocument();
    });

    it('opens Conversations, Memory and Projects as pages of their own, and the old AI context address as Conversations', async () => {
        renderOrgTab({ section: 'ai-context', search: '?org=org-a' });
        expect(await screen.findByTestId('org-section-body-conversations')).toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'Conversations' })).toHaveAttribute('aria-current', 'page');
    });

    it('offers a part the server ties to the own organisation only for that one', async () => {
        renderOrgTab({ section: 'meeting-templates', search: '?org=org-b', plan: entitlements([], ['meeting_notes']) });
        // Changed on purpose (wave 3): one such part on this page, the summary templates; the Teams setup moved to Microsoft 365.
        expect(await screen.findAllByTestId('admin-home-org-only')).toHaveLength(1);
    });

    // Changed on purpose (wave 2): the instance-wide Azure form is no longer a row; Microsoft 365 is the organisation's own.
    it('on a self-hosted install: no Licence & usage, and Microsoft 365 in Connections, unmarked', async () => {
        renderOrgTab({ section: 'info', search: '?org=org-a', deploymentMode: 'self-hosted' });
        await screen.findByDisplayValue('Org A');
        expect(nav().queryByRole('link', { name: 'Licence & usage' })).not.toBeInTheDocument();
        await waitFor(() => expect(groupRows('Connections').map(a => a.textContent)).toContain('Microsoft 365'));
        expect(nav().queryAllByTestId('server-wide-mark')).toHaveLength(0);
    });

    it('puts the sections in the rail groups, links each to its address, and draws no menu of its own', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderOrgTab({ section: 'info', search: '?org=org-a', plan: entitlements(['learning_center'], ['meeting_notes']) });
        await screen.findByDisplayValue('Org A');
        const group = (eyebrow: string) => groupRows(eyebrow).map(a => a.textContent);
        // Changed on purpose (wave 2): the target tree's rows, labels and groups.
        expect(group('Workspace')).toEqual(['Organisation info', 'Licence & usage', 'People', 'Projects', 'Learning Center', 'Usage & monitoring']);
        expect(group('AI & agents')).toEqual(['Agents', 'Knowledge bases', 'Models', 'Conversations', 'Memory', 'Meeting notes']);
        expect(group('Security & access')).toEqual(['Preferred sign-in method', 'Access', 'Privacy Shield', 'Encryption', 'MCP client access']);
        // Org A has GitHub (the kit's availability): the row follows the organisation, not the viewer's own link.
        expect(group('Connections')).toEqual(['Integration status', 'MCP servers', 'Nextcloud', 'Microsoft 365', 'GitHub sync', 'Automations']);
        expect(nav().queryByText('Operations')).not.toBeInTheDocument();
        expect(nav().queryByRole('link', { name: 'Organisation' })).not.toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'Organisation info' })).toHaveAttribute('aria-current', 'page');
        expect(nav().getByRole('link', { name: 'Encryption' })).toHaveAttribute('href', expect.stringContaining('/admin/organisation/encryption'));
        expect(screen.queryByRole('navigation', { name: 'Organisation' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('navigation')).toHaveLength(1);
        await user.click(nav().getByRole('link', { name: 'Learning Center' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/organisation/academy');
    });

    it('reads the rows from the chosen organisation\'s availability, not from the viewer\'s session', async () => {
        asked = stubOrgApi({ availability: { off: ['mcp', 'automations'], ncBound: true } });
        renderOrgTab({ section: 'info', search: '?org=org-b' });
        await screen.findByDisplayValue('Org B');
        await waitFor(() => expect(nav().queryByRole('link', { name: 'MCP servers' })).not.toBeInTheDocument());
        expect(asked.some(u => u.includes('/auth/organizations/org-b/integration-availability'))).toBe(true);
        expect(nav().queryByRole('link', { name: 'Automations' })).not.toBeInTheDocument();
        // Org B is bound to a Nextcloud (the viewer's own session is not): sign-in is Nextcloud's, the sync row is there.
        expect(nav().queryByRole('link', { name: 'Preferred sign-in method' })).not.toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'Nextcloud' })).toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'MCP client access' })).toBeInTheDocument();
    });

    it('marks the row of the open section', async () => {
        renderOrgTab({ section: 'encryption', search: '?org=org-a' });
        expect(await nav().findByRole('link', { name: 'Encryption' })).toHaveAttribute('aria-current', 'page');
        expect(await screen.findByTestId('org-section-body-encryption')).toBeInTheDocument();
    });

    it('admin/organisation without a section opens the first visible section, named in the narrow top bar', async () => {
        renderOrgTab({ section: '', search: '?org=org-a' });
        expect(await screen.findByTestId('org-section-body-info')).toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'Organisation info' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Admin sections: Organisation info' })).toBeInTheDocument();
    });
});

describe('the Organisation tab for an organisation admin by role', () => {
    const marked = () => nav().queryAllByRole('link').filter(a => a.getAttribute('aria-current') === 'page').map(a => a.textContent);

    it('says why on the address of a section the organisation does not have, and marks no other row', async () => {
        asked = stubOrgApi({ availability: { off: ['mcp'] } });
        renderOrgTab({ user: ORG_ADMIN_BY_ROLE, section: 'mcp' });
        // While the availability is read, no row is marked in the requested one's place.
        expect(marked()).toEqual([]);
        const notice = await screen.findByTestId('org-section-unavailable-mcp');
        expect(notice).toHaveTextContent("Not included in this organisation's plan");
        // The page keeps the section's own name as its header.
        expect(within(screen.getByTestId('admin-page-header')).getByRole('heading', { level: 2, name: 'MCP servers' })).toBeInTheDocument();
        expect(marked()).toEqual([]);
        expect(screen.queryByTestId('org-section-body-info')).not.toBeInTheDocument();
    });

    it('opens a section it has on its address, marked in the rail and headed by its row', async () => {
        renderOrgTab({ user: ORG_ADMIN_BY_ROLE, section: 'mcp' });
        expect(await screen.findByTestId('org-section-body-mcp')).toBeInTheDocument();
        expect(marked()).toEqual(['MCP servers']);
        expect(within(screen.getByTestId('admin-page-header')).getByRole('heading', { level: 2, name: 'MCP servers' })).toBeInTheDocument();
    });

    it('works on the home organisation: no picker, its name in the bar, no orgId on the request', async () => {
        renderOrgTab({ user: ORG_ADMIN_BY_ROLE, section: 'mcp-access' });
        await waitFor(() => expect(policyReads()).toContain('/api/org/mcp-access'));
        expect(policyReads().every(u => !u.includes('orgId='))).toBe(true);
        expect(picker()).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-scope-bar')).toHaveTextContent('Org A');
        expect(screen.queryByTestId('admin-choose-org')).not.toBeInTheDocument();
    });

    // Changed on purpose (wave 2): the row is Microsoft 365 (the organisation's own group sync) for everyone.
    it('gets the organisation\'s own Microsoft 365 on self-hosted, unmarked', async () => {
        renderOrgTab({ user: ORG_ADMIN_BY_ROLE, section: 'info', deploymentMode: 'self-hosted' });
        expect(await nav().findByRole('link', { name: 'Microsoft 365' })).toBeInTheDocument();
        expect(nav().queryByRole('link', { name: /Azure Configuration/ })).not.toBeInTheDocument();
        expect(nav().queryByTestId('server-wide-mark')).not.toBeInTheDocument();
        expect(screen.queryByTestId('admin-rail-section-instance')).not.toBeInTheDocument();
    });
});
