/**
 * selectConversation's request race, pinned end-to-end.
 *
 * The handler does two sequential awaits — the conversation GET, then the
 * workspace GET — before it commits currentConversation, the URL, the notebook
 * pane and the messages. Nothing tied those writes to "is this still the
 * conversation the user wants", so two overlapping selections committed in
 * COMPLETION order rather than click order: click B, get A, and the next send
 * (plus saveNotebook's PUT) then targets whichever id won the race.
 *
 * Driven through the real component: the deep-link prop starts conversation A's
 * load, a sidebar click starts B's, and the responses are released by hand in
 * both of the orders that matter.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const AGENT = { id: 'agent-1', name: 'Finance', description: '', emoji: '🐝' };
const CONV_A = { id: 'conv-a', agent_id: 'agent-1', title: 'Alpha thread', updated_at: '2026-01-02T00:00:00Z' };
const CONV_B = { id: 'conv-b', agent_id: 'agent-1', title: 'Bravo thread', updated_at: '2026-01-01T00:00:00Z' };

const msg = (text) => ({ id: text, role: 'assistant', content: text, timestamp: '2026-01-01T00:00:00Z' });

const res = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
const ok = (body) => Promise.resolve(res(body));

/** Hand-released responses for the two conversation GETs and A's workspace GET. */
let gate;

const routes = (url) => {
    const u = String(url);
    if (u.includes('/conversations/conv-a/workspace')) return gate.workspaceA.promise;
    if (u.includes('/conversations/conv-b/workspace')) return ok({ content: 'B notebook', notebookId: 'nb-b' });
    if (u.includes('/conversations/conv-a')) return gate.convA.promise;
    if (u.includes('/conversations/conv-b')) return gate.convB.promise;
    if (u.endsWith('/agents/agent-1/conversations')) return ok([CONV_A, CONV_B]);
    if (u.endsWith('/agents/agent-1')) return ok(AGENT);
    if (u.includes('/agents')) return ok([AGENT]);
    // Everything else the hub polls on mount (skills, apps, webpages, …) —
    // an empty list is a valid body for all of them.
    return ok([]);
};

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

const USER = { id: 'u1', username: 'tom', permissions: ['all'], isAdmin: true };

// A positive assertion here waits for a render that is two macrotask hops and
// a fetch away. One second is enough on an idle box and not enough when 1,185
// test files share the machine, and the failure then reads as a product bug.
// The negative assertions below are still checked immediately, so a longer
// budget makes this file slower under load, never blinder.
const ARRIVES = { timeout: 15_000 };

const settle = async (fn) => {
    await act(async () => { fn(); await Promise.resolve(); });
    // TWO macrotask ticks, not one. The path under test has two sequential
    // awaits — the conversation GET, then the workspace GET — and each one
    // needs a tick to hand off. A single tick covers both only while the box
    // is idle; under load the second hop lands after the assertions and the
    // test failed on timing rather than on behaviour.
    //
    // Flushing MORE is the safe direction here, which is why this is the fix
    // rather than a bigger waitFor: every assertion that matters in this file
    // is NEGATIVE ("alpha body must not be on screen"). Extra settling gives
    // a genuine leak more room to appear, so this makes the suite stricter,
    // never more forgiving. Verified by hand-break: dropping the generation
    // guard in AgentHub still turns these tests red.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

/** Mount on A's deep link, then click B's sidebar row while A is in flight. */
async function mountAndOverlapSelections() {
    // AgentHub reaches the data layer (the skill chips read through
    // api/queries), so it needs a QueryClient the way it has one in the app.
    render(withQueryClient(
        <AgentHub user={USER} currentPage="agents" onNavigate={vi.fn()}
            initialAgentId="agent-1" initialConversationId="conv-a" />,
    ));
    await waitFor(() => expect(
        authFetch.mock.calls.some(([u]) => String(u).includes('/conversations/conv-a')),
    ).toBe(true), ARRIVES);

    await userEvent.click(await screen.findByText('Bravo thread', {}, ARRIVES));
    await waitFor(() => expect(
        authFetch.mock.calls.some(([u]) => String(u).includes('/conversations/conv-b')),
    ).toBe(true), ARRIVES);
}

beforeEach(() => {
    gate = { convA: deferred(), convB: deferred(), workspaceA: deferred() };
    window.history.replaceState({}, '', '/');
    authFetch.mockReset();
    authFetch.mockImplementation(routes);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('AgentHub — selectConversation request sequencing', () => {
    it('discards conversation A when it settles after the newer selection B', async () => {
        await mountAndOverlapSelections();

        // B settles first and lands on screen…
        await settle(() => gate.convB.resolve(res({ ...CONV_B, messages: [msg('bravo body')] })));
        await waitFor(() => expect(screen.getByText('bravo body')).toBeInTheDocument(), ARRIVES);

        // …then A's slow responses arrive. They must be discarded wholesale.
        await settle(() => {
            gate.convA.resolve(res({ ...CONV_A, messages: [msg('alpha body')] }));
            gate.workspaceA.resolve(res({ content: 'A notebook', notebookId: 'nb-a' }));
        });

        expect(screen.getByText('bravo body')).toBeInTheDocument();
        expect(screen.queryByText('alpha body')).not.toBeInTheDocument();
        expect(window.location.pathname).toBe('/a/agent-1/conv-b');
    });

    it('discards A\'s late workspace + messages when B lands between A\'s two awaits', async () => {
        await mountAndOverlapSelections();

        // A's conversation GET wins the first leg — its workspace GET is now
        // in flight, and everything after that await still belongs to A.
        await settle(() => gate.convA.resolve(res({ ...CONV_A, messages: [msg('alpha body')] })));
        // B then completes end to end.
        await settle(() => gate.convB.resolve(res({ ...CONV_B, messages: [msg('bravo body')] })));
        await waitFor(() => expect(screen.getByText('bravo body')).toBeInTheDocument(), ARRIVES);

        // A's workspace finally answers. The notebook setters and the
        // setMessages behind it are gated on the same generation, so nothing
        // of A may reach the screen.
        await settle(() => gate.workspaceA.resolve(res({ content: 'A notebook', notebookId: 'nb-a' })));

        expect(screen.getByText('bravo body')).toBeInTheDocument();
        expect(screen.queryByText('alpha body')).not.toBeInTheDocument();
        expect(window.location.pathname).toBe('/a/agent-1/conv-b');
    });
});

/**
 * BFSF-453: a loaded or reloaded conversation opens at its latest message.
 *
 * The only scroll rule used to be "follow when within 300px of the bottom",
 * plus a forced scroll on SEND. A freshly loaded list sits at scrollTop 0, so
 * every conversation taller than the viewport opened at its top. jsdom has no
 * layout: the scroller's height is stubbed on the element the chat pane
 * renders its messages in, before the messages arrive.
 */
function stubScroller() {
    // The empty state is the scroller's only child until messages arrive.
    const container = screen.getByTestId('empty-chat-state').parentElement;
    let top = 0;
    Object.defineProperty(container, 'scrollHeight', { get: () => 5000, configurable: true });
    Object.defineProperty(container, 'clientHeight', { get: () => 600, configurable: true });
    Object.defineProperty(container, 'scrollTop', {
        get: () => top,
        set: (v) => { top = Math.max(0, Math.min(v, 5000)); },
        configurable: true,
    });
    return container;
}

describe('AgentHub — a loaded conversation opens at its latest message', () => {
    it('scrolls an agent conversation restored from the URL to the bottom', async () => {
        render(withQueryClient(
            <AgentHub user={USER} currentPage="agents" onNavigate={vi.fn()}
                initialAgentId="agent-1" initialConversationId="conv-a" />,
        ));
        await waitFor(() => expect(
            authFetch.mock.calls.some(([u]) => String(u).includes('/conversations/conv-a')),
        ).toBe(true), ARRIVES);
        const container = stubScroller();

        await settle(() => {
            gate.convA.resolve(res({ ...CONV_A, messages: [msg('first line'), msg('latest line')] }));
            gate.workspaceA.resolve(res({ content: '', notebookId: null }));
        });
        await waitFor(() => expect(screen.getByText('latest line')).toBeInTheDocument(), ARRIVES);

        expect(container.scrollTop).toBe(5000);
    });

    it('scrolls a direct chat restored from the URL to the bottom', async () => {
        const detail = deferred();
        authFetch.mockImplementation((url) => {
            const u = String(url);
            if (u.includes('/ai/direct/conversations/dc-1/workspace')) return ok({ content: '', notebookId: null });
            if (u.includes('/ai/direct/conversations/dc-1')) return detail.promise;
            if (u.endsWith('/ai/direct/conversations')) return ok([{ id: 'dc-1', title: 'Direct thread', updated_at: '2026-01-01T00:00:00Z' }]);
            return routes(url);
        });
        render(withQueryClient(
            <AgentHub user={USER} currentPage="agents" onNavigate={vi.fn()} initialDirectConvId="dc-1" />,
        ));
        await waitFor(() => expect(
            authFetch.mock.calls.some(([u]) => String(u).includes('/ai/direct/conversations/dc-1')),
        ).toBe(true), ARRIVES);
        const container = stubScroller();

        await settle(() => detail.resolve(res({ id: 'dc-1', messages: [msg('first line'), msg('latest line')] })));
        await waitFor(() => expect(screen.getByText('latest line')).toBeInTheDocument(), ARRIVES);

        expect(container.scrollTop).toBe(5000);
    });

    it('scrolls a direct chat picked from the sidebar to the bottom', async () => {
        const first = deferred();
        const second = deferred();
        authFetch.mockImplementation((url) => {
            const u = String(url);
            if (u.includes('/workspace')) return ok({ content: '', notebookId: null });
            if (u.includes('/ai/direct/conversations/dc-2')) return second.promise;
            if (u.includes('/ai/direct/conversations/dc-1')) return first.promise;
            if (u.endsWith('/ai/direct/conversations')) {
                return ok([
                    { id: 'dc-1', title: 'Direct thread', updated_at: '2026-01-02T00:00:00Z' },
                    { id: 'dc-2', title: 'Second thread', updated_at: '2026-01-01T00:00:00Z' },
                ]);
            }
            return routes(url);
        });
        render(withQueryClient(
            <AgentHub user={USER} currentPage="agents" onNavigate={vi.fn()} initialDirectConvId="dc-1" />,
        ));
        // Stub while the pane is still empty, then let the first chat land.
        await waitFor(() => expect(
            authFetch.mock.calls.some(([u]) => String(u).includes('/ai/direct/conversations/dc-1')),
        ).toBe(true), ARRIVES);
        const container = stubScroller();
        await settle(() => first.resolve(res({ id: 'dc-1', messages: [msg('one body')] })));
        await waitFor(() => expect(screen.getByText('one body')).toBeInTheDocument(), ARRIVES);

        // The reader is at the top when they pick the other chat.
        container.scrollTop = 0;
        await userEvent.click(await screen.findByText('Second thread', {}, ARRIVES));
        await settle(() => second.resolve(res({ id: 'dc-2', messages: [msg('two first'), msg('two latest')] })));
        await waitFor(() => expect(screen.getByText('two latest')).toBeInTheDocument(), ARRIVES);

        expect(container.scrollTop).toBe(5000);
    });
});
