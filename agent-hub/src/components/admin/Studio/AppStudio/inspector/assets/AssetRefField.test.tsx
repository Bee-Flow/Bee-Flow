import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { withQueryClient } from '@/test/queryWrapper';
import { jsonAnswer } from '@/test/http';
import AssetRefField from './AssetRefField';

afterEach(() => vi.unstubAllGlobals());

const LOGO = { id: 'a-logo', ref: 'asset:a-logo', mime: 'image/png', size: 2048, createdAt: null, usedBy: { draft: [], published: ['design.logoUrl'] } };
const FONT = { id: 'a-font', ref: 'asset:a-font', mime: 'font/woff2', size: 4096, createdAt: null, usedBy: { draft: [], published: [] } };

function stubServer() {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ method, url: String(url) });
        if (method === 'POST') return jsonAnswer({ asset: { ...LOGO, id: 'a-new', ref: 'asset:a-new' } }, 201);
        if (method === 'DELETE') return jsonAnswer({ success: true });
        return jsonAnswer({ assets: [LOGO, FONT], limits: { maxBytes: 5 * 1024 * 1024, maxAssets: 200, types: ['image/png'] } });
    }));
    return calls;
}

function Harness({ initial = null, definition = {} }: { initial?: string | null; definition?: unknown }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
        <>
            <AssetRefField label="Logo URL" value={value} onChange={setValue} appId="app_1" definition={definition} />
            <output data-testid="value">{value ?? ''}</output>
        </>
    );
}

describe('AssetRefField', () => {
    it('picks an uploaded image (fonts are not offered for an image field)', async () => {
        stubServer();
        render(withQueryClient(<Harness />));
        await userEvent.click(screen.getByRole('button', { name: 'Choose an uploaded file' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByText(/used in 1 place/);
        expect(dialog.querySelector('[data-asset-id="a-font"]')).toBeNull();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Use' }));
        expect(screen.getByTestId('value').textContent).toBe('asset:a-logo');
        expect(screen.getByText('Uploaded file')).toBeTruthy();
    });

    it('an https URL is typed as before, and Remove clears an uploaded file', async () => {
        stubServer();
        render(withQueryClient(<Harness initial="asset:a-logo" />));
        await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(screen.getByTestId('value').textContent).toBe('');
        await userEvent.type(screen.getByRole('textbox', { name: 'Logo URL' }), 'https://example.com/l.png');
        expect(screen.getByTestId('value').textContent).toBe('https://example.com/l.png');
    });

    it('uploading posts the file and picks it', async () => {
        const calls = stubServer();
        render(withQueryClient(<Harness />));
        await userEvent.click(screen.getByRole('button', { name: 'Choose an uploaded file' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.upload(within(dialog).getByLabelText('Upload a file'), new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }));
        await vi.waitFor(() => expect(screen.getByTestId('value').textContent).toBe('asset:a-new'));
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/studio-apps/app_1/assets'))).toBe(true);
    });

    it('a delete says where the draft and the published app still use the file', async () => {
        const calls = stubServer();
        render(withQueryClient(<Harness definition={{ screens: [{ sections: [{ children: [{ props: { src: 'asset:a-logo' } }] }] }] }} />));
        await userEvent.click(screen.getByRole('button', { name: 'Choose an uploaded file' }));
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByText(/used in 2 place/);
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText(/Still used in 1 place\(s\) of this draft and 1 of the published app/)).toBeTruthy();
        const confirm = screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement;
        await userEvent.click(confirm);
        await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/assets/a-logo'))).toBe(true));
    });
});
