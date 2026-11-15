/**
 * A prompt translation's save reports through SaveStatus: "Saved" after the
 * server stored it, the retry state after it refused. The save also writes the
 * text into the cached read, which must not wipe the status it just set.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import PromptEditor from './PromptEditor';
import { renderWithClient } from '@/test/render';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PROMPTS = {
    promptIds: ['welcome', 'summary'],
    categories: { chat: ['welcome', 'summary'] },
    labels: { welcome: 'Welcome', summary: 'Summary' },
    defaults: { welcome: 'Hello', summary: 'Summarise' },
    translations: {},
    stats: { translated: 0, total: 2, missing: 2 },
};

let putStatus = 200;
let fetchSpy: MockInstance<typeof fetch>;
const puts = () => fetchSpy.mock.calls.filter(([url, init]) => String(url).includes('/api/languages/nl/prompts/') && (init as RequestInit | undefined)?.method === 'PUT');

beforeEach(() => {
    putStatus = 200;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).endsWith('/api/languages/nl/prompts')) return json(PROMPTS);
        if ((init as RequestInit | undefined)?.method === 'PUT') return json({}, putStatus);
        return json({});
    });
});
afterEach(() => { cleanup(); fetchSpy.mockRestore(); });

describe('PromptEditor', () => {
    it('says Saved once the translation is stored', async () => {
        const user = userEvent.setup();
        renderWithClient(<PromptEditor locale="nl" />);
        await user.type(await screen.findByPlaceholderText('Enter translation...'), 'Hallo');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(String(puts()[0][0])).toContain('/api/languages/nl/prompts/welcome');
        expect(await screen.findByText(/Saved/)).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Enter translation...')).toHaveValue('Hallo');
    });

    it('offers a retry when the server refuses the save, and starts over on another prompt', async () => {
        putStatus = 500;
        const user = userEvent.setup();
        renderWithClient(<PromptEditor locale="nl" />);
        await user.type(await screen.findByPlaceholderText('Enter translation...'), 'Hallo');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /Summary/ }));
        expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
        expect(screen.getByPlaceholderText('Enter translation...')).toHaveValue('');
    });
});
