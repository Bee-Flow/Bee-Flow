// The admin dashboard's Organisation tab, rendered in the dashboard: which
// organisation its sections work on (the scope bar's choice for a platform
// admin, the home organisation for anyone else), what they send, and its nav.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORG_ADMIN_BY_ROLE, entitlements, renderOrgTab, stubOrgApi } from '@/test/organisationHubKit';

let asked: string[];
beforeEach(() => { asked = stubOrgApi(); });

const policyReads = () => asked.filter(u => u.includes('/api/org/mcp-access')).map(u => u.slice(u.indexOf('/api/org/mcp-access')));
const nav = () => within(screen.getByRole('navigation', { name: 'Organisation' }));
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

    it('offers a part the server ties to the own organisation only for that one', async () => {
        asked = stubOrgApi({ github: true });
        renderOrgTab({ section: 'github-sync', search: '?org=org-b' });
        expect(await screen.findByTestId('admin-home-org-only')).toBeInTheDocument();
    });

    it('on a self-hosted install: no License & Usage, and the Azure setup last under "Whole server", marked', async () => {
        renderOrgTab({ section: 'info', search: '?org=org-a', deploymentMode: 'self-hosted' });
        await screen.findByDisplayValue('Org A');
        expect(nav().queryByRole('button', { name: 'License & Usage' })).not.toBeInTheDocument();
        const rows = nav().getAllByRole('button');
        const azure = rows[rows.length - 1];
        expect(azure).toHaveAccessibleName('Azure Configuration Whole server');
        expect(within(azure).getByTestId('server-wide-mark')).toBeInTheDocument();
    });

    it('groups the sections under the Settings topics, and navigates by section', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderOrgTab({ section: 'info', search: '?org=org-a', plan: entitlements(['learning_center'], ['meeting_notes']) });
        await screen.findByDisplayValue('Org A');
        for (const eyebrow of ['Organisation', 'People', 'Privacy & security', 'AI & data', 'Connections']) {
            expect(nav().getByText(eyebrow)).toBeInTheDocument();
        }
        expect(nav().getByRole('button', { name: 'Organisation Info' })).toHaveAttribute('aria-current', 'page');
        await user.click(nav().getByRole('button', { name: 'Academy' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/organisation/academy');
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
        expect(await nav().findByRole('button', { name: 'Group sync' })).toBeInTheDocument();
        expect(nav().queryByRole('button', { name: /Azure Configuration/ })).not.toBeInTheDocument();
        expect(nav().queryByTestId('server-wide-mark')).not.toBeInTheDocument();
    });
});
