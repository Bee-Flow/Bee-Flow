import { beforeEach, describe, expect, it, vi } from 'vitest';
import useConversationMeta from './useConversationMeta';
import { toast } from '../components/shared/Toast';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/helpers')>();
    return { ...actual, API_BASE: '', authFetch: vi.fn() };
});
vi.mock('../components/shared/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

/**
 * Filing a chat under a project from its sidebar menu.
 *
 * The conversation's own shape decides whether it is a direct or an agent
 * chat: in the all-chats view an agent conversation is listed while the hub
 * is in direct mode, and the mode used to decide — filing the wrong table's
 * row, which the server then could not find.
 */

const t = (key: string, fallback?: string) => fallback ?? key;

function meta(directChatMode: boolean) {
    const deps = {
        t,
        directChatMode,
        selectedAgent: directChatMode ? null : { id: 'agent-1' },
        loadDirectConversations: vi.fn(),
        loadConversations: vi.fn(),
        setDirectConversations: vi.fn(),
        setConversations: vi.fn(),
        setConversationLabels: vi.fn(),
        confirm: vi.fn(),
    };
    return { deps, ...useConversationMeta(deps) };
}

const res = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(toast.error).mockClear();
});

describe('handleMoveToProject', () => {
    it('files an agent conversation as an agent chat, even while the hub is in direct mode', async () => {
        vi.mocked(authFetch).mockResolvedValue(res(200) as never);
        const { handleMoveToProject, deps } = meta(true);
        await handleMoveToProject({ id: 'c1', agent_id: 'agent-1' }, { id: 'p1' });
        const [url, init] = vi.mocked(authFetch).mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/projects/p1/conversations');
        expect(JSON.parse(String(init.body))).toEqual({ assign: [{ id: 'c1', type: 'agent' }] });
        expect(deps.loadDirectConversations).toHaveBeenCalled();
    });

    it('files a direct conversation as a direct chat, even while an agent is open', async () => {
        vi.mocked(authFetch).mockResolvedValue(res(200) as never);
        const { handleMoveToProject, deps } = meta(false);
        await handleMoveToProject({ id: 'c2' }, { id: 'p1' });
        const [, init] = vi.mocked(authFetch).mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ assign: [{ id: 'c2', type: 'direct' }] });
        expect(deps.loadConversations).toHaveBeenCalledWith('agent-1');
    });

    it('takes a conversation out of the project it is filed under', async () => {
        vi.mocked(authFetch).mockResolvedValue(res(200) as never);
        const { handleMoveToProject } = meta(true);
        await handleMoveToProject({ id: 'c3', project_id: 'p9' }, null);
        const [url, init] = vi.mocked(authFetch).mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/projects/p9/conversations');
        expect(JSON.parse(String(init.body))).toEqual({ unassign: [{ id: 'c3', type: 'direct' }] });
    });

    it('does nothing for a conversation that is in no project and is not being moved into one', async () => {
        const { handleMoveToProject } = meta(true);
        await handleMoveToProject({ id: 'c4' }, null);
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('says so when the server refuses, and does not refresh as if it worked', async () => {
        vi.mocked(authFetch).mockResolvedValue(res(409, { error: 'A Solution holds no chats.' }) as never);
        const { handleMoveToProject, deps } = meta(true);
        await handleMoveToProject({ id: 'c5' }, { id: 'sol-1' });
        expect(toast.error).toHaveBeenCalledWith('A Solution holds no chats.');
        expect(deps.loadDirectConversations).not.toHaveBeenCalled();
    });

    it('says so when the request fails outright', async () => {
        vi.mocked(authFetch).mockRejectedValue(new Error('offline') as never);
        const { handleMoveToProject } = meta(true);
        await handleMoveToProject({ id: 'c6' }, { id: 'p1' });
        expect(toast.error).toHaveBeenCalledWith('Could not move this chat. It is still where it was.');
    });
});
