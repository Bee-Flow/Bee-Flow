/**
 * The knowledge-base pill, wired the way it actually runs.
 *
 * The composer's own tests can only pin what it does with the list it is
 * handed. This one pins the hand-off itself, because that is where the honest
 * version is easiest to lose: the hub holds `[]` for a KB list it never
 * fetched AND for one whose fetch came back 500, and passing that array down
 * as though it were an answer is exactly how a chat grounded on someone's
 * personnel handbook ends up under a confident "no knowledge bases".
 *
 * Three runs over one screen:
 *   /api/kb answers  → the pill names what the conversation is grounded on,
 *                      read back from the detail GET;
 *   switch chats     → it follows the new conversation's answer instead of
 *                      keeping the previous chat's, which is a different
 *                      read-back site with the same one line in it;
 *   /api/kb fails    → no pill at all, though the conversation still carries
 *                      the same attached id.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import AgentHub from './AgentHub';
import { withQueryClient } from './test/queryWrapper';
import { authFetch } from './utils/helpers';

vi.mock('./utils/helpers', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, authFetch: vi.fn() };
});
vi.mock('./components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, hasTier: () => true, tier: 'full' }),
    RequireTier: ({ children }) => children,
}));

const USER = { id: 'u1', username: 'tom', permissions: ['all'], isAdmin: true };
const CONV = { id: 'conv-1', title: 'Onboarding', updated_at: '2026-01-02T00:00:00Z' };
const CONV_2 = { id: 'conv-2', title: 'Expenses', updated_at: '2026-01-01T00:00:00Z' };
const HANDBOOK = { id: 'kb1', name: 'Handbook', document_count: 4, usage_contexts: ['direct_chat'] };

const res = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => '',
});

/** Whether GET /api/kb answers at all in this run. */
let kbListAnswers = true;

const routes = (url) => {
    const u = String(url);
    if (u.includes('/api/kb')) {
        return Promise.resolve(kbListAnswers ? res([HANDBOOK]) : res({ error: 'boom' }, 500));
    }
    if (u.includes('/ai/direct/conversations/conv-1/workspace')) return Promise.resolve(res({ content: '', notebookId: null }));
    if (u.includes('/ai/direct/conversations/conv-2/workspace')) return Promise.resolve(res({ content: '', notebookId: null }));
    if (u.includes('/ai/direct/conversations/conv-1')) {
        return Promise.resolve(res({ ...CONV, messages: [], model_tier: 'auto', knowledgeBaseIds: ['kb1'] }));
    }
    if (u.includes('/ai/direct/conversations/conv-2')) {
        // Grounded on nothing — and the server SAYS so, which is why the pill
        // may go quiet here rather than keep the previous chat's answer.
        return Promise.resolve(res({ ...CONV_2, messages: [], model_tier: 'auto', knowledgeBaseIds: [] }));
    }
    if (u.includes('/ai/direct/conversations')) return Promise.resolve(res([CONV, CONV_2]));
    return Promise.resolve(res([]));
};

beforeEach(() => {
    kbListAnswers = true;
    window.history.replaceState({}, '', '/');
    authFetch.mockReset();
    authFetch.mockImplementation(routes);
});

afterEach(() => { vi.restoreAllMocks(); });

// AgentHub reaches the data layer (the skill chips read through api/queries),
// so it needs a QueryClient the way it has one in the app.
const mount = () => render(withQueryClient(
    <AgentHub user={USER} currentPage="agents" onNavigate={vi.fn()} initialDirectConvId="conv-1" />,
));

describe('AgentHub — the knowledge bases a direct chat is grounded on', () => {
    it('names what the server says this conversation carries', async () => {
        mount();
        // The id comes from the detail GET — the authorised list, re-checked on
        // that read — and the NAME from /api/kb. Neither is guessed.
        const pill = await screen.findByTestId('composer-pill-kb', {}, { timeout: 4000 });
        await waitFor(() => expect(pill).toHaveTextContent('Handbook'));
    });

    it('follows the conversation, instead of keeping the last one\'s answer', async () => {
        mount();
        await waitFor(() => expect(screen.getByTestId('composer-pill-kb')).toHaveTextContent('Handbook'), { timeout: 4000 });

        await userEvent.click(await screen.findByText('Expenses'));

        // The second chat carries nothing. Leaving "Handbook" up would claim a
        // source for an answer that will not use it.
        await waitFor(() => expect(screen.getByTestId('composer-pill-kb')).toHaveTextContent('Knowledge'));
        expect(screen.getByTestId('composer-pill-kb')).not.toHaveTextContent('Handbook');
    });

    it('says nothing at all when the KB list could not be fetched', async () => {
        kbListAnswers = false;
        mount();
        // Same conversation, same attached id, no list to substantiate it: the
        // pill is absent rather than empty. An empty one would report "not
        // grounded on anything" about a chat that is.
        await waitFor(() => expect(
            authFetch.mock.calls.some(([u]) => String(u).includes('/ai/direct/conversations/conv-1')),
        ).toBe(true), { timeout: 4000 });
        await screen.findByTestId('composer-tools-button', {}, { timeout: 4000 });
        expect(screen.queryByTestId('composer-pill-kb')).not.toBeInTheDocument();
    });
});
