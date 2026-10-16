/**
 * The Redirects inspector: lists what the server holds, adds a redirect, shows
 * the server's reason when it refuses one, removes one. The network is a
 * stubbed fetch (no module mock); the data layer is a real query client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RedirectsInspector from './RedirectsInspector';
import { withQueryClient } from '../../../../test/queryWrapper';

interface Call { url: string; method: string; body: unknown }

function stubServer(initial: unknown[], refuse?: string) {
    const calls: Call[] = [];
    let redirects = initial;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        calls.push({ url: String(input), method, body });
        if (method === 'POST') {
            if (refuse) return json(400, { error: refuse });
            redirects = [...redirects, { id: 'rd_new', from: '/old', to: '/new', status: 301, external: false, auto: false }];
            return json(200, { success: true });
        }
        if (method === 'DELETE') { redirects = []; return json(200, { success: true }); }
        return json(200, { redirects, allowedHosts: ['partner.example'] });
    }));
    return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

const row = { id: 'rd_1', from: '/renamed', to: '/page', status: 301, external: false, auto: true };

describe('RedirectsInspector', () => {
    it('lists redirects with the automatic ones marked, and the allowed hosts', async () => {
        stubServer([row]);
        render(withQueryClient(<RedirectsInspector siteId="pj_1" />));
        expect(await screen.findByText('/renamed → /page')).toBeTruthy();
        expect(screen.getByText('Automatic')).toBeTruthy();
        expect((screen.getByLabelText('Allowed websites') as HTMLTextAreaElement).value).toBe('partner.example');
    });

    it('adds a redirect and tells the panel a publish is due', async () => {
        const calls = stubServer([]);
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(withQueryClient(<RedirectsInspector siteId="pj_1" onSaved={onSaved} />));
        await user.type(await screen.findByLabelText('Old address'), '/old');
        await user.type(screen.getByLabelText('New address'), '/new');
        await user.click(screen.getByRole('button', { name: 'Add redirect' }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const post = calls.find(c => c.method === 'POST');
        expect(post?.url).toContain('/api/cms/sites/pj_1/redirects');
        expect(post?.body).toEqual({ from: '/old', to: '/new', status: 301, external: false });
    });

    it('shows the reason when the server refuses a redirect', async () => {
        stubServer([], 'That would create a redirect loop.');
        const user = userEvent.setup();
        render(withQueryClient(<RedirectsInspector siteId="pj_1" />));
        await user.type(await screen.findByLabelText('Old address'), '/a-b');
        await user.type(screen.getByLabelText('New address'), '/c-d');
        await user.click(screen.getByRole('button', { name: 'Add redirect' }));
        expect((await screen.findByRole('alert')).textContent).toContain('redirect loop');
    });

    it('removes a redirect', async () => {
        const calls = stubServer([row]);
        const user = userEvent.setup();
        render(withQueryClient(<RedirectsInspector siteId="pj_1" />));
        await user.click(await screen.findByRole('button', { name: 'Remove the redirect from /renamed' }));
        await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/redirects/rd_1'))).toBe(true));
    });
});
