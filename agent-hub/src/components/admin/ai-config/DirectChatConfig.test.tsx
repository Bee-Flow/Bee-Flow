import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DirectChatConfig from './DirectChatConfig';
import { testQueryClient, withQueryClient } from '@/test/queryWrapper';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
let tierTools: Record<string, string[]> = {};
// What the server holds: a POST to the prompt route stores it, a GET returns it.
let storedPrompt = 'Be brief.';

beforeEach(() => {
    tierTools = {};
    storedPrompt = 'Be brief.';
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST') {
            if (u.endsWith('/ai/config/direct-chat')) storedPrompt = JSON.parse(String(init.body)).systemPrompt;
            return json({ success: true });
        }
        if (u.endsWith('/ai/config/direct-chat')) return json({ systemPrompt: storedPrompt });
        if (u.endsWith('/ai/config/direct-chat-tools')) return json(tierTools);
        if (u.endsWith('/ai/config/direct-chat-tool-params')) return json({ thinking: { send_mail: { to: 'x', from: 'y' } } });
        return json({ maxToolRoundsChat: null, toolRoundDefaults: { directChat: 15, notebookChat: 15, webpageChat: 20, nativeLoop: 20 } });
    });
    vi.stubGlobal('fetch', fetchMock);
});

const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => [String(url).replace(/^.*\/ai\//, ''), JSON.parse(String((init as RequestInit).body))]);

describe('DirectChatConfig', () => {
    // The page showed 5/5/10/10 of its own while the loops ran on 15/15/20/20.
    it('shows the per-surface round defaults the server reports', async () => {
        render(withQueryClient(<DirectChatConfig />));
        expect(await screen.findByText('Webpage chat')).toBeTruthy();
        expect(screen.getAllByText('15 rounds')).toHaveLength(2);
        expect(screen.getAllByText('20 rounds')).toHaveLength(2);
    });

    it('saves the prompt and the round cap with one Save, each to its own route, and only what changed', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<DirectChatConfig />));
        const rounds = await screen.findByLabelText('Tool calls per chat turn');
        await user.type(rounds, '8');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(posts()).toEqual([['config', { maxToolRoundsChat: 8 }]]));

        await user.type(screen.getByLabelText('System Prompt'), ' Cite sources.');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(posts()).toContainEqual(['config/direct-chat', { systemPrompt: 'Be brief. Cite sources.' }]));
    });

    // After a save the draft is dropped; the field must then show what was
    // stored, not the prompt the page read when it opened.
    it('keeps showing the saved prompt after Save', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<DirectChatConfig />));
        const prompt = await screen.findByLabelText('System Prompt');
        await user.type(prompt, ' Cite sources.');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(posts()).toContainEqual(['config/direct-chat', { systemPrompt: 'Be brief. Cite sources.' }]));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
        expect((screen.getByLabelText('System Prompt') as HTMLTextAreaElement).value).toBe('Be brief. Cite sources.');
    });

    // Wave 3 saw the field fall back to "Be brief." after a save: the page read
    // the prompt again (or opened again) and got the answer cached before the save.
    const saveCiteSources = async (client = testQueryClient()) => {
        const user = userEvent.setup();
        const view = render(withQueryClient(<DirectChatConfig />, client));
        await user.type(await screen.findByLabelText('System Prompt'), ' Cite sources.');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
        return { client, ...view };
    };
    const shownPrompt = () => (screen.getByLabelText('System Prompt') as HTMLTextAreaElement).value;

    it('keeps the saved prompt when the page reads it again', async () => {
        const { client } = await saveCiteSources();
        await client.refetchQueries();
        expect(shownPrompt()).toBe('Be brief. Cite sources.');
    });

    it('shows the saved prompt at once when the page opens again', async () => {
        const { client, unmount } = await saveCiteSources();
        unmount();
        render(withQueryClient(<DirectChatConfig />, client));
        expect(shownPrompt()).toBe('Be brief. Cite sources.');
    });

    // A POST that never reaches the server (offline, a dropped connection) left
    // the footer on "Saving…" for good: the rejection escaped handleSave.
    it('leaves the saving state and keeps the draft when the request does not reach the server', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<DirectChatConfig />));
        await user.type(await screen.findByLabelText('System Prompt'), ' Cite sources.');
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'POST') throw new TypeError('Failed to fetch');
            return json({ systemPrompt: storedPrompt });
        });
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-busy', 'true'));
        expect(screen.queryByText('Saving…')).toBeNull();
        expect((screen.getByLabelText('System Prompt') as HTMLTextAreaElement).value).toBe('Be brief. Cite sources.');
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    it('lists the stored tool list of a tier, the pinned parameters, and says when a tier has none', async () => {
        tierTools = { fast: ['web_search'], writer: [] };
        render(withQueryClient(<DirectChatConfig />));
        const matrix = (await screen.findByRole('heading', { name: 'Tools per tier' })).closest('section') as HTMLElement;
        expect(await within(matrix).findByText('web_search')).toBeTruthy();
        expect(within(matrix).getByText('No tools')).toBeTruthy();
        expect(within(matrix).getAllByText('Default tools').length).toBeGreaterThan(0);
        expect(within(matrix).getByText('2 pinned tool parameters')).toBeTruthy();
    });

    it('puts every tier back on the default tools after a confirm', async () => {
        tierTools = { fast: ['web_search'] };
        const user = userEvent.setup();
        render(withQueryClient(<DirectChatConfig />));
        await user.click(await screen.findByRole('button', { name: 'Use default tools' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Use default tools' }));
        await waitFor(() => expect(posts()).toEqual([['config/direct-chat-tools', {}]]));
    });
});
