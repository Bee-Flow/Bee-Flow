import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useProjectChatStart, { decideOutcome, type ChatViewState, type ProjectChatStartDeps } from './useProjectChatStart';
import { toast } from '../components/shared/Toast';
import EN_DEFAULTS from '../i18n/en-defaults';
import { queryWrapper } from '../test/queryWrapper';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/helpers')>();
    return { ...actual, authFetch: vi.fn() };
});
vi.mock('../components/shared/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

const PROJECT = { id: 'p1', name: 'Onboarding' };
const AGENT = { id: 'agent-1' };
const t = ((key: string, fallback?: unknown, params?: Record<string, unknown>) => {
    const text = typeof fallback === 'string' ? fallback : key;
    return text.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));
}) as ProjectChatStartDeps<{ id: string }>['t'];

const EMPTY_VIEW: ChatViewState = {
    activeProjectId: null,
    isLoading: false,
    directChatMode: false,
    selectedAgentId: null,
    directConversationId: null,
    agentConversationId: null,
    messages: [],
};

const ok = (body: unknown) => Promise.resolve({
    ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body),
});

type Props = ProjectChatStartDeps<{ id: string }>;

function setup(overrides: Partial<Props> = {}) {
    const fns = {
        setActiveProject: vi.fn(),
        leaveProjectsPage: vi.fn(),
        openDirectChat: vi.fn(),
        openAgentChat: vi.fn(),
        sendMessage: vi.fn(),
        setChatInput: vi.fn(),
    };
    const initial: Props = { t, agents: [AGENT], ...fns, ...EMPTY_VIEW, openTimeoutMs: 60, ...overrides };
    const hook = renderHook((props: Props) => useProjectChatStart(props), {
        initialProps: initial,
        wrapper: queryWrapper(),
    });
    const view = (next: Partial<ChatViewState>) => hook.rerender({ ...initial, ...next });
    return { hook, fns, view };
}

const threadPosts = () => vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).includes('/threads'));

beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => ok({ shared: true }) as never);
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
});
afterEach(() => { vi.useRealTimers(); });

const USER_MSG = { role: 'user', content: 'Plan the kickoff' };
const REPLY = { role: 'assistant', content: 'Here is a plan' };

describe('starting a direct chat in a project', () => {
    it('makes the project the context, opens a new chat and sends once it is on screen', () => {
        const { hook, fns, view } = setup();
        let started = false;
        act(() => { started = hook.result.current.startChat({ project: PROJECT, message: '  Plan the kickoff ', share: false }); });
        expect(started).toBe(true);
        expect(fns.setActiveProject).toHaveBeenCalledWith(PROJECT);
        expect(fns.leaveProjectsPage).toHaveBeenCalledTimes(1);
        expect(fns.openDirectChat).toHaveBeenCalledTimes(1);
        // Not yet: the chat view has not rendered the new chat.
        expect(fns.sendMessage).not.toHaveBeenCalled();

        view({ activeProjectId: 'p1', directChatMode: true });
        expect(fns.sendMessage).toHaveBeenCalledWith('Plan the kickoff');

        // Re-renders while the turn runs send nothing more.
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, messages: [USER_MSG] });
        view({ activeProjectId: 'p1', directChatMode: true, directConversationId: 'c1', messages: [USER_MSG, REPLY] });
        expect(fns.sendMessage).toHaveBeenCalledTimes(1);
        expect(threadPosts()).toHaveLength(0);
    });

    it('waits for a chat that is still busy before sending', () => {
        const { hook, fns, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff' }); });
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true });
        expect(fns.sendMessage).not.toHaveBeenCalled();
        view({ activeProjectId: 'p1', directChatMode: true });
        expect(fns.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('shares the new conversation into the project once the first turn has finished', async () => {
        const { hook, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        // The conversation exists while the turn is still running: not yet.
        const created = { type: 'direct' as const, id: 'c1' };
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, directConversationId: 'c1', messages: [USER_MSG], turnConversation: created });
        expect(threadPosts()).toHaveLength(0);

        view({ activeProjectId: 'p1', directChatMode: true, directConversationId: 'c1', messages: [USER_MSG, REPLY], turnConversation: created });
        await waitFor(() => expect(threadPosts()).toHaveLength(1));
        const [url, init] = threadPosts()[0] as [string, RequestInit];
        expect(url).toContain('/api/projects/p1/threads');
        expect(JSON.parse(String(init.body))).toEqual({ conversationId: 'c1', type: 'direct' });
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Chat shared with the members of Onboarding.'));
    });

    it('tells the person when the share was refused, without claiming it worked', async () => {
        vi.mocked(authFetch).mockImplementation(() => Promise.resolve({
            ok: false, status: 503, headers: { get: () => 'application/json' },
            json: async () => ({ error: 'key unavailable' }), text: async () => '',
        }) as never);
        const { hook, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        view({
            activeProjectId: 'p1', directChatMode: true, directConversationId: 'c1', messages: [USER_MSG, REPLY],
            turnConversation: { type: 'direct', id: 'c1' },
        });
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
            'The chat was saved in the project, but it could not be shared with its members.',
        ));
        expect(toast.success).not.toHaveBeenCalled();
    });
});

describe('what is never shared', () => {
    it('does not share a conversation the person switched to before the turn finished', async () => {
        const { hook, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, messages: [USER_MSG] });
        // Another, older conversation is now on screen.
        view({
            activeProjectId: 'p1', directChatMode: true, directConversationId: 'old-chat',
            messages: [{ role: 'user', content: 'Something private' }, REPLY],
        });
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        expect(threadPosts()).toHaveLength(0);
    });

    it('does not share an agent conversation when a different agent is on screen', async () => {
        const { hook, view } = setup({ agents: [AGENT, { id: 'agent-2' }] });
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', agentId: 'agent-1', share: true }); });
        view({ activeProjectId: 'p1', selectedAgentId: 'agent-1' });
        view({ activeProjectId: 'p1', selectedAgentId: 'agent-1', isLoading: true, messages: [USER_MSG] });
        view({ activeProjectId: 'p1', selectedAgentId: 'agent-2', agentConversationId: 'c9', messages: [USER_MSG, REPLY] });
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        expect(threadPosts()).toHaveLength(0);
    });

    it('does not share an older chat with the same first message, opened while the answer was finishing', async () => {
        const { hook, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        // The engine reports the conversation this turn created ...
        const created = { type: 'direct' as const, id: 'new-chat' };
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, directConversationId: 'new-chat', messages: [USER_MSG], turnConversation: created });
        // ... and while the socket is still open (the title is slow), the
        // person opens an older, private chat that starts with the same words.
        const older = { activeProjectId: 'p1', directChatMode: true, directConversationId: 'older-private', messages: [USER_MSG, REPLY], turnConversation: created };
        view({ ...older, isLoading: true });
        view(older);
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        expect(threadPosts()).toHaveLength(0);
    });

    it('shares nothing when the engine never named a conversation for the turn', async () => {
        const { hook, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, messages: [USER_MSG] });
        // A turn that creates no conversation (the web page panel's chat); an
        // older chat with the same first message is on screen when it ends.
        view({ activeProjectId: 'p1', directChatMode: true, directConversationId: 'older-private', messages: [USER_MSG, REPLY] });
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        expect(threadPosts()).toHaveLength(0);
    });

    it('ignores a report that was already there before the turn was sent', async () => {
        const stale = { type: 'direct' as const, id: 'older-private' };
        const { hook, view } = setup({ turnConversation: stale });
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true, turnConversation: stale });
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, messages: [USER_MSG], turnConversation: stale });
        view({ activeProjectId: 'p1', directChatMode: true, directConversationId: 'older-private', messages: [USER_MSG, REPLY], turnConversation: stale });
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        expect(threadPosts()).toHaveLength(0);
    });

    it('shares nothing when the turn failed before a conversation existed', async () => {
        const { hook, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        view({ activeProjectId: 'p1', directChatMode: true, messages: [USER_MSG, { role: 'assistant', content: 'Error generating response.' }] });
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        expect(threadPosts()).toHaveLength(0);
    });
});

describe('the words the person reads', () => {
    // The shipped catalogue, not the code's fallback: t() prefers the
    // catalogue, so the fallback sentence is never what anyone sees.
    const shipped = ((key: string, fallback?: unknown) => {
        const text = (EN_DEFAULTS as Record<string, string>)[key];
        return typeof text === 'string' ? text : String(fallback ?? key);
    }) as Props['t'];

    it('says a chat that started but was not shared was not shared, not that it did not start', async () => {
        const { hook, view } = setup({ t: shipped });
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', share: true }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, messages: [USER_MSG] });
        // The person moved to another chat before the turn finished.
        view({ activeProjectId: 'p1', selectedAgentId: 'agent-1', agentConversationId: 'x', messages: [USER_MSG, REPLY] });
        await waitFor(() => expect(toast.info).toHaveBeenCalled());
        const notice = String(vi.mocked(toast.info).mock.calls[0][0]);
        expect(notice).toMatch(/not shared/i);
        expect(notice).toMatch(/share it from its menu/i);
        expect(notice).not.toMatch(/did not start/i);
    });
});

describe('starting an agent chat in a project', () => {
    it('opens the agent and shares its new conversation as an agent thread', async () => {
        const { hook, fns, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff', agentId: 'agent-1', share: true }); });
        expect(fns.openAgentChat).toHaveBeenCalledWith(AGENT);
        expect(fns.openDirectChat).not.toHaveBeenCalled();
        view({ activeProjectId: 'p1', selectedAgentId: 'agent-1' });
        expect(fns.sendMessage).toHaveBeenCalledWith('Plan the kickoff');
        view({ activeProjectId: 'p1', selectedAgentId: 'agent-1', isLoading: true, messages: [USER_MSG] });
        view({
            activeProjectId: 'p1', selectedAgentId: 'agent-1', agentConversationId: 'a-conv', messages: [USER_MSG, REPLY],
            turnConversation: { type: 'agent', id: 'a-conv' },
        });
        await waitFor(() => expect(threadPosts()).toHaveLength(1));
        const [, init] = threadPosts()[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ conversationId: 'a-conv', type: 'agent' });
    });

    it('refuses an agent the person cannot use, before anything moves', () => {
        const { hook, fns } = setup();
        let started = true;
        act(() => { started = hook.result.current.startChat({ project: PROJECT, message: 'Hi', agentId: 'someone-elses-agent' }); });
        expect(started).toBe(false);
        expect(toast.error).toHaveBeenCalledWith('That agent is not available to you, so the chat was not started.');
        expect(fns.setActiveProject).not.toHaveBeenCalled();
        expect(fns.leaveProjectsPage).not.toHaveBeenCalled();
        expect(fns.openAgentChat).not.toHaveBeenCalled();
    });
});

describe('a message is never lost', () => {
    it('ignores an empty message or a missing project', () => {
        const { hook, fns } = setup();
        act(() => {
            expect(hook.result.current.startChat({ project: PROJECT, message: '   ' })).toBe(false);
            expect(hook.result.current.startChat({ project: { id: '', name: '' }, message: 'Hi' })).toBe(false);
        });
        expect(fns.setActiveProject).not.toHaveBeenCalled();
    });

    it('puts the message back in the composer when the chat never opens', async () => {
        const { hook, fns } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff' }); });
        await waitFor(() => expect(fns.setChatInput).toHaveBeenCalledWith('Plan the kickoff'));
        expect(fns.sendMessage).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith('The chat could not be started. Your message is back in the composer.');
    });

    it('puts the message back when the chat engine did not take the turn up', async () => {
        const { hook, fns, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff' }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        expect(fns.sendMessage).toHaveBeenCalledTimes(1);
        // No re-render follows: the engine refused the turn silently.
        await waitFor(() => expect(fns.setChatInput).toHaveBeenCalledWith('Plan the kickoff'));
    });

    it('does not give the message back once the turn is running', async () => {
        const { hook, fns, view } = setup();
        act(() => { hook.result.current.startChat({ project: PROJECT, message: 'Plan the kickoff' }); });
        view({ activeProjectId: 'p1', directChatMode: true });
        view({ activeProjectId: 'p1', directChatMode: true, isLoading: true, messages: [USER_MSG] });
        await new Promise(resolve => setTimeout(resolve, 120));
        expect(fns.setChatInput).not.toHaveBeenCalled();
    });
});

describe('decideOutcome', () => {
    const start = { type: 'direct' as const, agentId: null, message: 'Plan the kickoff', share: true };
    const view = (over: Partial<ChatViewState>): ChatViewState => ({ ...EMPTY_VIEW, directChatMode: true, ...over });

    it('shares only the conversation whose first message is the one sent', () => {
        expect(decideOutcome(start, view({ directConversationId: 'c1', messages: [USER_MSG] }), 'c1'))
            .toEqual({ kind: 'share', conversationId: 'c1' });
        expect(decideOutcome(start, view({ directConversationId: 'c1', messages: [{ role: 'user', content: 'other' }] }), 'c1'))
            .toEqual({ kind: 'not-shared' });
    });

    it('shares only the conversation the turn created, even when another one starts with the same message', () => {
        expect(decideOutcome(start, view({ directConversationId: 'older', messages: [USER_MSG] }), 'c1'))
            .toEqual({ kind: 'not-shared' });
        expect(decideOutcome(start, view({ directConversationId: 'older', messages: [USER_MSG] }), null))
            .toEqual({ kind: 'not-shared' });
    });

    it('skips hidden messages when looking for the first one', () => {
        const messages = [{ role: 'user', content: 'system nudge', isHidden: true }, USER_MSG];
        expect(decideOutcome(start, view({ directConversationId: 'c1', messages }), 'c1')).toEqual({ kind: 'share', conversationId: 'c1' });
    });

    it('gives the message back when the new chat is still empty', () => {
        expect(decideOutcome(start, view({}), null)).toEqual({ kind: 'give-back' });
    });

    it('is done without sharing when sharing was not asked for', () => {
        expect(decideOutcome({ ...start, share: false }, view({ directConversationId: 'c1', messages: [USER_MSG] }), 'c1')).toEqual({ kind: 'done' });
        expect(decideOutcome({ ...start, share: false }, view({ directConversationId: 'x', messages: [REPLY] }), null)).toEqual({ kind: 'done' });
    });

    it('does not share a direct chat while an agent is on screen', () => {
        expect(decideOutcome(start, view({ selectedAgentId: 'agent-1', directConversationId: 'c1', messages: [USER_MSG] }), 'c1'))
            .toEqual({ kind: 'not-shared' });
    });
});
