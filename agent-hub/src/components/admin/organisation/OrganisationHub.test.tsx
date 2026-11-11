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

    it('offers a part the server ties to the own organisation only for that one', async () => {
        renderOrgTab({ section: 'meeting-templates', search: '?org=org-b', plan: entitlements([], ['meeting_notes']) });
        expect(await screen.findByTestId('admin-home-org-only')).toBeInTheDocument();
    });

    it('on a self-hosted install: no License & Usage, and the Azure setup last in Connections, marked server-wide', async () => {
        renderOrgTab({ section: 'info', search: '?org=org-a', deploymentMode: 'self-hosted' });
        await screen.findByDisplayValue('Org A');
        expect(nav().queryByRole('link', { name: 'License & Usage' })).not.toBeInTheDocument();
        const rows = groupRows('Connections');
        const azure = rows[rows.length - 1];
        expect(azure).toHaveAccessibleName('Azure Configuration Whole server');
        expect(within(azure).getByTestId('server-wide-mark')).toBeInTheDocument();
        expect(nav().getAllByTestId('server-wide-mark')).toHaveLength(1);
    });

    it('puts the sections in the rail groups, links each to its address, and draws no menu of its own', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderOrgTab({ section: 'info', search: '?org=org-a', plan: entitlements(['learning_center'], ['meeting_notes']) });
        await screen.findByDisplayValue('Org A');
        const group = (eyebrow: string) => groupRows(eyebrow).map(a => a.textContent);
        expect(group('Workspace')).toEqual(['Organisation Info', 'Sign-in Method', 'License & Usage', 'Academy']);
        expect(group('AI & agents')).toEqual(['Agents', 'AI & Collaboration', 'Answer Reuse', 'Meeting Templates']);
        expect(group('Security & access')).toEqual(['Security', 'Access', 'Encryption']);
        expect(group('Connections')).toEqual(['Integrations', 'MCP Library', 'MCP Access', 'Nextcloud Sync']);
        expect(group('Operations')).toEqual(['Monitoring']);
        expect(nav().queryByRole('link', { name: 'Organisation' })).not.toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'Organisation Info' })).toHaveAttribute('aria-current', 'page');
        expect(nav().getByRole('link', { name: 'Encryption' })).toHaveAttribute('href', expect.stringContaining('/admin/organisation/encryption'));
        expect(screen.queryByRole('navigation', { name: 'Organisation' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('navigation')).toHaveLength(1);
        await user.click(nav().getByRole('link', { name: 'Academy' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/organisation/academy');
    });

    it('marks the row of the open section', async () => {
        renderOrgTab({ section: 'encryption', search: '?org=org-a' });
        expect(await nav().findByRole('link', { name: 'Encryption' })).toHaveAttribute('aria-current', 'page');
        expect(await screen.findByTestId('org-section-body-encryption')).toBeInTheDocument();
    });

    it('admin/organisation without a section opens the first visible section, named in the narrow top bar', async () => {
        renderOrgTab({ section: '', search: '?org=org-a' });
        expect(await screen.findByTestId('org-section-body-info')).toBeInTheDocument();
        expect(nav().getByRole('link', { name: 'Organisation Info' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Admin sections: Organisation Info' })).toBeInTheDocument();
    });
});

describe('the Organisation tab for an organisation admin by role', () => {
    it('works on the home organisation: no picker, its name in the bar, no orgId on the request', async () => {
        renderOrgTab({ user: ORG_ADMIN_BY_ROLE, section: 'mcp-access' });
        await waitFor(() => expect(policyReads()).toContain('/api/org/mcp-access'));
        expect(policyReads().every(u => !u.includes('orgId='))).toBe(true);
        expect(picker()).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-scope-bar')).toHaveTextContent('Org A');
        expect(screen.queryByTestId('admin-choose-org')).not.toBeInTheDocument();
    });

    it('gets the organisation\'s own group sync instead of the Azure setup on self-hosted, unmarked', async () => {
        renderOrgTab({ user: ORG_ADMIN_BY_ROLE, section: 'info', deploymentMode: 'self-hosted' });
        expect(await nav().findByRole('link', { name: 'Group sync' })).toBeInTheDocument();
        expect(nav().queryByRole('link', { name: /Azure Configuration/ })).not.toBeInTheDocument();
        expect(nav().queryByTestId('server-wide-mark')).not.toBeInTheDocument();
        expect(screen.queryByTestId('admin-rail-section-instance')).not.toBeInTheDocument();
    });
});
