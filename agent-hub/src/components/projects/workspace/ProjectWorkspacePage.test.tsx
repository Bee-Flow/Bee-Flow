import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectKeys } from '../../../api/queries/projects';
import { testQueryClient, withQueryClient } from '../../../test/queryWrapper';
import ProjectWorkspacePage from './ProjectWorkspacePage';
import type { ProjectWorkspacePageProps } from './types';
import { EDITOR_ID, makeFakeApi, makeMembers, makeProject, OWNER_ID, reply } from './workspaceTestApi';

const { fetchMock, sectionProps } = vi.hoisted(() => ({ fetchMock: vi.fn(), sectionProps: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));
// No live stream in a unit test; the provider's cache wiring is tested with it.
vi.mock('../../../hooks/useProjectStream', () => ({ default: () => undefined }));

// The chat and content sections belong to their own modules; here they only
// have to receive the contract props.
function section(name: string) {
    return {
        default: (props: Record<string, unknown>) => {
            sectionProps(name, props);
            return <div data-testid={`section-${name}`}>{String(props.sub ?? '')}|{String(props.intent ?? '')}</div>;
        },
    };
}
vi.mock('./chat/ProjectChatsTab', () => section('chats'));
vi.mock('./content/DocumentsTab', () => section('documents'));
vi.mock('./content/NotebooksTab', () => section('notebooks'));
vi.mock('./content/MeetingsTab', () => section('meetings'));
vi.mock('./content/KnowledgeTab', () => section('knowledge'));

function serve(project = makeProject(), extra: Record<string, unknown> = {}) {
    const api = makeFakeApi({
        'GET /api/projects/p1': project,
        'GET /api/projects/p1/members': makeMembers(),
        'GET /api/projects/p1/resources': { documents: [{ id: 'd1', name: 'Brief' }], notebooks: [], meetings: null, knowledgeBases: [] },
        'GET /api/projects/p1/threads': { threads: [] },
        'GET /api/projects/p1/chats': { chats: [{ id: 'c1', title: 'Standup' }] },
        'GET /api/projects/p1/files': { files: [], kbId: null },
        'POST /api/projects/p1/presence': { ok: true },
        'PUT /api/projects/p1/kind': { ...project, kind: 'workspace' },
        'POST /api/projects': (call: { body: unknown }) => ({ ...(call.body as object), id: 'p-new', role: 'owner' }),
        ...extra,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    return api;
}

function renderPage(over: Partial<ProjectWorkspacePageProps> = {}) {
    const props: ProjectWorkspacePageProps = {
        projectId: 'p1',
        user: { id: OWNER_ID, displayName: 'Olivia Owner' },
        onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn(), onRouteChange: vi.fn(),
        onOpenThread: vi.fn(), onNavigate: vi.fn(), onStartChat: vi.fn(),
        ...over,
    };
    const view = render(withQueryClient(<ProjectWorkspacePage {...props} />));
    return { props, view, user: userEvent.setup() };
}

const lastPropsOf = (name: string) => [...sectionProps.mock.calls].reverse().find(([n]) => n === name)?.[1] as Record<string, any>;

beforeEach(() => { fetchMock.mockReset(); sectionProps.mockReset(); });

describe('ProjectWorkspacePage — create mode', () => {
    it('asks for a name, then creates a workspace project and hands it over', async () => {
        const api = serve();
        const { props, user } = renderPage({ projectId: '' });
        await user.click(screen.getByTestId('project-create-submit'));
        expect(await screen.findByText('Give the project a name.')).toBeInTheDocument();
        expect(api.callsTo('POST', '/api/projects')).toHaveLength(0);

        await user.type(screen.getByTestId('project-field-name'), 'Website relaunch');
        await user.click(screen.getByRole('radio', { name: 'Teal' }));
        await user.click(screen.getByRole('radio', { name: 'Rocket' }));
        await user.click(screen.getByRole('button', { name: 'Add instructions for the AI (optional)' }));
        await user.type(screen.getByTestId('project-field-instructions'), 'Plain language.');
        await user.click(screen.getByTestId('project-create-submit'));

        await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-new' })));
        expect(api.callsTo('POST', '/api/projects')[0].body).toEqual({
            name: 'Website relaunch', description: '', icon: '🚀', color: '#14b8a6', customInstructions: 'Plain language.', kind: 'workspace',
        });
    });

    it('shows a refused create and stays on the form', async () => {
        serve(undefined, { 'POST /api/projects': reply(400, { error: 'Name is too long' }) });
        const { props, user } = renderPage({ projectId: '' });
        await user.type(screen.getByTestId('project-field-name'), 'X');
        await user.click(screen.getByTestId('project-create-submit'));
        expect(await screen.findByTestId('project-create-error')).toHaveTextContent('Name is too long');
        expect(props.onSaved).not.toHaveBeenCalled();
    });
});

describe('ProjectWorkspacePage — navigation', () => {
    it('opens on the overview with the rail, counts only once known, and the presence beat', async () => {
        const api = serve();
        renderPage();
        expect(await screen.findByTestId('project-overview-tab')).toBeInTheDocument();
        expect(screen.getByTestId('project-rail-name')).toHaveTextContent('Launch plan');
        await waitFor(() => expect(screen.getByTestId('project-rail-members-count')).toHaveTextContent('3'));
        expect(screen.getByTestId('project-rail-documents-count')).toHaveTextContent('1');
        expect(screen.queryByTestId('project-rail-meetings-count')).toBeNull();
        expect(api.callsTo('POST', '/api/projects/p1/presence').length).toBeGreaterThan(0);
    });

    it('leaves Notebooks out of the rail, and tells every section, for a reader who may not use notebooks', async () => {
        serve();
        renderPage({ notebooksEnabled: false });
        expect(await screen.findByTestId('project-rail-documents')).toBeInTheDocument();
        expect(screen.queryByTestId('project-rail-notebooks')).toBeNull();
        expect(screen.getByTestId('project-overview-tab')).toBeInTheDocument();
        expect(screen.queryByTestId('quick-notebook')).toBeNull();
    });

    it('an old link to the Notebooks section still lands there, told that notebooks are off', async () => {
        serve();
        renderPage({ notebooksEnabled: false, initialTab: 'notebooks' });
        expect(await screen.findByTestId('section-notebooks')).toBeInTheDocument();
        expect(lastPropsOf('notebooks').notebooksEnabled).toBe(false);
    });

    it('tells a section that notebooks are on when the app did not say otherwise', async () => {
        serve();
        renderPage({ initialTab: 'notebooks' });
        expect(await screen.findByTestId('section-notebooks')).toBeInTheDocument();
        expect(lastPropsOf('notebooks').notebooksEnabled).toBe(true);
        expect(screen.getByTestId('project-rail-notebooks')).toBeInTheDocument();
    });

    it('switches sections from the rail and reports the route', async () => {
        serve();
        const { props, user } = renderPage();
        await user.click(await screen.findByTestId('project-rail-activity'));
        expect(await screen.findByTestId('project-activity-tab')).toBeInTheDocument();
        expect(props.onRouteChange).toHaveBeenLastCalledWith('activity', null);
        expect(screen.getByTestId('project-rail-activity')).toHaveAttribute('aria-current', 'page');
    });

    it('asks before leaving Settings with unsaved edits, and keeps them when the person stays', async () => {
        serve();
        const { props, user } = renderPage({ initialTab: 'settings' });
        const name = await screen.findByTestId('project-field-name');
        await user.type(name, ' 2');
        await user.click(screen.getByTestId('project-rail-activity'));
        expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
        expect(props.onRouteChange).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Keep editing' }));
        expect(screen.getByTestId('project-field-name')).toHaveValue('Launch plan 2');
        await user.click(screen.getByTestId('project-rail-activity'));
        await user.click(await screen.findByRole('button', { name: 'Leave without saving' }));
        expect(await screen.findByTestId('project-activity-tab')).toBeInTheDocument();
        expect(props.onRouteChange).toHaveBeenLastCalledWith('activity', null);
    });

    it('protects All projects, browser traversal and reload while settings are dirty', async () => {
        serve();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
            const { props, user } = renderPage({ initialTab: 'settings' });
            await user.type(await screen.findByTestId('project-field-name'), ' draft');
            await user.click(screen.getByTestId('project-rail-back'));
            expect(confirm).toHaveBeenCalledOnce();
            expect(props.onClose).not.toHaveBeenCalled();
            const unload = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(unload);
            expect(unload.defaultPrevented).toBe(true);
            const downstream = vi.fn();
            window.addEventListener('popstate', downstream);
            try {
                window.dispatchEvent(new PopStateEvent('popstate'));
                expect(downstream).not.toHaveBeenCalled();
                expect(screen.getByTestId('project-field-name')).toHaveValue('Launch plan draft');
            } finally { window.removeEventListener('popstate', downstream); }
            confirm.mockReturnValue(true);
            await user.click(screen.getByTestId('project-rail-back'));
            expect(props.onClose).toHaveBeenCalledOnce();
        } finally { confirm.mockRestore(); }
    });

    it('leaves Settings at once when nothing was edited', async () => {
        serve();
        const { user } = renderPage({ initialTab: 'settings' });
        await screen.findByTestId('project-field-name');
        await user.click(screen.getByTestId('project-rail-activity'));
        expect(await screen.findByTestId('project-activity-tab')).toBeInTheDocument();
        expect(screen.queryByText('Leave without saving?')).not.toBeInTheDocument();
    });

    it('maps an old tab id and follows the URL on back/forward', async () => {
        serve();
        const { props, view } = renderPage({ initialTab: 'general' });
        expect(await screen.findByTestId('project-settings-tab')).toBeInTheDocument();
        view.rerender(withQueryClient(<ProjectWorkspacePage {...props} initialTab="threads" />));
        expect(await screen.findByTestId('section-chats')).toBeInTheDocument();
    });

    it('hands a section its item and reports opening another one', async () => {
        serve();
        const { props } = renderPage({ initialTab: 'chats', initialSub: 'c1' });
        expect(await screen.findByTestId('section-chats')).toHaveTextContent('c1|');
        const chatProps = lastPropsOf('chats');
        expect(chatProps).toMatchObject({ projectId: 'p1', role: 'owner', currentUser: { id: OWNER_ID } });
        expect(typeof chatProps.onOpenThread).toBe('function');
        act(() => chatProps.onOpenSub(null));
        expect(props.onRouteChange).toHaveBeenLastCalledWith('chats', null);
        await waitFor(() => expect(screen.getByTestId('section-chats')).toHaveTextContent('|'));
    });

    it('carries a quick action’s intent into the section it opens', async () => {
        serve();
        const { props, user } = renderPage();
        await user.click(await screen.findByTestId('quick-files'));
        expect(await screen.findByTestId('section-knowledge')).toHaveTextContent('|upload');
        expect(props.onRouteChange).toHaveBeenLastCalledWith('knowledge', null);
    });
    it('starts afresh when the sidebar moves to another project, keeping no draft', async () => {
        const p2 = makeProject({ id: 'p2', name: 'Budget 2027' });
        serve(undefined, {
            'GET /api/projects/p2': p2,
            'GET /api/projects/p2/members': makeMembers(),
            'GET /api/projects/p2/resources': { documents: [], notebooks: [], meetings: [], knowledgeBases: [] },
            'GET /api/projects/p2/threads': { threads: [] },
            'GET /api/projects/p2/chats': { chats: [] },
            'GET /api/projects/p2/files': { files: [], kbId: null },
            'POST /api/projects/p2/presence': { ok: true },
        });
        // Project B was opened a moment ago: its detail is still cached, so
        // nothing unmounts while it loads.
        const client = testQueryClient();
        client.setQueryData(projectKeys.detail('p2'), p2);
        const props: ProjectWorkspacePageProps = {
            projectId: 'p1', user: { id: OWNER_ID, displayName: 'Olivia Owner' },
            onClose: vi.fn(), onOpenThread: vi.fn(), onNavigate: vi.fn(), onStartChat: vi.fn(() => true),
        };
        const user = userEvent.setup();
        const view = render(withQueryClient(<ProjectWorkspacePage {...props} />, client));
        await user.type(await screen.findByTestId('composer-input'), 'Salary bands for the reorg');

        view.rerender(withQueryClient(<ProjectWorkspacePage {...props} projectId="p2" />, client));
        await waitFor(() => expect(screen.getByTestId('project-rail-name')).toHaveTextContent('Budget 2027'));
        expect(screen.getByTestId('composer-input')).toHaveValue('');
        expect(screen.queryByRole('checkbox', { name: 'Share with members' })).not.toBeInTheDocument();
    });
});

describe('ProjectWorkspacePage — access and kind', () => {
    it('says so when the project is gone or not shared with you', async () => {
        serve(undefined, { 'GET /api/projects/p1': reply(404, { error: 'Not found' }) });
        const { props, user } = renderPage();
        expect(await screen.findByTestId('project-unavailable')).toHaveTextContent('does not exist, or you no longer have access');
        await user.click(screen.getByRole('button', { name: 'All projects' }));
        expect(props.onClose).toHaveBeenCalled();
    });

    it('lets the owner keep a project from before the split', async () => {
        const api = serve(makeProject({ kind: null }));
        const { user } = renderPage();
        const notice = await screen.findByTestId('project-kind-legacy');
        await user.click(within(notice).getByTestId('project-keep-kind'));
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1/kind')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1/kind')[0].body).toEqual({ kind: 'workspace' });
    });

    it('does not offer the classification to a non-owner', async () => {
        serve(makeProject({ kind: null, role: 'editor' }));
        renderPage({ user: { id: EDITOR_ID } });
        const notice = await screen.findByTestId('project-kind-legacy');
        expect(within(notice).queryByTestId('project-keep-kind')).toBeNull();
        expect(notice).toHaveTextContent('The owner can keep it as a project.');
    });

    it('points a Studio Solution to Studio', async () => {
        serve(makeProject({ kind: 'solution' }));
        const { props, user } = renderPage();
        const notice = await screen.findByTestId('project-kind-solution');
        await user.click(within(notice).getByRole('button', { name: 'Open in Studio' }));
        expect(props.onNavigate).toHaveBeenCalledWith('studio/solutions/p1');
    });

    it('lets the owner keep a project the upgrade sorted as a Solution, once', async () => {
        const api = serve(makeProject({ kind: 'solution', kindGuessed: true }));
        const { user } = renderPage();
        const notice = await screen.findByTestId('project-kind-solution');
        expect(notice).toHaveTextContent('this was sorted as a Studio Solution');
        await user.click(within(notice).getByTestId('project-keep-kind'));
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1/kind')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1/kind')[0].body).toEqual({ kind: 'workspace' });
    });

    it('says what is in the way when the project still holds a Solution’s pieces', async () => {
        serve(makeProject({ kind: 'solution', kindGuessed: true }), {
            'PUT /api/projects/p1/kind': reply(409, {
                error: 'This project still holds items a collaborative project cannot hold.',
                code: 'KIND_HOLDS_OTHER_CONTENT', details: { kind: 'workspace', held: { apps: 1 } },
            }),
        });
        const { user } = renderPage();
        const notice = await screen.findByTestId('project-kind-solution');
        await user.click(within(notice).getByTestId('project-keep-kind'));
        expect(await within(notice).findByRole('alert')).toHaveTextContent('which a project cannot hold');
    });

    it('offers no correction for a Solution its owner chose', async () => {
        serve(makeProject({ kind: 'solution', kindGuessed: false }));
        renderPage();
        const chosen = await screen.findByTestId('project-kind-solution');
        expect(within(chosen).queryByTestId('project-keep-kind')).toBeNull();
    });

    it('offers no correction of a guessed Solution to a non-owner', async () => {
        serve(makeProject({ kind: 'solution', kindGuessed: true, role: 'editor' }));
        renderPage({ user: { id: EDITOR_ID } });
        const notice = await screen.findByTestId('project-kind-solution');
        expect(within(notice).queryByTestId('project-keep-kind')).toBeNull();
        expect(notice).toHaveTextContent('This is a Studio Solution.');
    });

    it('treats a missing role as the least privilege, never as owner', async () => {
        serve(makeProject({ role: undefined, permission: undefined }));
        renderPage({ user: { id: EDITOR_ID } });
        expect(await screen.findByTestId('composer-readonly')).toBeInTheDocument();
    });
});

describe('ProjectWorkspacePage — what changed', () => {
    const now = new Date().toISOString();
    const unreadDoc = {
        item: { type: 'document', id: 'd1', title: 'Brief', available: true },
        lastChangedAt: now, changeCount: 1, contributors: [{ userId: EDITOR_ID, kind: 'user' }],
        stats: { wordsAdded: 4, wordsRemoved: 0, blocksChanged: 1 }, latestVersionId: 'v1', seenVersionId: null,
        kinds: ['edited'], aiAssisted: false, minor: false, unread: true,
    };
    const changesRoute = (call: { query: URLSearchParams }) => (call.query.get('since') === 'unread'
        ? { groups: [unreadDoc], since: 'unread', prevVisitAt: null, visitStartedAt: now }
        : { groups: [], since: 'visit', prevVisitAt: null, visitStartedAt: now });

    it('posts the visit on open and marks the sections with changes the reader has not seen', async () => {
        const api = serve(makeProject(), {
            'POST /api/projects/p1/visit': { prevVisitAt: null, visitStartedAt: now },
            'GET /api/projects/p1/changes': changesRoute,
            'GET /api/projects/p1/chats': { chats: [{ id: 'c1', title: 'Standup', unread: 2 }] },
        });
        renderPage();
        expect(await screen.findByTestId('project-rail-documents-unread')).toBeInTheDocument();
        expect(await screen.findByTestId('project-rail-chats-unread')).toBeInTheDocument();
        expect(screen.queryByTestId('project-rail-notebooks-unread')).toBeNull();
        expect(api.callsTo('POST', '/api/projects/p1/visit')).toHaveLength(1);
    });

    it('marks a document seen once it has been open a moment', async () => {
        const api = serve(makeProject(), {
            'POST /api/projects/p1/visit': { prevVisitAt: null, visitStartedAt: now },
            'GET /api/projects/p1/changes': changesRoute,
            'POST /api/projects/p1/items/document/d1/seen': { ok: true },
        });
        renderPage({ initialTab: 'documents', initialSub: 'd1' });
        await screen.findByTestId('section-documents');
        expect(api.callsTo('POST', '/api/projects/p1/items/document/d1/seen')).toHaveLength(0);
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/items/document/d1/seen')).toHaveLength(1), { timeout: 5000 });
        // The section in view shows no dot of its own.
        expect(screen.queryByTestId('project-rail-documents-unread')).toBeNull();
    });
});
