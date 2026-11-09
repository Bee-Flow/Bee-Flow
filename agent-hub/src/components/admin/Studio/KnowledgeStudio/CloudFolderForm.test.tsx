import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AddSourcePanel from './AddSourcePanel';

const item = (over = {}) => ({
    provider: 'nextcloud_files', fileId: 'f1', driveId: null, path: '/Sales', name: 'Sales',
    mimeType: null, isFolder: true, size: null, modifiedAt: null, webUrl: null, ...over,
});

const PROVIDERS = {
    providers: [
        { provider: 'nextcloud_files', connected: true, reason: null },
        { provider: 'onedrive', connected: false, reason: 'not_connected' },
        { provider: 'google_drive', connected: true, reason: null },
    ],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = new URL(url, 'http://localhost');
        if (u.pathname.endsWith('/cloud/providers')) return json(PROVIDERS);
        return json(u.searchParams.get('parentId') === 'f1'
            ? { items: [item({ fileId: 'f2', path: '/Sales/Terms', name: 'Terms' }), item({ fileId: 'x1', name: 'readme.txt', isFolder: false })], nextPageToken: null }
            : { items: [item(), item({ fileId: 'f9', path: '/HR', name: 'HR' })], nextPageToken: null });
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

async function openForm() {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({});
    render(<AddSourcePanel canManage onCreate={onCreate} />);
    await user.click(screen.getByTestId('kb-add-kind-cloud_folder'));
    await screen.findByTestId('kb-form-cloud_folder');
    return { user, onCreate };
}

describe('CloudFolderForm', () => {
    it('shows a cloud that is not connected, disabled, with where to connect it', async () => {
        await openForm();
        const onedrive = await screen.findByTestId('kb-cloud-provider-onedrive');
        expect((onedrive as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/OneDrive is not connected/)).toBeTruthy();
        expect((screen.getByTestId('kb-cloud-provider-nextcloud_files') as HTMLButtonElement).disabled).toBe(false);
    });

    it('cannot choose the root, walks into a folder and shows files greyed', async () => {
        const { user } = await openForm();
        await user.click(await screen.findByTestId('kb-cloud-provider-nextcloud_files'));
        await screen.findByRole('button', { name: /Sales/ });
        expect((screen.getByTestId('kb-cloud-choose') as HTMLButtonElement).disabled).toBe(true);
        await user.click(screen.getByRole('button', { name: /Sales/ }));
        await screen.findByRole('button', { name: /Terms/ });
        const file = screen.getByTestId('kb-cloud-file');
        expect(file.getAttribute('aria-disabled')).toBe('true');
        const last = new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'http://localhost');
        expect(last.searchParams.get('provider')).toBe('nextcloud_files');
        expect(last.searchParams.get('parentId')).toBe('f1');
        expect(last.searchParams.get('path')).toBe('/Sales');
    });

    it('creates the source from the chosen folder, with recursion and the refresh rule', async () => {
        const { user, onCreate } = await openForm();
        await user.click(await screen.findByTestId('kb-cloud-provider-nextcloud_files'));
        await user.click(await screen.findByRole('button', { name: /Sales/ }));
        await user.click(await screen.findByTestId('kb-cloud-choose'));
        await user.click(screen.getByTestId('kb-cloud-recursive'));   // default on -> off
        await user.click(screen.getByTestId('kb-cloud-refresh'));
        await user.click(await screen.findByRole('menuitemradio', { name: 'When it changes' }));
        await user.click(screen.getByTestId('kb-cloud-submit'));
        await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
            kind: 'cloud_folder',
            config: { provider: 'nextcloud_files', folderId: 'f1', path: '/Sales', folderName: 'Sales', recursive: false },
            refresh: { mode: 'on_change' },
        }));
    });

    it('says which cloud problem the server refused with', async () => {
        const { user, onCreate } = await openForm();
        const err = Object.assign(new Error('x'), { code: 'cloud_folder_out_of_scope' });
        onCreate.mockRejectedValue(err);
        await user.click(await screen.findByTestId('kb-cloud-provider-google_drive'));
        await user.click(await screen.findByRole('button', { name: /Sales/ }));
        await user.click(await screen.findByTestId('kb-cloud-choose'));
        await user.click(screen.getByTestId('kb-cloud-submit'));
        expect(await screen.findByText(/may not read that folder yet/)).toBeTruthy();
    });
});
