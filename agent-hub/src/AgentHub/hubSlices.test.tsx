import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithClient } from '../test/render';
import { authFetch } from '../utils/helpers';
import scopedStorage from '../utils/scopedStorage';
import useAgentCatalog from './useAgentCatalog';
import useAgentFavorites from './useAgentFavorites';
import useConversationLists from './useConversationLists';
import useHubKnowledgeBases from './useHubKnowledgeBases';
import useHubPrefs from './useHubPrefs';

vi.mock('../utils/helpers', async (importOriginal) => ({
    ...await importOriginal<typeof import('../utils/helpers')>(), authFetch: vi.fn(),
}));

type Route = (url: string, init?: RequestInit) => unknown;
/** Answer every authFetch from a route table: a status number refuses, anything else is the JSON body. */
function serve(routes: Record<string, unknown | Route>) {
    vi.mocked(authFetch).mockImplementation((async (url: string, init?: RequestInit) => {
        const hit = Object.keys(routes).find(k => String(url).includes(k));
        const answer = hit === undefined ? [] : routes[hit];
        const body = typeof answer === 'function' ? (answer as Route)(String(url), init) : answer;
        const refused = typeof body === 'number';
        return {
            ok: !refused, status: refused ? body : 200, headers: { get: () => 'application/json' },
            json: async () => (refused ? { error: 'no' } : body), text: async () => JSON.stringify(body),
        };
    }) as never);
}
const urls = () => vi.mocked(authFetch).mock.calls.map(([u]) => String(u));

beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    scopedStorage.setCurrentUser('u1');
    scopedStorage.removeItem('agentFavorites');
    scopedStorage.removeItem('chatHistoryMode');
    scopedStorage.removeItem('activeSkillIds');
});

describe('useAgentFavorites', () => {
    it('reads the favourites of the user and lets a handler edit them', async () => {
        serve({ '/agents/favorites': ['a1', 'a2'] });
        const { result } = renderHookWithClient(() => useAgentFavorites('u1'));
        await waitFor(() => expect(result.current.favorites).toEqual(['a1', 'a2']));
        act(() => result.current.setFavorites(prev => prev.filter(id => id !== 'a1')));
        await waitFor(() => expect(result.current.favorites).toEqual(['a2']));
    });

    it('migrates the legacy local list once, when the server has none', async () => {
        scopedStorage.setJSON('agentFavorites', ['old1']);
        serve({
            '/agents/favorites/bulk': ['old1'],
            '/agents/favorites': [],
        });
        const { result } = renderHookWithClient(() => useAgentFavorites('u1'));
        await waitFor(() => expect(result.current.favorites).toEqual(['old1']));
        expect(urls().some(u => u.includes('/agents/favorites/bulk'))).toBe(true);
        await waitFor(() => expect(scopedStorage.getJSON('agentFavorites', null)).toBeNull());
    });

    it('does not ask without a user', () => {
        serve({});
        renderHookWithClient(() => useAgentFavorites(undefined));
        expect(authFetch).not.toHaveBeenCalled();
    });
});

describe('useAgentCatalog', () => {
    it('merges the published and the own agents; the published record wins', async () => {
        serve({
            '/agents/published': [{ id: 'a1', name: 'published' }],
            '/agents/categories': [{ id: 'c1', name: 'Sales', description: '', emoji: 'x' }],
            '/agents?': [{ id: 'a1', name: 'own' }, { id: 'a2', name: 'draft' }],
        });
        const { result } = renderHookWithClient(() => useAgentCatalog());
        await waitFor(() => expect(result.current.agents).toHaveLength(2));
        expect(result.current.agents.find(a => a.id === 'a1')?.name).toBe('published');
        expect(result.current.agentCategories).toEqual([{ id: 'c1', name: 'Sales', description: '', emoji: 'x' }]);
    });

    it('refreshAgents resolves with the merged list, and null when nothing could be read', async () => {
        serve({ '/agents/published': [{ id: 'a1' }], '/agents?': [] });
        const { result } = renderHookWithClient(() => useAgentCatalog());
        await waitFor(() => expect(result.current.agents).toHaveLength(1));
        let list: unknown;
        await act(async () => { list = await result.current.refreshAgents(); });
        expect(list).toEqual([{ id: 'a1' }]);

        serve({ '/agents': 500 });
        const failing = renderHookWithClient(() => useAgentCatalog());
        let none: unknown = 'unset';
        await act(async () => { none = await failing.result.current.refreshAgents(); });
        expect(none).toBeNull();
    });
});

describe('useHubKnowledgeBases', () => {
    it('stays silent (null) until the list is known, and reads only in direct chat', async () => {
        serve({ '/api/kb': [{ id: 'k1', name: 'Handbook', usage_contexts: ['direct_chat'] }] });
        const { result, rerender } = renderHookWithClient(({ direct }: { direct: boolean }) => useHubKnowledgeBases(direct), { initialProps: { direct: false } });
        expect(result.current.directChatKbs).toBeNull();
        expect(authFetch).not.toHaveBeenCalled();
        rerender({ direct: true });
        await waitFor(() => expect(result.current.directChatKbs).toEqual([{ id: 'k1', name: 'Handbook', usage_contexts: ['direct_chat'] }]));
    });

    it('a refused read never turns into "no knowledge bases"', async () => {
        serve({ '/api/kb': 500 });
        const { result } = renderHookWithClient(() => useHubKnowledgeBases(true));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(result.current.directChatKbs).toBeNull();
    });
});

describe('useConversationLists', () => {
    const ARGS = { selectedAgentId: 'a1', directChatMode: false, chatHistoryMode: 'per-agent' };

    it("reads the selected agent's conversations newest first, and edits them in place", async () => {
        serve({ '/agents/a1/conversations': [
            { id: 'c1', title: 'old', updated_at: '2026-01-01T00:00:00Z' },
            { id: 'c2', title: 'new', updated_at: '2026-02-01T00:00:00Z' },
        ] });
        const { result } = renderHookWithClient(() => useConversationLists(ARGS));
        await waitFor(() => expect(result.current.conversations.map(c => c.id)).toEqual(['c2', 'c1']));
        act(() => result.current.setConversations(prev => prev.filter(c => c.id !== 'c2')));
        await waitFor(() => expect(result.current.conversations.map(c => c.id)).toEqual(['c1']));
    });

    it('reads the direct list and the tiers only in direct chat, the timeline only in all-chats', async () => {
        serve({
            '/ai/direct/conversations': [{ id: 'd1' }],
            '/ai/config/tiers-for-user': { auto: {} },
            '/ai/labels': [],
            '/agents/conversations/all': [{ id: 'x', updated_at: '2026-01-01T00:00:00Z' }],
        });
        const { result, rerender } = renderHookWithClient(
            (p: typeof ARGS) => useConversationLists(p),
            { initialProps: { selectedAgentId: undefined as unknown as string, directChatMode: false, chatHistoryMode: 'per-agent' } },
        );
        await waitFor(() => expect(urls().some(u => u.includes('/ai/labels'))).toBe(true));
        expect(urls().some(u => u.includes('/ai/direct/conversations'))).toBe(false);
        expect(result.current.conversations).toEqual([]);

        rerender({ selectedAgentId: undefined as unknown as string, directChatMode: true, chatHistoryMode: 'all-chats' });
        await waitFor(() => expect(result.current.directConversations).toEqual([{ id: 'd1' }]));
        await waitFor(() => expect(result.current.modelTiers).toEqual({ auto: {} }));
        await waitFor(() => expect(result.current.allAgentConversations.map(c => c._source)).toEqual(['agent', 'direct']));
    });

    it('a re-read that is refused keeps the list on screen', async () => {
        serve({ '/ai/direct/conversations': [{ id: 'd1' }] });
        const { result } = renderHookWithClient(() => useConversationLists({ ...ARGS, selectedAgentId: undefined as unknown as string, directChatMode: true }));
        await waitFor(() => expect(result.current.directConversations).toHaveLength(1));
        serve({ '/ai/direct/conversations': 500 });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await act(async () => { await result.current.loadDirectConversations(); });
        expect(result.current.directConversations).toEqual([{ id: 'd1' }]);
        error.mockRestore();
    });
});

describe('useHubPrefs', () => {
    it('hydrates the stored preferences on the first frame and caps the skills at five', () => {
        scopedStorage.setItem('chatHistoryMode', 'all-chats');
        scopedStorage.setJSON('activeSkillIds', ['s1']);
        const { result } = renderHookWithClient(() => useHubPrefs('u1'));
        expect(result.current.chatHistoryMode).toBe('all-chats');
        expect(result.current.activeSkillIds).toEqual(['s1']);
        act(() => { for (const id of ['s2', 's3', 's4', 's5', 's6']) result.current.handleToggleSkill(id); });
        expect(result.current.activeSkillIds).toHaveLength(5);
        expect(scopedStorage.getJSON('activeSkillIds', null)).toEqual(result.current.activeSkillIds);
    });
});
