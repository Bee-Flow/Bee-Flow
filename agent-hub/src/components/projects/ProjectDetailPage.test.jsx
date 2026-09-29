import { render, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * CHARACTERISATION — opening, creating and saving one project (PRJ-0).
 *
 * The detail page is the surface that talks to the server itself: it holds its
 * own authFetch calls rather than going through api/queries/projects.ts, so
 * this file pins WHICH requests leave, WHEN, and what the screen does with each
 * answer — including the two states a redesign quietly changes first, the
 * still-loading state and the could-not-load state.
 *
 * The live feed, the tabs and the member list are pinned in
 * ProjectDetailPage.tabs.test.jsx.
 */

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));
// The stream has its own characterisation (hooks/useProjectStream.test.js);
// here it must only stay out of the way.
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
vi.mock('../knowledge/CreateKBModal', () => ({ default: () => <div data-testid="create-kb-modal" /> }));
vi.mock('./ProjectThreadsTab', () => ({ default: () => <div data-testid="threads-tab" /> }));
vi.mock('./ProjectResourcesTab', () => ({ default: () => <div data-testid="resources-tab" /> }));

const { default: ProjectDetailPage } = await import('./ProjectDetailPage');

const PROJECT = {
    id: 'p1',
    name: 'Onboarding',
    description: 'Everything for new hires',
    customInstructions: 'Always answer in Dutch.',
    extractMemories: true,
    color: '#22c55e',
    icon: '🚀',
    knowledgeBaseIds: ['kb1'],
    ownerId: 'u-owner',
    version: 4,
    role: 'owner',
};

let calls;
let routes;

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const bad = (status, body) => ({ ok: false, status, json: async () => body });

function setRoutes(overrides = {}) {
    routes = {
        'GET /api/projects/p1': () => ok(PROJECT),
        'GET /auth/users': () => ok([]),
        'GET /auth/groups': () => ok([]),
        'GET /api/projects/p1/members': () => ok({ members: [] }),
        ...overrides,
    };
}

const urlsFor = (method) => calls.filter(c => c.method === method).map(c => c.url);
const bodyOf = (method, url) => JSON.parse(calls.find(c => c.method === method && c.url === url).body);

beforeEach(() => {
    calls = [];
    setRoutes();
    globalThis.__authFetch = vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body });
        const handler = routes[`${method} ${url}`];
        return handler ? handler() : ok({});
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
});

afterEach(() => {
    delete globalThis.__authFetch;
    vi.restoreAllMocks();
});

const renderPage = (props = {}) => render(
    <ProjectDetailPage projectId="p1" user={{ id: 'u-owner' }} {...props} />,
);

describe('opening a project', () => {
    it('says it is loading before anything is on screen', () => {
        const { getByText, queryByTestId } = renderPage();
        expect(getByText('Loading project…')).toBeTruthy();
        expect(queryByTestId('project-detail-page')).toBeNull();
    });

    it('asks the server for exactly this project', async () => {
        const { findByTestId } = renderPage();
        await findByTestId('project-detail-page');
        expect(urlsFor('GET')).toContain('/api/projects/p1');
    });

    it('also fetches the members and the user directory on mount', async () => {
        const { findByTestId } = renderPage();
        await findByTestId('project-detail-page');
        expect(urlsFor('GET')).toContain('/api/projects/p1/members');
        expect(urlsFor('GET')).toContain('/auth/users');
        expect(urlsFor('GET')).toContain('/auth/groups');
    });

    it('puts the name, the icon and your role in the header', async () => {
        const { findByText } = renderPage();
        const title = await findByText('Onboarding');
        // The header groups the icon tile, the (editable) name and the role pill.
        expect(title.parentElement.textContent).toContain('🚀');
        expect(title.parentElement.textContent).toContain('Owner');
    });

    it('fills the general form from the loaded project', async () => {
        const { findByDisplayValue, getByDisplayValue, getByLabelText } = renderPage();
        expect(await findByDisplayValue('Everything for new hires')).toBeTruthy();
        expect(getByDisplayValue('Always answer in Dutch.')).toBeTruthy();
        expect(getByLabelText('Green').getAttribute('aria-checked')).toBe('true');
        expect(getByLabelText('Rocket').getAttribute('aria-checked')).toBe('true');
    });

    it('shows the memories switch in the state the project was saved with', async () => {
        // Both saved states, or the claim is not pinned: a box that is simply
        // always ticked passes the on-case and loses the setting on the first
        // save a viewer of the off-case makes.
        const on = renderPage();
        await on.findByTestId('project-detail-page');
        expect(on.getByLabelText(/Extract Project Memories/).checked).toBe(true);
        on.unmount();

        setRoutes({ 'GET /api/projects/p1': () => ok({ ...PROJECT, extractMemories: false }) });
        const off = renderPage();
        await off.findByTestId('project-detail-page');
        expect(off.getByLabelText(/Extract Project Memories/).checked).toBe(false);
    });

    it('opens on General, and honours a tab named in the URL instead', async () => {
        const first = renderPage();
        await first.findByTestId('project-detail-page');
        expect(first.getByText('Description')).toBeTruthy();
        first.unmount();

        const second = renderPage({ initialTab: 'threads' });
        expect(await second.findByTestId('threads-tab')).toBeTruthy();
    });

    it('ignores a tab name the page does not have', async () => {
        const { findByText } = renderPage({ initialTab: 'nonsense' });
        expect(await findByText('Description')).toBeTruthy();
    });

    it('reports the tab back to the router when you switch', async () => {
        const onTabChange = vi.fn();
        const { findByTestId, getByTestId } = renderPage({ onTabChange });
        await findByTestId('project-detail-page');
        fireEvent.click(getByTestId('project-tab-activity'));
        expect(onTabChange).toHaveBeenCalledWith('activity');
    });
});

describe('when the project cannot be loaded', () => {
    it('says so instead of spinning forever', async () => {
        setRoutes({ 'GET /api/projects/p1': () => bad(500, {}) });
        const { findByText } = renderPage();
        expect(await findByText('Could not load project')).toBeTruthy();
    });

    it('surfaces a network failure with the thrown message', async () => {
        routes['GET /api/projects/p1'] = () => { throw new Error('offline'); };
        const { findByText } = renderPage();
        expect(await findByText('offline')).toBeTruthy();
    });

    // wrat: role state defaults to 'owner' and only a SUCCESSFUL load overwrites
    // it, so a project that failed to load presents itself as yours to edit —
    // Owner badge, editable colour swatches, a Danger tab that offers to delete
    // a project the page never managed to read. Hoort in stage PRJ-2 te
    // veranderen (rol uit de payload, niet uit een default).
    it('still claims you are the owner of a project it never managed to read', async () => {
        setRoutes({ 'GET /api/projects/p1': () => bad(500, {}) });
        const { findByText, getByText, getByTestId } = renderPage();
        await findByText('Could not load project');
        expect(getByText('Owner')).toBeTruthy();
        expect(getByTestId('project-tab-danger')).toBeTruthy();
    });

    it('falls back to "Untitled" in the header when nothing loaded', async () => {
        setRoutes({ 'GET /api/projects/p1': () => bad(404, {}) });
        const { findByText } = renderPage();
        expect(await findByText('Untitled')).toBeTruthy();
    });
});

describe('creating a project', () => {
    const renderCreate = (props = {}) => render(
        <ProjectDetailPage projectId={null} user={{ id: 'u-owner' }} {...props} />,
    );

    it('asks the server for nothing', async () => {
        const { findByTestId } = renderCreate();
        await findByTestId('project-detail-page');
        expect(urlsFor('GET')).not.toContain('/api/projects/null');
        expect(urlsFor('GET').some(u => u.startsWith('/api/projects/'))).toBe(false);
    });

    it('offers no tabs at all — just the form', async () => {
        const { findByTestId, queryByTestId } = renderCreate();
        await findByTestId('project-detail-page');
        expect(queryByTestId('project-tab-threads')).toBeNull();
        expect(queryByTestId('project-tab-danger')).toBeNull();
    });

    it('calls itself New Project and offers to create rather than save', async () => {
        const { findByText, getByTestId } = renderCreate();
        expect(await findByText('New Project')).toBeTruthy();
        expect(getByTestId('project-save-btn').textContent).toContain('Create Project');
    });

    // wrat: the name has no field of its own — the only way to type one is to
    // click the title in the header, which reads as a heading, not an input.
    // Hoort in stage PRJ-8/PRJ-10 te veranderen.
    it('hides the name behind the header title, which turns into an input when clicked', async () => {
        const { findByText, getByPlaceholderText } = renderCreate();
        fireEvent.click(await findByText('New Project'));
        expect(getByPlaceholderText('Project name')).toBeTruthy();
    });

    it('will not create until the project has a name', async () => {
        const { findByTestId, getByTestId, getByText, getByPlaceholderText } = renderCreate();
        await findByTestId('project-detail-page');
        expect(getByTestId('project-save-btn').disabled).toBe(true);
        fireEvent.click(getByText('New Project'));
        fireEvent.change(getByPlaceholderText('Project name'), { target: { value: 'Q3 launch' } });
        expect(getByTestId('project-save-btn').disabled).toBe(false);
    });

    it('POSTs the new project to the collection, with no version to echo', async () => {
        routes['POST /api/projects'] = () => ok({ ...PROJECT, id: 'p-new', name: 'Q3 launch' });
        const onSaved = vi.fn();
        const { findByText, getByTestId, getByPlaceholderText } = renderCreate({ onSaved });
        fireEvent.click(await findByText('New Project'));
        fireEvent.change(getByPlaceholderText('Project name'), { target: { value: 'Q3 launch' } });
        fireEvent.click(getByTestId('project-save-btn'));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(urlsFor('POST')).toEqual(['/api/projects']);
        const body = bodyOf('POST', '/api/projects');
        expect(body.name).toBe('Q3 launch');
        expect(body).not.toHaveProperty('version');
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-new' }));
    });

    it('trims the typed name before sending it', async () => {
        routes['POST /api/projects'] = () => ok({ id: 'p-new', name: 'Q3 launch' });
        const { findByText, getByTestId, getByPlaceholderText } = renderCreate({ onSaved: vi.fn() });
        fireEvent.click(await findByText('New Project'));
        fireEvent.change(getByPlaceholderText('Project name'), { target: { value: '  Q3 launch  ' } });
        fireEvent.click(getByTestId('project-save-btn'));
        await waitFor(() => expect(urlsFor('POST')).toHaveLength(1));
        expect(bodyOf('POST', '/api/projects').name).toBe('Q3 launch');
    });
});

describe('saving an existing project', () => {
    it('stays disabled until something actually changed', async () => {
        const { findByTestId, getByTestId } = renderPage();
        await findByTestId('project-detail-page');
        expect(getByTestId('project-save-btn').disabled).toBe(true);
    });

    it('announces unsaved changes as soon as a field is edited', async () => {
        const { findByDisplayValue, getByText, getByTestId } = renderPage();
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Changed' } });
        expect(getByText('Unsaved changes')).toBeTruthy();
        expect(getByTestId('project-save-btn').disabled).toBe(false);
    });

    it('PUTs the whole form back, with the loaded version echoed', async () => {
        routes['PUT /api/projects/p1'] = () => ok({ ...PROJECT, description: 'Changed', version: 5 });
        const onSaved = vi.fn();
        const { findByDisplayValue, getByTestId } = renderPage({ onSaved });
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Changed' } });
        fireEvent.click(getByTestId('project-save-btn'));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(urlsFor('PUT')).toEqual(['/api/projects/p1']);
        expect(bodyOf('PUT', '/api/projects/p1')).toEqual({
            name: 'Onboarding',
            description: 'Changed',
            customInstructions: 'Always answer in Dutch.',
            color: '#22c55e',
            icon: '🚀',
            knowledgeBaseIds: ['kb1'],
            extractMemories: true,
            version: 4,
        });
    });

    it('sends no version when the loaded project carried none', async () => {
        setRoutes({ 'GET /api/projects/p1': () => ok({ ...PROJECT, version: undefined }) });
        routes['PUT /api/projects/p1'] = () => ok(PROJECT);
        const { findByDisplayValue, getByTestId } = renderPage({ onSaved: vi.fn() });
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Changed' } });
        fireEvent.click(getByTestId('project-save-btn'));
        await waitFor(() => expect(urlsFor('PUT')).toHaveLength(1));
        expect(bodyOf('PUT', '/api/projects/p1')).not.toHaveProperty('version');
    });

    it('keeps your edits in the form when a colleague saved first', async () => {
        routes['PUT /api/projects/p1'] = () => bad(409, { error: 'Changed by Anna.' });
        const onSaved = vi.fn();
        const { findByDisplayValue, getByTestId, findByText, getByDisplayValue } = renderPage({ onSaved });
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Mine' } });
        fireEvent.click(getByTestId('project-save-btn'));

        expect(await findByText(/Changed by Anna\./)).toBeTruthy();
        expect(await findByText(/your edits are still in the form/)).toBeTruthy();
        expect(getByDisplayValue('Mine')).toBeTruthy();
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('repeats the server\'s reason when a save is refused', async () => {
        routes['PUT /api/projects/p1'] = () => bad(400, { error: 'Name too long' });
        const { findByDisplayValue, getByTestId, findByText } = renderPage();
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Changed' } });
        fireEvent.click(getByTestId('project-save-btn'));
        expect(await findByText('Name too long')).toBeTruthy();
    });

    it('falls back to a plain "Save failed" when the server explains nothing', async () => {
        routes['PUT /api/projects/p1'] = () => bad(500, {});
        const { findByDisplayValue, getByTestId, findByText } = renderPage();
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Changed' } });
        fireEvent.click(getByTestId('project-save-btn'));
        expect(await findByText('Save failed')).toBeTruthy();
    });

    it('clears the unsaved-changes marker once the save comes back', async () => {
        routes['PUT /api/projects/p1'] = () => ok({ ...PROJECT, description: 'Changed' });
        const { findByDisplayValue, getByTestId, queryByText } = renderPage({ onSaved: vi.fn() });
        fireEvent.change(await findByDisplayValue('Everything for new hires'), { target: { value: 'Changed' } });
        fireEvent.click(getByTestId('project-save-btn'));
        await waitFor(() => expect(queryByText('Unsaved changes')).toBeNull());
    });
});

describe('what each role may do on the page', () => {
    const asRole = (role) => setRoutes({ 'GET /api/projects/p1': () => ok({ ...PROJECT, role }) });

    it('gives an owner the save button and the danger tab', async () => {
        const { findByTestId, getByTestId } = renderPage();
        await findByTestId('project-detail-page');
        expect(getByTestId('project-save-btn')).toBeTruthy();
        expect(getByTestId('project-tab-danger')).toBeTruthy();
    });

    it('gives an editor the save button but no danger tab', async () => {
        asRole('editor');
        const { findByTestId, getByTestId, queryByTestId } = renderPage();
        await findByTestId('project-detail-page');
        expect(getByTestId('project-save-btn')).toBeTruthy();
        expect(queryByTestId('project-tab-danger')).toBeNull();
    });

    it('gives a viewer no way to save at all', async () => {
        asRole('viewer');
        const { findByTestId, queryByTestId } = renderPage();
        await findByTestId('project-detail-page');
        expect(queryByTestId('project-save-btn')).toBeNull();
        expect(queryByTestId('project-tab-danger')).toBeNull();
    });

    it('disables the fields for a viewer rather than hiding them', async () => {
        asRole('viewer');
        const { findByDisplayValue, getByLabelText } = renderPage();
        expect((await findByDisplayValue('Everything for new hires')).disabled).toBe(true);
        expect(getByLabelText('Indigo').disabled).toBe(true);
    });

    it('keeps a viewer from renaming the project through the header', async () => {
        asRole('viewer');
        const { findByText, queryByPlaceholderText } = renderPage();
        fireEvent.click(await findByText('Onboarding'));
        expect(queryByPlaceholderText('Project name')).toBeNull();
    });

    it('falls back to viewer when the payload names no role at all', async () => {
        setRoutes({ 'GET /api/projects/p1': () => ok({ ...PROJECT, role: undefined }) });
        const { findByText, queryByTestId } = renderPage();
        expect(await findByText('Viewer')).toBeTruthy();
        expect(queryByTestId('project-save-btn')).toBeNull();
    });
});

describe('deleting a project', () => {
    const openDanger = async () => {
        const view = renderPage({ onDeleted: vi.fn() });
        await view.findByTestId('project-detail-page');
        fireEvent.click(view.getByTestId('project-tab-danger'));
        return view;
    };

    it('warns that conversations survive the project', async () => {
        const { getByText } = await openDanger();
        expect(getByText('Conversations will be unassigned but not deleted. Members and activity history will be removed.')).toBeTruthy();
    });

    it('asks in the app\'s own dialog and sends nothing when you say no', async () => {
        const { getByRole, findByRole, getByTestId } = await openDanger();
        fireEvent.click(getByRole('button', { name: 'Delete Project' }));
        expect(await findByRole('dialog', { name: 'Delete this project?' })).toBeTruthy();
        expect(window.confirm).not.toHaveBeenCalled();
        fireEvent.click(getByTestId('confirm-dialog-cancel'));
        expect(urlsFor('DELETE')).toEqual([]);
    });

    it('deletes and tells the parent which project is gone', async () => {
        routes['DELETE /api/projects/p1'] = () => ok({});
        const onDeleted = vi.fn();
        const view = renderPage({ onDeleted });
        await view.findByTestId('project-detail-page');
        fireEvent.click(view.getByTestId('project-tab-danger'));
        fireEvent.click(view.getByRole('button', { name: 'Delete Project' }));
        fireEvent.click(await view.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(urlsFor('DELETE')).toEqual(['/api/projects/p1']));
        // The callback IS the second half of the claim: the request only removes
        // the row, the id is what makes the list behind this page drop the card.
        await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('p1'));
        expect(onDeleted).toHaveBeenCalledTimes(1);
    });

    // wrat: a refused DELETE is swallowed — no message, no state change, the
    // project simply stays. Only a thrown request sets an error. Hoort in stage
    // PRJ-2 te veranderen.
    it('says nothing at all when the server refuses the delete', async () => {
        routes['DELETE /api/projects/p1'] = () => bad(403, { error: 'Not allowed' });
        const onDeleted = vi.fn();
        const view = renderPage({ onDeleted });
        await view.findByTestId('project-detail-page');
        fireEvent.click(view.getByTestId('project-tab-danger'));
        fireEvent.click(view.getByRole('button', { name: 'Delete Project' }));
        fireEvent.click(await view.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(urlsFor('DELETE')).toHaveLength(1));
        expect(onDeleted).not.toHaveBeenCalled();
        expect(view.queryByText('Not allowed')).toBeNull();
    });
});

describe('leaving the page', () => {
    it('offers a back button only when the parent can handle it', async () => {
        const { findByTestId, queryByTitle } = renderPage();
        await findByTestId('project-detail-page');
        expect(queryByTitle('Back')).toBeNull();
    });

    it('calls back out when the back button is pressed', async () => {
        const onClose = vi.fn();
        const { findByTitle } = renderPage({ onClose });
        fireEvent.click(await findByTitle('Back'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
