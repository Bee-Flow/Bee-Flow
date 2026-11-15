// The organisation's switch "images to AI in automations": off by default,
// switching on only after a confirm, switching off at once, a refused save
// said plainly, and a failed load never shown as the default.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import OrgAutomationImageAiEditor from './OrgAutomationImageAiEditor';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

let server: { enabled: boolean; configured: boolean };
let puts: unknown[];
let getStatus: number;
let putStatus: number;

beforeEach(() => {
    server = { enabled: false, configured: false };
    puts = [];
    getStatus = 200;
    putStatus = 200;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        if (!String(url).includes('/api/org-automation-image-ai/org1')) return json({ error: 'Not found' }, 404);
        if ((init.method || 'GET') === 'PUT') {
            const body = JSON.parse(String(init.body));
            puts.push(body);
            if (putStatus !== 200) return json({ error: 'Only an admin of this organisation can change this.', code: 'not_org_admin' }, putStatus);
            server = { ...body, configured: true };
            return json(server);
        }
        return getStatus === 200 ? json(server) : json({ error: 'The images-to-AI setting could not be read.' }, getStatus);
    });
});

const renderEditor = () => render(<OrgAutomationImageAiEditor orgId="org1" />, { wrapper: queryWrapper() });
const toggle = () => screen.findByRole('switch', { name: /show images to AI/ });

it('shows the default: off', async () => {
    renderEditor();
    expect(await toggle()).not.toBeChecked();
});

it('switching on asks first, and only then saves', async () => {
    renderEditor();
    await userEvent.click(await toggle());
    expect(puts).toEqual([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(puts).toEqual([{ enabled: true }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
});

it('switching off saves at once', async () => {
    server = { enabled: true, configured: true };
    renderEditor();
    const box = await toggle();
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
});

it('a refused save says only an admin can change it', async () => {
    putStatus = 403;
    renderEditor();
    await userEvent.click(await toggle());
    await userEvent.click(await screen.findByRole('button', { name: 'Switch on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an admin of this organisation can change this.');
});

it('a failed load is said, never shown as off', async () => {
    getStatus = 503;
    renderEditor();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this setting.');
    expect(screen.queryByRole('switch')).toBeNull();
});
