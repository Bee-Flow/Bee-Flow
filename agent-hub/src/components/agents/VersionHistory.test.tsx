import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, toastMock } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../shared/Toast', () => ({ default: toastMock, toast: toastMock }));

import VersionHistory from './VersionHistory';

/**
 * The version list in the legacy agent designer (AgentDesigner → Identity).
 *
 * A restore that did not land used to read as one that did: the panel never
 * looked at the answer, reloaded its list and called `onRestore` — which there
 * is `window.location.reload()`. Since the root-billing merge the server says
 * so out loud, `409 restore_not_applied` when no row was written (the agent
 * changed hands while the restore ran), and the panel has to pass that on.
 */

const VERSIONS = [
    { id: 'v2', version_number: 2, created_at: '2026-09-20 10:00:00', change_summary: 'Tone' },
    { id: 'v1', version_number: 1, created_at: '2026-09-19 10:00:00', change_summary: 'Initial version' },
];

const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

/** GET /versions/a1 lists; POST …/restore answers with `restore`. */
function serve(restore: ReturnType<typeof json>) {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
        if (init?.method === 'POST' && url.endsWith('/versions/a1/v1/restore')) return restore;
        if (url.endsWith('/versions/a1')) return json(VERSIONS);
        return json({ error: 'unexpected' }, 404);
    });
}

async function restoreVersionOne(onRestore: () => void) {
    const user = userEvent.setup();
    render(<VersionHistory agentId="a1" onRestore={onRestore} />);
    await user.click(screen.getByRole('button', { name: /Version History/ }));
    await screen.findByText('v1');
    const restoreButtons = screen.getAllByRole('button', { name: 'Restore this version' });
    await user.click(restoreButtons[1]);
    const dialog = await screen.findByRole('dialog', { name: 'Restore to version 1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('VersionHistory restore', () => {
    it('says so when the server did not apply the restore, and does not act as if it had', async () => {
        serve(json({
            error: 'The agent changed while this version was being restored. Reload it and try again.',
            code: 'restore_not_applied',
        }, 409));
        const onRestore = vi.fn();
        await restoreVersionOne(onRestore);

        await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
        expect(toastMock.error).toHaveBeenCalledWith('Restore failed. Your content is unchanged — try again.');
        expect(onRestore).not.toHaveBeenCalled();
    });

    it('hands a restore that landed to the parent', async () => {
        serve(json({ success: true, restoredTo: 1 }));
        const onRestore = vi.fn();
        await restoreVersionOne(onRestore);

        await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
        expect(toastMock.error).not.toHaveBeenCalled();
    });
});
