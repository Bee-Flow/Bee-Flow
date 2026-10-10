/**
 * The project workspace, wired into the hub the way it runs.
 *
 * The workspace page itself is stubbed (it has its own tests); what is pinned
 * here is everything AgentHub adds around it: which projects the sidebar
 * lists, that opening one makes it the chat context, the pill that says so in
 * the chat, and the full "start a chat in this project" path through the real
 * chat engine — the first turn carries the project, and the conversation it
 * creates is the one shared into the project, only after the turn finished.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentHub from './AgentHub';
import { withQueryClient } from './test/queryWrapper';
import { authFetch } from './utils/helpers';
import { registerNavigationGuard } from './utils/unsavedNavigation';

vi.mock('./utils/helpers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/helpers')>();
    return { ...actual, authFetch: vi.fn() };
});
vi.mock('./components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, hasTier: () => true, tier: 'full' }),
    RequireTier: ({ children }: { children: React.ReactNode }) => children,
}));
// One entry per project the live feed was opened for (once per mount of an
// id, not per render), so a second provider anywhere shows up as a second entry.
const { streamMounts } = vi.hoisted(() => ({ streamMounts: [] as string[] }));
vi.mock('./hooks/useProjectStream', async () => {
    const react = await import('react');
    return {
        default: (options: { projectId?: string | null }) => {
            const id = options.projectId ?? null;
            react.useEffect(() => { if (id) streamMounts.push(id); }, [id]);
        },
    };
});
vi.mock('./components/projects/workspace/ProjectWorkspacePage', () => ({
    default: (props: Record<string, any>) => (
        <div data-testid="workspace-stub">
            <span>{`workspace ${props.projectId}`}</span>
            <button
                type="button"
                onClick={() => props.onStartChat({ project: WORKSPACE, message: 'Draft the kickoff agenda', share: true })}
            >
                start shared chat
            </button>
        </div>
    ),
}));

// AgentHub is plain JSX; its inferred props name every callback the app
// passes. The tests pass only the ones this seam uses.
const Hub = AgentHub as unknown as React.ComponentType<Record<string, unknown>>;

const WORKSPACE = { id: 'p1', name: 'Onboarding', icon: '🚀', color: '#22c55e', permission: 'owner' };
const CONV_PLAIN = { id: 'conv-plain', title: 'Private musings', project_id: null, updated_at: '2026-01-02T00:00:00Z' };
const CONV_FILED = { id: 'conv-filed', title: 'Kickoff notes', project_id: 'p1', updated_at: '2026-01-01T00:00:00Z' };
const USER = { id: 'u1', username: 'tom', permissions: ['all'], isAdmin: true };

const json = (body: unknown, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

/** An SSE body the chat engine reads with getReader(). */
const stream = (frames: string[]) => {
    const encoded = frames.map((f) => new TextEncoder().encode(f));
    let i = 0;
    return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
            getReader: () => ({
                read: () => Promise.resolve(i < encoded.length ? { done: false, value: encoded[i++] } : { done: true, value: undefined }),
                cancel: () => Promise.resolve(),
            }),
        },
    });
};

const calls = () => vi.mocked(authFetch).mock.calls.map(([url, init]) => ({ url: String(url), init: (init || {}) as RequestInit }));
const posted = (fragment: string) => calls().filter(c => c.url.includes(fragment) && c.init.method === 'POST');

beforeEach(() => {
    streamMounts.length = 0;
    window.history.replaceState({}, '', '/');
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(((url: string) => {
        const u = String(url);
        if (u.includes('/api/projects?kind=workspace')) return json([WORKSPACE]);
        if (u.includes('/api/projects/p1/threads')) return json({ shared: true });
        if (u.endsWith('/ai/direct/conversations')) return json([CONV_PLAIN, CONV_FILED]);
        if (u.includes('/ai/direct/conversations/conv-plain')) return json({ ...CONV_PLAIN, messages: [] });
        if (u.includes('/ai/direct/conversations/conv-filed')) return json({ ...CONV_FILED, messages: [] });
        if (u.includes('/ai/chat/direct/stream')) {
            return stream([
                'event: conversation_created\ndata: {"conversationId":"conv-new"}\n\n',
                'event: content\ndata: {"text":"Here is an agenda."}\n\n',
                'event: done\ndata: {}\n\n',
            ]);
        }
        return json([]);
    }) as never);
});
afterEach(() => { vi.restoreAllMocks(); });

const ARRIVES = { timeout: 15_000 };

function renderHub(extra: Record<string, unknown> = {}) {
    const onProjectRouteChange = vi.fn();
    const onCloseProjects = vi.fn();
    render(withQueryClient(
        <Hub
            user={USER}
            currentPage="agents"
            onNavigate={vi.fn()}
            onProjectRouteChange={onProjectRouteChange}
            onCloseProjects={onCloseProjects}
            {...extra}
        />,
    ));
    return { onProjectRouteChange, onCloseProjects };
}

describe('AgentHub — projects in the sidebar', () => {
    it('asks for the collaborative workspaces only, and lists them', async () => {
        renderHub();
        expect(await screen.findByTestId('sidebar-project-p1', {}, ARRIVES)).toBeInTheDocument();
        expect(calls().some(c => c.url.includes('/api/projects?kind=workspace'))).toBe(true);
        expect(calls().some(c => /\/api\/projects$/.test(c.url))).toBe(false);
    });

    it('opens a project from its row, and makes it the chat context', async () => {
        const { onProjectRouteChange } = renderHub();
        const row = await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        await userEvent.click(within(row).getByText('Onboarding'));
        expect(onProjectRouteChange).toHaveBeenCalledWith('p1', undefined, undefined);
        expect(await screen.findByText('workspace p1', {}, ARRIVES)).toBeInTheDocument();
        expect(within(row).getByText('Onboarding').closest('button')).toHaveAttribute('aria-current', 'true');
    });

    it('starts a new chat in a project from its "+", with the pill in the chat header', async () => {
        renderHub();
        await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        await userEvent.click(screen.getByRole('button', { name: 'New chat in Onboarding' }));
        const pill = await screen.findByTestId('project-context-pill', {}, ARRIVES);
        expect(within(pill).getByText('Onboarding')).toBeInTheDocument();

        await userEvent.click(within(pill).getByRole('button', { name: 'Stop chatting in project Onboarding' }));
        await waitFor(() => expect(screen.queryByTestId('project-context-pill')).toBeNull());
    });
});

describe('AgentHub — starting a chat from a project', () => {
    it('sends the first turn with the project and shares the conversation it created', async () => {
        const { onCloseProjects } = renderHub({ showProjects: true, initialProjectRoute: { projectId: 'p1', tab: 'overview', sub: null } });
        await userEvent.click(await screen.findByText('start shared chat', {}, ARRIVES));
        expect(onCloseProjects).toHaveBeenCalled();

        // The first turn goes out in the project.
        await waitFor(() => expect(posted('/ai/chat/direct/stream')).toHaveLength(1), ARRIVES);
        const turn = JSON.parse(String(posted('/ai/chat/direct/stream')[0].init.body));
        expect(turn.message).toBe('Draft the kickoff agenda');
        expect(turn.projectId).toBe('p1');

        // …and the conversation it created is the one that is shared.
        await waitFor(() => expect(posted('/api/projects/p1/threads')).toHaveLength(1), ARRIVES);
        expect(JSON.parse(String(posted('/api/projects/p1/threads')[0].init.body)))
            .toEqual({ conversationId: 'conv-new', type: 'direct' });
        expect(await screen.findByText('Here is an agenda.', {}, ARRIVES)).toBeInTheDocument();
        expect(screen.getByTestId('project-context-pill')).toBeInTheDocument();
    });
});

describe('AgentHub — the project context does not leak into other chats', () => {
    const intoProject = async () => {
        renderHub();
        await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        await userEvent.click(screen.getByRole('button', { name: 'New chat in Onboarding' }));
        await screen.findByTestId('project-context-pill', {}, ARRIVES);
    };

    it('drops the project when a new chat is started from the sidebar', async () => {
        await intoProject();
        await userEvent.click(screen.getByTestId('nav-new-chat'));
        await waitFor(() => expect(screen.queryByTestId('project-context-pill')).toBeNull());
    });

    it('sends the first turn of that new chat without the project', async () => {
        await intoProject();
        await userEvent.click(screen.getByTestId('nav-new-chat'));
        await waitFor(() => expect(screen.queryByTestId('project-context-pill')).toBeNull());
        await userEvent.type(screen.getByRole('textbox'), 'Just between us{enter}');
        await waitFor(() => expect(posted('/ai/chat/direct/stream')).toHaveLength(1), ARRIVES);
        expect(JSON.parse(String(posted('/ai/chat/direct/stream')[0].init.body)).projectId).toBeUndefined();
    });

    it('takes the project an existing conversation is filed in, and loses it again on a new chat', async () => {
        renderHub();
        await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        await userEvent.click(screen.getByTestId('nav-new-chat'));
        await userEvent.click(await screen.findByText('Kickoff notes', {}, ARRIVES));
        const pill = await screen.findByTestId('project-context-pill', {}, ARRIVES);
        expect(within(pill).getByText('Onboarding')).toBeInTheDocument();

        await userEvent.click(screen.getByTestId('nav-new-chat'));
        await waitFor(() => expect(screen.queryByTestId('project-context-pill')).toBeNull());
    });

    it('has no project for an existing conversation that is not filed in one', async () => {
        renderHub();
        await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        await userEvent.click(screen.getByTestId('nav-new-chat'));
        await userEvent.click(await screen.findByText('Private musings', {}, ARRIVES));
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/ai/direct/conversations/conv-plain')), ARRIVES);
        expect(screen.queryByTestId('project-context-pill')).toBeNull();
    });
});

describe('AgentHub — the live feed of the open project', () => {
    it('opens one live feed for the open project, shared by sidebar and workspace', async () => {
        renderHub({ showProjects: true, initialProjectRoute: { projectId: '1a4834b9', tab: 'tasks', sub: null } });
        await screen.findByTestId('workspace-stub', {}, ARRIVES);
        expect(streamMounts).toEqual(['1a4834b9']);
    });

    it('opens no feed on the project list', async () => {
        renderHub({ showProjects: true, initialProjectRoute: { projectId: null, tab: null, sub: null } });
        await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        expect(streamMounts).toEqual([]);
    });
});

describe('AgentHub — the sidebar inside a project', () => {
    // The host (AuthedApp) keeps currentPage at the bare 'projects' and owns the
    // route; a route change from the hub moves initialProjectRoute.
    function Host() {
        const [route, setRoute] = React.useState<{ projectId: string | null; tab: string | null; sub: string | null } | null>(null);
        return (
            <Hub
                user={USER}
                currentPage={route ? 'projects' : 'agents'}
                onNavigate={vi.fn()}
                showProjects={!!route}
                initialProjectRoute={route}
                onProjectRouteChange={(id: string | null, tab?: string, sub?: string) => setRoute({ projectId: id, tab: tab ?? null, sub: sub ?? null })}
                onCloseProjects={vi.fn()}
            />
        );
    }

    it('is the rail; leaving brings the sidebar back, expanded as before', async () => {
        render(withQueryClient(<Host />));
        const row = await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        // Before: the ordinary sidebar, expanded.
        expect(screen.getByTestId('sidebar')).toHaveClass('w-72');

        await userEvent.click(within(row).getByText('Onboarding'));
        expect(await screen.findByTestId('project-rail', {}, ARRIVES)).toBeInTheDocument();
        expect(screen.queryByTestId('main-navigation')).toBeNull();

        await userEvent.click(screen.getByTestId('project-rail-back'));
        expect(await screen.findByTestId('main-navigation', {}, ARRIVES)).toBeInTheDocument();
        expect(screen.queryByTestId('project-rail')).toBeNull();
        expect(screen.getByTestId('sidebar')).toHaveClass('w-72');
        expect(screen.getByTestId('sidebar')).not.toHaveClass('w-16');
    });

    it('a cancelled unsaved-changes prompt keeps the project open; a confirmed one leaves', async () => {
        render(withQueryClient(<Host />));
        const row = await screen.findByTestId('sidebar-project-p1', {}, ARRIVES);
        await userEvent.click(within(row).getByText('Onboarding'));
        expect(await screen.findByTestId('project-rail', {}, ARRIVES)).toBeInTheDocument();

        const guard = vi.fn(() => false);
        const unregister = registerNavigationGuard(guard);
        try {
            await userEvent.click(screen.getByTestId('project-rail-back'));
            expect(guard).toHaveBeenCalled();
            expect(screen.getByTestId('project-rail')).toBeInTheDocument();
            expect(screen.getByTestId('workspace-stub')).toBeInTheDocument();
            expect(screen.queryByTestId('main-navigation')).toBeNull();

            guard.mockReturnValue(true);
            await userEvent.click(screen.getByTestId('project-rail-back'));
            expect(await screen.findByTestId('main-navigation', {}, ARRIVES)).toBeInTheDocument();
            expect(screen.queryByTestId('project-rail')).toBeNull();
        } finally {
            unregister();
        }
    });
});
