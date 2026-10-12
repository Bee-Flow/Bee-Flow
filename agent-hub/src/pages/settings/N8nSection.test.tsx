// Settings → Organisation → Integrations → n8n. Pinned: the three sections
// are real tabs, and the Permissions tab's link to Users & Groups is an app
// address (the server's old bare /settings/... value opened the app home).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args: unknown[]) => authFetch(...args) }));

import N8nSection from './N8nSection';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function serve(permissions: Record<string, unknown>) {
    authFetch.mockImplementation(async (url: string) => {
        if (url === '/ai/n8n/config') return ok({ n8nUrl: '', hasApiKey: false, configured: false, workflows: [] });
        if (url === '/ai/n8n/permissions') return ok(permissions);
        return { ok: false, status: 404, json: async () => ({}) };
    });
}

async function openPermissions() {
    const user = userEvent.setup();
    render(<N8nSection />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Connection', 'Workflows', 'Permissions']);
    expect(screen.getByRole('tab', { name: 'Connection' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    return screen.findByRole('link', { name: /Users & Groups/ });
}

describe('N8nSection', () => {
    beforeEach(() => { authFetch.mockReset(); });

    it('links Users & Groups to the settings address when the server sends a bare path', async () => {
        serve({ modify_n8n_workflows: [], availableGroups: [], orgAdminAlways: true, editUrl: '/settings/organisation/users' });
        expect(await openPermissions()).toHaveAttribute('href', '/app/settings/organisation/users');
    });

    it('follows an app address from the server', async () => {
        serve({ modify_n8n_workflows: [], availableGroups: [], orgAdminAlways: true, editUrl: '/app/settings/organisation/users' });
        expect(await openPermissions()).toHaveAttribute('href', '/app/settings/organisation/users');
    });
});
