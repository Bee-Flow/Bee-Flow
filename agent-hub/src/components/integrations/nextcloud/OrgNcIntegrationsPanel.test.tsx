// Nextcloud integrations: the org-wide tools are switches that save at once
// (a failed save puts the switch back), and the per-group exceptions say the
// runtime rule ("enable wins": a tool is blocked only when every group of a
// person blocks it).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient, withQueryClient } from '@/test/queryWrapper';
import { orgIntegrationAvailabilityKey } from '@/api/queries/orgIntegrationAvailability';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import OrgNcIntegrationsPanel from './OrgNcIntegrationsPanel';

let calls: RecordedCall[];
let putStatus: number;

const CATALOG = [
    { id: 'nextcloud-talk', name: 'Talk', description: 'Chat rooms' },
    { id: 'nextcloud-deck', name: 'Deck', description: 'Boards' },
];

beforeEach(() => {
    putStatus = 200;
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'PUT') return jsonResponse({ ok: putStatus === 200 }, putStatus);
        if (url.endsWith('/nc-integrations')) return jsonResponse({ enabled: ['nextcloud-talk'], ncCatalog: CATALOG });
        if (url.endsWith('/nc-integrations/groups')) return jsonResponse({ groups: [{ id: 'g1', name: 'Sales', userCount: 3, disabledIntegrations: [] }] });
        return jsonResponse({});
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The saves the panel sent, in order. */
const puts = () => calls.filter(({ method }) => method === 'PUT');

/** The panel for Org A, once its tools have loaded. */
async function renderPanel() {
    render(withQueryClient(<OrgNcIntegrationsPanel orgId="org-a" />));
    const user = userEvent.setup();
    expect(await screen.findByTestId('org-nc-integrations')).toBeInTheDocument();
    return user;
}

describe('OrgNcIntegrationsPanel', () => {
    it('saves an org-wide switch at once', async () => {
        const user = await renderPanel();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        await user.click(screen.getByRole('switch', { name: 'Deck' }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0]).toMatchObject({ url: expect.stringContaining('/auth/admin/org-a/nc-integrations'), body: { enabled: ['nextcloud-talk', 'nextcloud-deck'] } });
        expect(screen.getByRole('switch', { name: 'Deck' })).toBeChecked();
    });

    it('puts a switch back when its save fails, and says so', async () => {
        putStatus = 500;
        const user = await renderPanel();
        await user.click(screen.getByRole('switch', { name: 'Deck' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. Try again.');
        expect(screen.getByRole('switch', { name: 'Deck' })).not.toBeChecked();
    });

    it('marks the Integration status answer stale after a switch: the Nextcloud apps above follow it', async () => {
        const client = testQueryClient();
        client.setQueryData(orgIntegrationAvailabilityKey('org-a'), { orgId: 'org-a' });
        render(withQueryClient(<OrgNcIntegrationsPanel orgId="org-a" />, client));
        const user = userEvent.setup();
        await screen.findByTestId('org-nc-integrations');
        await user.click(screen.getByRole('switch', { name: 'Deck' }));
        await waitFor(() => expect(client.getQueryState(orgIntegrationAvailabilityKey('org-a'))?.isInvalidated).toBe(true));
    });

    it('does not undo a later switch when an earlier save fails', async () => {
        // The first save is slow and fails; the second is sent after it and is stored.
        let failFirst: (() => void) | null = null;
        vi.unstubAllGlobals();
        calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
            const call: RecordedCall = { method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
            calls.push(call);
            if (call.method === 'PUT') {
                if (!failFirst) {
                    await new Promise<void>(r => { failFirst = r; });
                    return jsonResponse({ ok: false }, 500);
                }
                return jsonResponse({ ok: true });
            }
            if (call.url.endsWith('/nc-integrations')) return jsonResponse({ enabled: [], ncCatalog: CATALOG });
            if (call.url.endsWith('/nc-integrations/groups')) return jsonResponse({ groups: [] });
            return jsonResponse({});
        }));
        const user = await renderPanel();
        await user.click(screen.getByRole('switch', { name: 'Talk' }));
        await user.click(screen.getByRole('switch', { name: 'Deck' }));
        await waitFor(() => expect(failFirst).not.toBeNull());
        (failFirst as unknown as () => void)();
        await waitFor(() => expect(puts()).toHaveLength(2));
        // The second save sent both and was stored: the switches show what is stored.
        expect(puts()[1].body).toEqual({ enabled: ['nextcloud-talk', 'nextcloud-deck'] });
        await waitFor(() => expect(screen.getByRole('switch', { name: 'Deck' })).toBeChecked());
        expect(screen.getByRole('switch', { name: 'Talk' })).toBeChecked();
    });

    it('explains "enable wins" and blocks a tool for a group', async () => {
        const user = await renderPanel();
        expect(screen.getByText(/only when every group they belong to blocks it/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Sales/ }));
        expect(screen.getByRole('checkbox', { name: 'Block Deck' })).toBeDisabled();
        await user.click(screen.getByRole('checkbox', { name: 'Block Talk' }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0]).toMatchObject({ url: expect.stringContaining('/nc-integrations/groups/g1'), body: { disabledIntegrations: ['nextcloud-talk'] } });
        expect(await screen.findByText('1 blocked')).toBeInTheDocument();
    });
});
