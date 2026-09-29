import { render, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * CHARACTERISATION — the Members tab of a project page (PRJ-0).
 *
 * Who is in a project, who may change that, and what the screen does when the
 * admin user directory is out of reach — which is the ordinary case, because a
 * plain member cannot read /auth/users. Split out of
 * ProjectDetailPage.tabs.test.jsx; the mock preamble is deliberately identical.
 */
vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

// The live feed has its own characterisation (hooks/useProjectStream.test.js).
vi.mock('../../hooks/useProjectStream', () => ({ default: () => {} }));
vi.mock('../../hooks/useKnowledgeBases', () => ({
    default: () => ({
        kbs: [], showCreateKB: false, selectedKB: null, kbDocs: [],
        kbInputMode: 'text', kbIngesting: false, kbIngestStatus: '',
        kbTextTitle: '', kbTextContent: '', kbUrlInput: '',
        openCreateKB: () => {}, setSelectedKB: () => {}, setKbInputMode: () => {},
    }),
}));
vi.mock('../knowledge/memory/MemoryPanel', () => ({ default: () => <div data-testid="memory-panel" /> }));
vi.mock('../knowledge/CreateKBModal', () => ({ default: () => null }));

// The sibling tabs are stubbed so this file mounts nothing but the members UI.
vi.mock('./ProjectThreadsTab', () => ({ default: () => <div data-testid="threads-tab" /> }));
vi.mock('./ProjectResourcesTab', () => ({ default: () => <div data-testid="resources-tab" /> }));

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
        ...overrides,
    };
}

const urlsFor = (method) => calls.filter(c => c.method === method).map(c => c.url);
const countOf = (method, url) => urlsFor(method).filter(u => u === url).length;

beforeEach(() => {
    calls = [];
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

describe('the member list', () => {
    const withMembers = (members) => setRoutes({
        'GET /api/projects/p1/members': () => ok({ members }),
    });

    it('names you as the owner when the directory cannot be read', async () => {
        routes['GET /auth/users'] = () => bad(403, {});
        const view = await openTab('members');
        expect(await view.findByText('You')).toBeTruthy();
    });

    it('says there are no members yet, and invites the owner to add some', async () => {
        const view = await openTab('members');
        expect(await view.findByText(/No members yet\./)).toBeTruthy();
        expect(view.getByText(/Invite people to collaborate\./)).toBeTruthy();
    });

    it('lists a member by their resolved name and marks you as yourself', async () => {
        withMembers([
            { id: 'm1', sharedWithType: 'user', sharedWithId: 'u-anna', permission: 'editor' },
            { id: 'm2', sharedWithType: 'user', sharedWithId: 'u-owner', permission: 'viewer' },
        ]);
        const view = await openTab('members');
        // "Anna" is also an option in the invite dropdown; the row is the span.
        const named = await view.findAllByText('Anna');
        expect(named.some(el => el.tagName === 'SPAN')).toBe(true);
        expect(view.getByText('(you)')).toBeTruthy();
        expect(view.getByText('Members (2)')).toBeTruthy();
    });

    // wrat: without the admin directory a member row shows the bare UUID it was
    // shared with. Hoort in stage PRJ-3 te veranderen.
    it('falls back to the raw id when the directory is out of reach', async () => {
        withMembers([{ id: 'm1', sharedWithType: 'user', sharedWithId: 'u-anna', permission: 'editor' }]);
        routes['GET /auth/users'] = () => bad(403, {});
        const view = await openTab('members');
        expect(await view.findByText('u-anna')).toBeTruthy();
    });

    it('lets the owner change a role, and PUTs it to the member', async () => {
        withMembers([{ id: 'm1', sharedWithType: 'user', sharedWithId: 'u-anna', permission: 'viewer' }]);
        const view = await openTab('members');
        await view.findAllByText('Anna');
        // The member's own role select is the last one on the page — the three
        // before it belong to the invite panel.
        const roleSelect = [...view.container.querySelectorAll('select')].at(-1);
        fireEvent.change(roleSelect, { target: { value: 'editor' } });
        await waitFor(() => expect(urlsFor('PUT')).toContain('/api/projects/p1/members/m1'));
        expect(JSON.parse(calls.find(c => c.method === 'PUT').body)).toEqual({ role: 'editor' });
    });

    it('removes a member, and re-reads the list afterwards', async () => {
        withMembers([{ id: 'm1', sharedWithType: 'user', sharedWithId: 'u-anna', permission: 'viewer' }]);
        const view = await openTab('members');
        await view.findAllByText('Anna');
        const before = countOf('GET', '/api/projects/p1/members');
        fireEvent.click(view.getByTitle('Remove member'));
        await waitFor(() => expect(urlsFor('DELETE')).toContain('/api/projects/p1/members/m1'));
        await waitFor(() => expect(countOf('GET', '/api/projects/p1/members')).toBe(before + 1));
    });

    it('shows a refused removal instead of swallowing it', async () => {
        withMembers([{ id: 'm1', sharedWithType: 'user', sharedWithId: 'u-anna', permission: 'viewer' }]);
        routes['DELETE /api/projects/p1/members/m1'] = () => bad(403, { error: 'Not allowed' });
        const view = await openTab('members');
        await view.findAllByText('Anna');
        fireEvent.click(view.getByTitle('Remove member'));
        expect(await view.findByText('Not allowed')).toBeTruthy();
    });

    it('offers a viewer the leave button on their own row, and no role select they can use', async () => {
        setRoutes({
            'GET /api/projects/p1': () => ok({ ...PROJECT, role: 'viewer' }),
            'GET /api/projects/p1/members': () => ok({
                members: [
                    { id: 'm1', sharedWithType: 'user', sharedWithId: 'u-owner', permission: 'viewer' },
                    { id: 'm2', sharedWithType: 'user', sharedWithId: 'u-anna', permission: 'editor' },
                ],
            }),
        });
        const view = await openTab('members');
        await view.findAllByText('Anna');
        expect(view.getByTitle('Leave project')).toBeTruthy();
        expect(view.queryByTitle('Remove member')).toBeNull();
        expect([...view.container.querySelectorAll('select')].every(s => s.disabled)).toBe(true);
    });
});

describe('inviting someone', () => {
    // A non-admin cannot read /auth/users, so the picker degrades to a free-text
    // id field. That is the branch most invites actually go through.
    const withoutDirectory = () => setRoutes({
        'GET /auth/users': () => bad(403, {}),
        'GET /auth/groups': () => bad(403, {}),
    });

    it('offers a real picker when the directory IS readable', async () => {
        const view = await openTab('members');
        expect(await view.findByText('Select user...')).toBeTruthy();
        expect(view.queryByPlaceholderText('User ID')).toBeNull();
    });

    it('degrades to a free-text id field when the directory is out of reach', async () => {
        withoutDirectory();
        const view = await openTab('members');
        expect(await view.findByPlaceholderText('User ID')).toBeTruthy();
    });

    it('swaps the field over to groups when the invite type changes', async () => {
        withoutDirectory();
        const view = await openTab('members');
        await view.findByPlaceholderText('User ID');
        const typeSelect = view.container.querySelectorAll('select')[0];
        fireEvent.change(typeSelect, { target: { value: 'group' } });
        expect(view.getByPlaceholderText('Group ID')).toBeTruthy();
    });

    it('refuses an id that is not a UUID without troubling the server', async () => {
        withoutDirectory();
        const view = await openTab('members');
        fireEvent.change(await view.findByPlaceholderText('User ID'), { target: { value: 'anna' } });
        fireEvent.click(view.getByText('Invite'));
        expect(await view.findByText('Invalid ID. Expected a UUID.')).toBeTruthy();
        expect(urlsFor('POST')).toEqual([]);
    });

    it('shares the project with a well-formed id', async () => {
        withoutDirectory();
        routes['POST /api/projects/p1/share'] = () => ok({ shares: [] });
        const view = await openTab('members');
        fireEvent.change(await view.findByPlaceholderText('User ID'), {
            target: { value: '11111111-2222-4333-8444-555555555555' },
        });
        fireEvent.click(view.getByText('Invite'));
        await waitFor(() => expect(urlsFor('POST')).toEqual(['/api/projects/p1/share']));
        expect(JSON.parse(calls.find(c => c.method === 'POST').body)).toEqual({
            sharedWithType: 'user',
            sharedWithId: '11111111-2222-4333-8444-555555555555',
            permission: 'viewer',
        });
    });

    it('repeats the server\'s reason when an invite is refused', async () => {
        withoutDirectory();
        routes['POST /api/projects/p1/share'] = () => bad(404, { error: 'No such user' });
        const view = await openTab('members');
        fireEvent.change(await view.findByPlaceholderText('User ID'), {
            target: { value: '11111111-2222-4333-8444-555555555555' },
        });
        fireEvent.click(view.getByText('Invite'));
        expect(await view.findByText('No such user')).toBeTruthy();
    });

    it('offers no invite panel at all to a non-owner', async () => {
        setRoutes({ 'GET /api/projects/p1': () => ok({ ...PROJECT, role: 'editor' }) });
        const view = await openTab('members');
        await view.findByText(/No members yet\./);
        expect(view.queryByText('Invite Member')).toBeNull();
    });
});
