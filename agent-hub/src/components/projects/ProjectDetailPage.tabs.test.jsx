import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * CHARACTERISATION — the tabs of a project page, its activity feed, its member
 * list and the live stream that keeps all three current (PRJ-0).
 *
 * Two things are pinned that no other test covers:
 *   1. WHICH request a tab fires, and that it fires it on ENTRY rather than on
 *      mount — a redesign that pre-loads every tab changes the request pattern
 *      the server sees, not just the layout.
 *   2. WHAT the live feed does per event kind. The feed is the reason a
 *      colleague's change appears without a refresh, and it is invisible in a
 *      screenshot, so it is exactly the behaviour a rebuild drops silently.
 *
 * The load/create/save half lives in ProjectDetailPage.test.jsx.
 */

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

let streamOpts = null;
vi.mock('../../hooks/useProjectStream', () => ({
    default: (opts) => { streamOpts = opts; },
}));
vi.mock('../../hooks/useKnowledgeBases', () => ({
    default: () => ({
        kbs: [], showCreateKB: false, selectedKB: null, kbDocs: [],
        kbInputMode: 'text', kbIngesting: false, kbIngestStatus: '',
        kbTextTitle: '', kbTextContent: '', kbUrlInput: '',
        openCreateKB: () => {}, setSelectedKB: () => {}, setKbInputMode: () => {},
    }),
}));
vi.mock('../knowledge/memory/MemoryPanel', () => ({
    default: ({ canEdit }) => <div data-testid="memory-panel" data-can-edit={String(canEdit)} />,
}));
vi.mock('../knowledge/CreateKBModal', () => ({ default: () => null }));

// The two child tabs are stubbed down to the props that matter here: what the
// page hands them, and the two callbacks whose failure paths the page owns.
vi.mock('./ProjectThreadsTab', () => ({
    default: ({ threads, loading, role, currentUserId, activeRuns, onUnshare }) => (
        <div
            data-testid="threads-tab"
            data-count={threads.length}
            data-loading={String(loading)}
            data-role={role}
            data-user={String(currentUserId)}
            data-running={Object.keys(activeRuns).join(',')}
        >
            <button onClick={() => onUnshare({ id: 'c1', type: 'direct' })}>unshare</button>
        </div>
    ),
}));
vi.mock('./ProjectResourcesTab', () => ({
    default: ({ resources, loading, onRemove }) => (
        <div data-testid="resources-tab" data-loading={String(loading)} data-payload={JSON.stringify(resources)}>
            <button onClick={() => onRemove('notebook', { id: 'n1' })}>remove</button>
        </div>
    ),
}));

const { default: ProjectDetailPage } = await import('./ProjectDetailPage');

const PROJECT = { id: 'p1', name: 'Onboarding', ownerId: 'u-owner', version: 1, role: 'owner' };
const USERS = [
    { id: 'u-owner', displayName: 'Tessa' },
    { id: 'u-anna', displayName: 'Anna' },
];

let calls;
let routes;

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (status, body) => ({ ok: false, status, json: async () => body });

function setRoutes(overrides = {}) {
    routes = {
        'GET /api/projects/p1': () => ok(PROJECT),
        'GET /auth/users': () => ok(USERS),
        'GET /auth/groups': () => ok([{ id: 'g-1', name: 'Support' }]),
        'GET /api/projects/p1/members': () => ok({ members: [] }),
        'GET /api/projects/p1/threads': () => ok({ threads: [] }),
        'GET /api/projects/p1/resources': () => ok({ notebooks: [], apps: [] }),
        'GET /api/projects/p1/activity?limit=50&offset=0': () => ok({ items: [], hasMore: false }),
        ...overrides,
    };
}

const urlsFor = (method) => calls.filter(c => c.method === method).map(c => c.url);
const countOf = (method, url) => urlsFor(method).filter(u => u === url).length;

beforeEach(() => {
    calls = [];
    streamOpts = null;
    setRoutes();
    globalThis.__authFetch = vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body });
        const handler = routes[`${method} ${url}`];
        return handler ? handler() : ok({});
    });
});

afterEach(() => { delete globalThis.__authFetch; });

async function openTab(tab, props = {}) {
    const view = render(<ProjectDetailPage projectId="p1" user={{ id: 'u-owner' }} {...props} />);
    await view.findByTestId('project-detail-page');
    if (tab) fireEvent.click(view.getByTestId(`project-tab-${tab}`));
    return view;
}

describe('which request each tab fires', () => {
    it('fetches nothing but the project, its members and the directory on mount', async () => {
        await openTab(null);
        expect(urlsFor('GET')).not.toContain('/api/projects/p1/threads');
        expect(urlsFor('GET')).not.toContain('/api/projects/p1/resources');
        expect(urlsFor('GET').some(u => u.includes('/activity'))).toBe(false);
    });

    it('loads the shared conversations when the Chats tab is opened', async () => {
        await openTab('threads');
        await waitFor(() => expect(urlsFor('GET')).toContain('/api/projects/p1/threads'));
    });

    it('loads the project content when the Content tab is opened', async () => {
        await openTab('resources');
        await waitFor(() => expect(urlsFor('GET')).toContain('/api/projects/p1/resources'));
    });

    it('loads the first page of activity when the Activity tab is opened', async () => {
        await openTab('activity');
        await waitFor(() => expect(urlsFor('GET')).toContain('/api/projects/p1/activity?limit=50&offset=0'));
    });

    it('re-reads the user directory when the Members tab is opened', async () => {
        const view = await openTab(null);
        const before = countOf('GET', '/auth/users');
        fireEvent.click(view.getByTestId('project-tab-members'));
        await waitFor(() => expect(countOf('GET', '/auth/users')).toBe(before + 1));
    });

    it('hands the loading flag to the Chats tab while its fetch is in flight', async () => {
        // The request is held open on purpose: let it settle inside the click and
        // the in-flight 'true' is over before anything can look at it, so the flag
        // could be dead and the test would still pass.
        let release;
        const inFlight = new Promise(resolve => { release = () => resolve(ok({ threads: [] })); });
        setRoutes({ 'GET /api/projects/p1/threads': () => inFlight });

        const view = await openTab('threads');
        const tab = await view.findByTestId('threads-tab');
        expect(tab.getAttribute('data-role')).toBe('owner');
        expect(tab.getAttribute('data-loading')).toBe('true');

        await act(async () => { release(); });
        await waitFor(() => expect(view.getByTestId('threads-tab').getAttribute('data-loading')).toBe('false'));
    });

    it('passes the resources payload straight through, nulls and all', async () => {
        setRoutes({ 'GET /api/projects/p1/resources': () => ok({ notebooks: null, apps: [] }) });
        const view = await openTab('resources');
        await waitFor(() => expect(JSON.parse(view.getByTestId('resources-tab').getAttribute('data-payload')))
            .toEqual({ notebooks: null, apps: [] }));
    });

    it('gives the memory panel the same edit right as the rest of the page', async () => {
        // Both sides, or the claim is not pinned: a page that hands the panel a
        // flat false is read-only for everyone, which is what the owner half
        // below catches.
        const owner = await openTab('memory');
        expect(owner.getByTestId('memory-panel').getAttribute('data-can-edit')).toBe('true');
        expect(owner.queryByText('You have view-only access to this project, so project memory is read-only.')).toBeNull();
        owner.unmount();

        setRoutes({ 'GET /api/projects/p1': () => ok({ ...PROJECT, role: 'viewer' }) });
        const viewer = await openTab('memory');
        expect(viewer.getByTestId('memory-panel').getAttribute('data-can-edit')).toBe('false');
        expect(viewer.getByText('You have view-only access to this project, so project memory is read-only.')).toBeTruthy();
    });
});

describe('the activity feed', () => {
    const withActivity = (items, hasMore = false) => setRoutes({
        'GET /api/projects/p1/activity?limit=50&offset=0': () => ok({ items, hasMore }),
    });

    it('says so plainly when nothing has happened yet', async () => {
        const view = await openTab('activity');
        expect(await view.findByText('No activity yet.')).toBeTruthy();
    });

    it('turns each known action into a sentence', async () => {
        withActivity([
            { id: 'a1', actorId: 'u-owner', action: 'project_created', createdAt: new Date().toISOString() },
            { id: 'a2', actorId: 'u-owner', action: 'project_updated', details: { changes: { name: 1, color: 1 } } },
            { id: 'a3', actorId: 'u-owner', action: 'member_added', targetType: 'user', targetId: 'u-anna', details: { role: 'editor' } },
            { id: 'a4', actorId: 'u-anna', action: 'member_removed', details: { selfLeave: true } },
            { id: 'a5', actorId: 'u-owner', action: 'member_role_changed', targetType: 'user', targetId: 'u-anna', details: { from: 'viewer', to: 'editor' } },
            { id: 'a6', actorId: 'u-owner', action: 'conversation_assigned' },
        ]);
        const view = await openTab('activity');
        expect(await view.findByText('Tessa created the project')).toBeTruthy();
        expect(view.getByText('Tessa updated name, color')).toBeTruthy();
        expect(view.getByText('Tessa invited Anna as editor')).toBeTruthy();
        expect(view.getByText('Anna left the project')).toBeTruthy();
        expect(view.getByText("Tessa changed Anna's role from viewer to editor")).toBeTruthy();
        expect(view.getByText('Tessa added a conversation')).toBeTruthy();
    });

    // wrat: an action the switch does not know is rendered as its raw database
    // verb, in quotes — approval.requested and run.finished both land here.
    // Hoort in stage PRJ-4 te veranderen.
    it('prints the raw action name for anything it has no sentence for', async () => {
        withActivity([{ id: 'a1', actorId: 'u-owner', action: 'approval.requested' }]);
        const view = await openTab('activity');
        expect(await view.findByText('Tessa did "approval.requested"')).toBeTruthy();
    });

    // wrat: the actor is resolved out of /auth/users, which a non-admin cannot
    // read — so an ordinary member sees a feed of "Someone" doing everything.
    // Hoort in stage PRJ-3 te veranderen (projectgescoopte namen).
    it('calls every actor "Someone" when the user directory is not readable', async () => {
        withActivity([{ id: 'a1', actorId: 'u-owner', action: 'project_created' }]);
        routes['GET /auth/users'] = () => bad(403, {});
        const view = await openTab('activity');
        expect(await view.findByText('Someone created the project')).toBeTruthy();
    });

    it('shortens an unresolvable subject to the first eight characters of its id', async () => {
        withActivity([{ id: 'a1', actorId: 'u-owner', action: 'member_added', targetType: 'user', targetId: 'abcdefghijklmnop' }]);
        const view = await openTab('activity');
        expect(await view.findByText('Tessa invited abcdefgh as viewer')).toBeTruthy();
    });

    it('offers Load more only when the server says there is more', async () => {
        withActivity([{ id: 'a1', actorId: 'u-owner', action: 'project_created' }], false);
        const view = await openTab('activity');
        await view.findByText('Tessa created the project');
        expect(view.queryByText('Load more')).toBeNull();
    });

    it('pages the next slice by offset, not by cursor', async () => {
        withActivity([{ id: 'a1', actorId: 'u-owner', action: 'project_created' }], true);
        routes['GET /api/projects/p1/activity?limit=50&offset=1'] = () => ok({
            items: [{ id: 'a2', actorId: 'u-owner', action: 'instructions_updated' }],
            hasMore: false,
        });
        const view = await openTab('activity');
        fireEvent.click(await view.findByText('Load more'));
        expect(await view.findByText('Tessa updated the project instructions')).toBeTruthy();
        expect(view.getByText('Tessa created the project')).toBeTruthy(); // appended, not replaced
        expect(view.queryByText('Load more')).toBeNull();
    });

    it('still understands a deployment that answers with a bare array', async () => {
        setRoutes({
            'GET /api/projects/p1/activity?limit=50&offset=0': () => ok([
                { id: 'a1', actorId: 'u-owner', action: 'project_created' },
            ]),
        });
        const view = await openTab('activity');
        expect(await view.findByText('Tessa created the project')).toBeTruthy();
    });
});


describe('the live feed', () => {
    it('subscribes to this project for the whole page, not just one tab', async () => {
        await openTab(null);
        expect(streamOpts.projectId).toBe('p1');
        expect(streamOpts.enabled).toBe(true);
    });

    it('subscribes to nothing while a project is still being created', async () => {
        render(<ProjectDetailPage projectId={null} user={{ id: 'u-owner' }} />);
        await waitFor(() => expect(streamOpts).not.toBeNull());
        expect(streamOpts.enabled).toBe(false);
        expect(streamOpts.projectId).toBeNull();
    });

    it('re-reads the members when someone is added', async () => {
        await openTab(null);
        const before = countOf('GET', '/api/projects/p1/members');
        act(() => streamOpts.onEvent('member_added', { targetId: 'u-anna' }));
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/members')).toBe(before + 1));
    });

    it('re-reads the shared conversations when a colleague shares one', async () => {
        await openTab(null);
        act(() => streamOpts.onEvent('thread_shared', { targetId: 'c1' }));
        await waitFor(() => expect(urlsFor('GET')).toContain('/api/projects/p1/threads'));
    });

    it('re-reads the content when a resource is filed in', async () => {
        await openTab(null);
        act(() => streamOpts.onEvent('resource_added', { targetId: 'n1' }));
        await waitFor(() => expect(urlsFor('GET')).toContain('/api/projects/p1/resources'));
    });

    it('refreshes the activity feed only while it is the tab on screen', async () => {
        const view = await openTab(null);
        act(() => streamOpts.onEvent('project_updated', {}));
        expect(urlsFor('GET').some(u => u.includes('/activity'))).toBe(false);

        fireEvent.click(view.getByTestId('project-tab-activity'));
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/activity?limit=50&offset=0')).toBe(1));
        act(() => streamOpts.onEvent('project_updated', {}));
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/activity?limit=50&offset=0')).toBe(2));
    });

    it('marks a conversation as answering while a run is in flight, and clears it after', async () => {
        const view = await openTab('threads');
        await view.findByTestId('threads-tab');
        act(() => streamOpts.onEvent('run.started', { targetId: 'c1' }));
        await waitFor(() => expect(view.getByTestId('threads-tab').getAttribute('data-running')).toBe('c1'));
        act(() => streamOpts.onEvent('run.finished', { targetId: 'c1' }));
        await waitFor(() => expect(view.getByTestId('threads-tab').getAttribute('data-running')).toBe(''));
    });

    it('ignores a run event that names no conversation', async () => {
        const view = await openTab('threads');
        await view.findByTestId('threads-tab');
        act(() => streamOpts.onEvent('run.started', {}));
        expect(view.getByTestId('threads-tab').getAttribute('data-running')).toBe('');
    });

    // wrat: nothing on the page reacts to a 'forbidden' frame — the stream stops
    // itself, but the member whose access was just revoked keeps looking at a
    // project they can no longer read. Hoort in stage PRJ-2 te veranderen.
    it('leaves the page exactly as it was when access is revoked mid-session', async () => {
        const view = await openTab(null);
        act(() => streamOpts.onEvent('forbidden', { reason: 'removed' }));
        expect(view.getByTestId('project-detail-page')).toBeTruthy();
        expect(view.getByText('Onboarding')).toBeTruthy();
    });
});

describe('the two child-tab actions the page owns', () => {
    it('unshares a conversation, then re-reads the list', async () => {
        const view = await openTab('threads');
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/threads')).toBe(1));
        fireEvent.click(await view.findByText('unshare'));
        await waitFor(() => expect(urlsFor('DELETE')).toContain('/api/projects/p1/threads/c1?type=direct'));
        // The re-read is the half nobody sees: the DELETE unfiles the
        // conversation, but without this second GET it stays on screen.
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/threads')).toBe(2));
    });

    it('surfaces a refused unshare in the page header', async () => {
        routes['DELETE /api/projects/p1/threads/c1?type=direct'] = () => bad(409, { error: 'Sign in with your key first.' });
        const view = await openTab('threads');
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/threads')).toBe(1));
        fireEvent.click(await view.findByText('unshare'));
        expect(await view.findByText('Sign in with your key first.')).toBeTruthy();
        // A refused unshare returns before the re-read: the list stays as it was.
        expect(countOf('GET', '/api/projects/p1/threads')).toBe(1);
    });

    it('detaches a resource with an explicit attach:false, then re-reads the tab', async () => {
        const view = await openTab('resources');
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/resources')).toBe(1));
        fireEvent.click(await view.findByText('remove'));
        await waitFor(() => expect(urlsFor('PUT')).toContain('/api/projects/p1/resources'));
        expect(JSON.parse(calls.find(c => c.method === 'PUT').body)).toEqual({
            kind: 'notebook', id: 'n1', attach: false,
        });
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/resources')).toBe(2));
    });

    it('surfaces a refused detach in the page header', async () => {
        routes['PUT /api/projects/p1/resources'] = () => bad(403, { error: 'Not yours to move.' });
        const view = await openTab('resources');
        fireEvent.click(await view.findByText('remove'));
        expect(await view.findByText('Not yours to move.')).toBeTruthy();
    });
});
