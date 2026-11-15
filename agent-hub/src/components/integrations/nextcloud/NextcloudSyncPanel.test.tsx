// Nextcloud sync: the sync mode is a radio-card choice, and every control
// saves itself with a status (no Save button at the bottom of a long page);
// a failed save says so and offers a retry; "Sync now" reports what it did.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import NextcloudSyncPanel from './NextcloudSyncPanel';

let calls: RecordedCall[];
let putStatus: number;

beforeEach(() => {
    putStatus = 200;
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'PUT' && url.endsWith('/nc-sync')) return jsonResponse({ ok: putStatus === 200 }, putStatus);
        if (method === 'POST' && url.endsWith('/nc-sync/run')) return jsonResponse({ created: 2, deactivated: 1 });
        if (url.endsWith('/nc-sync')) return jsonResponse({ mode: 'mirror_all', syncGroups: [], excludedGroups: [], newUserDefaultStatus: 'active', ncBaseUrl: 'https://cloud.example', lastSyncAt: null });
        if (url.endsWith('/nc-sync/groups')) return jsonResponse({ groups: ['sales', 'ops'] });
        if (url.endsWith('/nc-sync/users')) return jsonResponse({ users: [{ id: 'u1', displayName: 'Ada', email: 'ada@example.com', status: 'active' }] });
        return jsonResponse({});
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

const puts = () => calls.filter(c => c.method === 'PUT');

async function renderPanel() {
    const user = userEvent.setup();
    render(withQueryClient(<NextcloudSyncPanel orgId="org-a" />));
    await screen.findByTestId('nextcloud-sync-panel');
    return user;
}

describe('NextcloudSyncPanel', () => {
    it('picks the sync mode from radio cards and saves it at once', async () => {
        const user = await renderPanel();
        const modes = screen.getByRole('radiogroup', { name: 'Sync mode' });
        expect(within(modes).getByRole('radio', { name: /Mirror everyone/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

        await user.click(within(modes).getByRole('radio', { name: /Manual only/ }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0]).toMatchObject({ url: expect.stringContaining('/auth/admin/org-a/nc-sync'), body: { mode: 'manual' } });
        expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    });

    it('does not store "Selected groups" without a group: that would mirror nobody and a group change would switch accounts off', async () => {
        const user = await renderPanel();
        await user.click(within(screen.getByRole('radiogroup', { name: 'Sync mode' })).getByRole('radio', { name: /Selected groups/ }));
        expect(await screen.findByText(/Pick at least one group/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Sync now/ })).toBeDisabled();
        expect(puts()).toHaveLength(0);
        // The first group saves the mode together with it.
        await user.click(within(screen.getByText('Groups to mirror').closest('div')?.parentElement as HTMLElement).getByRole('checkbox', { name: 'sales' }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(puts()[0].body).toMatchObject({ mode: 'selective_groups', syncGroups: ['sales'] });
        expect(screen.queryByText(/Pick at least one group/)).toBeNull();
    });

    it('sends quick changes one after another, so an earlier save never lands last', async () => {
        const order: string[] = [];
        let release: (() => void) | null = null;
        vi.unstubAllGlobals();
        calls = stubRecordingFetch(() => jsonResponse({}));
        const answers = (call: RecordedCall) => {
            if (call.method === 'PUT') return jsonResponse({ ok: true });
            if (call.url.endsWith('/nc-sync')) return jsonResponse({ mode: 'mirror_all', syncGroups: [], excludedGroups: [], newUserDefaultStatus: 'active', ncBaseUrl: '', lastSyncAt: null });
            if (call.url.endsWith('/nc-sync/groups')) return jsonResponse({ groups: ['sales', 'ops'] });
            if (call.url.endsWith('/nc-sync/users')) return jsonResponse({ users: [] });
            return jsonResponse({});
        };
        vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
            const call: RecordedCall = { method: init?.method ?? 'GET', url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
            calls.push(call);
            if (call.method === 'PUT') {
                const groups = (call.body as { excludedGroups: string[] }).excludedGroups.join(',');
                order.push(`start:${groups}`);
                // The first save is slow: it may only finish after the second has started if they overlap.
                if (!release) await new Promise<void>(r => { release = r; });
                order.push(`end:${groups}`);
            }
            return answers(call);
        }));
        const user = await renderPanel();
        const excluded = within(screen.getByText('Excluded groups').closest('div')?.parentElement as HTMLElement);
        await user.click(excluded.getByRole('checkbox', { name: 'sales' }));
        await user.click(excluded.getByRole('checkbox', { name: 'ops' }));
        await waitFor(() => expect(order).toEqual(['start:sales']));
        (release as unknown as () => void)();
        await waitFor(() => expect(order).toEqual(['start:sales', 'end:sales', 'start:sales,ops', 'end:sales,ops']));
    });

    it('says a change was not saved and retries it', async () => {
        putStatus = 500;
        const user = await renderPanel();
        await user.selectOptions(screen.getByLabelText('New user default status'), 'pending');
        expect(await screen.findByRole('alert')).toHaveTextContent('Not saved. Try again.');
        putStatus = 200;
        await user.click(screen.getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect(puts()[1].body).toMatchObject({ newUserDefaultStatus: 'pending' });
    });

    it('runs a sync and reports the counts', async () => {
        const user = await renderPanel();
        await user.click(screen.getByRole('button', { name: /Sync now/ }));
        expect(await screen.findByText('Sync done: 2 created, 1 deactivated.')).toBeInTheDocument();
        expect(screen.getByText('Never')).toBeInTheDocument();
    });
});
