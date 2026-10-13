/**
 * Characterisation tests for the Component Studio builder (ComponentBuilder).
 *
 * They pin the requests the builder sends (list, load, create, update,
 * delete one / a whole category, test run, save sample output), the bodies it
 * sends, the URL it keeps in `?component=` and what the screen shows
 * afterwards, so splitting the file into an API module, an editor hook and
 * panes cannot change any of it unnoticed.
 *
 * Run: cd agent-hub && npx vitest run src/components/admin/component-studio/ComponentBuilder.test.tsx
 */
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));
vi.mock('../../shared/Toast', () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
    default: function MonacoStub({ value, defaultLanguage }: { value?: string; defaultLanguage?: string }) {
        return <pre data-testid={`monaco-${defaultLanguage}`}>{value}</pre>;
    },
}));
vi.mock('./AIComponentDesigner', () => ({
    default: function AIStub({ onClose, onComponentCreated }: { onClose: () => void; onComponentCreated: (id: string) => void }) {
        return (
            <div data-testid="ai-designer">
                <button type="button" onClick={() => onComponentCreated('made-by-ai')}>ai-created</button>
                <button type="button" onClick={onClose}>ai-close</button>
            </div>
        );
    },
}));

import ComponentBuilder from './ComponentBuilder';
import { authFetch } from '../../../utils/helpers';
import { toast } from '../../shared/Toast';

type Call = { url: string; method: string; body: unknown };

const fetchMock = authFetch as unknown as ReturnType<typeof vi.fn>;
const toastError = toast.error as unknown as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as unknown as ReturnType<typeof vi.fn>;

const LIST = [
    { id: 'alpha', definition: { name: 'Alpha', category: 'Data', description: 'x'.repeat(70) } },
    { id: 'beta', definition: { name: 'Beta', category: 'AI tools', description: 'short' } },
    { id: 'gamma', definition: { name: 'Gamma', category: 'AI tools' } },
];

const ALPHA = {
    name: 'Alpha',
    description: 'desc',
    category: 'Data',
    inputs: {
        q: 'string',
        key: { type: 'string', secure: true, _hasStoredValue: true, description: 'api key' },
        n: { type: 'number', default: '5' },
    },
    outputs: { result: 'any' },
    dependencies: { lodash: '^4' },
    code: 'line1\nline2',
};

function json(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

let calls: Call[] = [];
let overrides: Record<string, () => unknown> = {};

function installFetch() {
    calls = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const method = init.method || 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
        const key = `${method} ${url}`;
        if (overrides[key]) return overrides[key]();
        if (key === 'GET /components') return json(LIST);
        if (key === 'GET /components/alpha') return json(ALPHA);
        if (key === 'GET /components/beta') return json({ name: 'Beta', category: 'AI tools' });
        if (method === 'DELETE') return json({ ok: true });
        if (method === 'PUT' || method === 'POST') return json({ ok: true });
        return json({});
    });
}

beforeEach(() => {
    overrides = {};
    installFetch();
    window.history.replaceState({}, '', '/admin/components');
});
afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    toastError.mockClear();
    toastSuccess.mockClear();
});

const listCalls = () => calls.filter(c => c.method === 'GET' && c.url === '/components').length;

async function renderLoaded() {
    const user = userEvent.setup();
    render(<ComponentBuilder onBack={() => {}} />);
    await screen.findByText('Alpha');
    return user;
}

async function openAlpha(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByText('Alpha'));
    await screen.findByDisplayValue('desc');
}

describe('ComponentBuilder — list', () => {
    it('loads /components once and groups by category, sorted, with a count per group', async () => {
        await renderLoaded();
        expect(calls[0]).toEqual({ url: '/components', method: 'GET', body: undefined });
        const headers = screen.getAllByText(/^(Data|AI tools)$/).map(el => el.textContent);
        expect(headers).toEqual(['AI tools', 'Data']);
        // description longer than 60 characters is cut with an ellipsis
        expect(screen.getByText('x'.repeat(60) + '…')).toBeTruthy();
        expect(screen.getByText('short')).toBeTruthy();
        expect(screen.getByText('Select or Create a Component')).toBeTruthy();
    });

    it('filters on name and category, and shows the empty text when nothing matches', async () => {
        const user = await renderLoaded();
        const search = screen.getByPlaceholderText('Search components...');
        await user.type(search, 'gam');
        expect(screen.queryByText('Alpha')).toBeNull();
        expect(screen.getByText('Gamma')).toBeTruthy();
        await user.clear(search);
        await user.type(search, 'data');
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.queryByText('Beta')).toBeNull();
        await user.type(search, 'zzz');
        expect(screen.getByText('No components found')).toBeTruthy();
    });

    it('collapses a category on a click of its header', async () => {
        const user = await renderLoaded();
        await user.click(screen.getByText('AI tools'));
        expect(screen.queryByText('Beta')).toBeNull();
        expect(screen.getByText('Alpha')).toBeTruthy();
        await user.click(screen.getByText('AI tools'));
        expect(screen.getByText('Beta')).toBeTruthy();
    });
});

describe('ComponentBuilder — load and save', () => {
    it('loads a component, fills the form and puts its id in the URL', async () => {
        const user = await renderLoaded();
        await openAlpha(user);
        expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['GET /components', 'GET /components/alpha']);
        expect(window.location.search).toBe('?component=alpha');
        expect((screen.getByPlaceholderText('my-component') as HTMLInputElement).value).toBe('alpha');
        expect((screen.getByPlaceholderText('my-component') as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByDisplayValue('Alpha')).toBeTruthy();
        expect(screen.getByDisplayValue('Data')).toBeTruthy();
        expect(screen.getByDisplayValue('q')).toBeTruthy();
        expect(screen.getByDisplayValue('key')).toBeTruthy();
        expect(screen.getByDisplayValue('api key')).toBeTruthy();
        expect(screen.getByPlaceholderText('••• stored')).toBeTruthy();
        expect(screen.getByDisplayValue('lodash')).toBeTruthy();
        expect(screen.getByDisplayValue('^4')).toBeTruthy();
        expect(screen.getByText('Danger Zone')).toBeTruthy();
        expect(screen.queryByText('Unsaved')).toBeNull();
    });

    it('selects the component named in ?component= on mount', async () => {
        window.history.replaceState({}, '', '/admin/components?component=alpha');
        render(<ComponentBuilder onBack={() => {}} />);
        await screen.findByDisplayValue('desc');
        expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['GET /components', 'GET /components/alpha']);
    });

    it('PUTs the serialised form and reloads the list on save', async () => {
        const user = await renderLoaded();
        await openAlpha(user);
        const name = screen.getByDisplayValue('Alpha');
        await user.clear(name);
        await user.type(name, 'Alpha 2');
        expect(screen.getByText('Unsaved')).toBeTruthy();
        await user.click(screen.getByTitle('Save component changes'));
        await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
        const put = calls.find(c => c.method === 'PUT')!;
        expect(put.url).toBe('/components/alpha');
        expect(put.body).toEqual({
            id: 'alpha',
            name: 'Alpha 2',
            description: 'desc',
            category: 'Data',
            inputs: {
                q: 'string',
                key: { type: 'string', description: 'api key', secure: true, _hasStoredValue: true },
                n: { type: 'number', default: '5' },
            },
            outputs: { result: 'any' },
            dependencies: { lodash: '^4' },
            code: 'line1\nline2',
            agentEnabled: true,
            directChatEnabled: false,
        });
        await waitFor(() => expect(listCalls()).toBe(2));
        expect(toastError).not.toHaveBeenCalled();
    });

    it('shows the server error from the body and keeps the form dirty', async () => {
        overrides['PUT /components/alpha'] = () => json({ error: 'nope' }, false, 400);
        const user = await renderLoaded();
        await openAlpha(user);
        await user.type(screen.getByDisplayValue('Alpha'), '!');
        await user.click(screen.getByTitle('Save component changes'));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('nope'));
        expect(screen.getByText('Unsaved')).toBeTruthy();
        expect(listCalls()).toBe(1);
    });

});

describe('ComponentBuilder — create and failures', () => {
    it('creates a new component: id check, name check, POST, then select it', async () => {
        const user = await renderLoaded();
        await user.click(screen.getByText('New'));
        expect(window.location.search).toBe('');
        expect(screen.getByDisplayValue('input')).toBeTruthy();
        expect(screen.queryByText('Danger Zone')).toBeNull();
        await user.click(screen.getByTitle('Save component changes'));
        expect(toastError).toHaveBeenLastCalledWith('Component ID must be lowercase letters, numbers, and hyphens only.');
        await user.type(screen.getByPlaceholderText('my-component'), 'My Thing');
        expect(screen.getByDisplayValue('my-thing')).toBeTruthy();
        await user.click(screen.getByTitle('Save component changes'));
        expect(toastError).toHaveBeenLastCalledWith('Component name is required.');
        expect(calls.some(c => c.method === 'POST')).toBe(false);
        await user.type(screen.getByPlaceholderText('My Component'), 'Thing');
        await user.click(screen.getByTitle('Save component changes'));
        await waitFor(() => expect(window.location.search).toBe('?component=my-thing'));
        const post = calls.find(c => c.method === 'POST')!;
        expect(post.url).toBe('/components');
        const body = post.body as Record<string, unknown>;
        expect(body).toMatchObject({
            id: 'my-thing',
            name: 'Thing',
            category: 'Custom',
            inputs: { input: 'string' },
            outputs: { output: 'any' },
            dependencies: {},
            agentEnabled: true,
            directChatEnabled: false,
        });
        expect(String(body.code)).toContain("process.stdin.on('end'");
        await waitFor(() => expect(screen.getByText('Danger Zone')).toBeTruthy());
    });

    it('a rejected request shows the save-failed toast', async () => {
        overrides['PUT /components/alpha'] = () => { throw new Error('offline'); };
        const user = await renderLoaded();
        await openAlpha(user);
        await user.click(screen.getByTitle('Save component changes'));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to save component: offline'));
    });
});

describe('ComponentBuilder — delete', () => {
    it('deletes the open component after confirm, reloads and resets to a new draft', async () => {
        const user = await renderLoaded();
        await openAlpha(user);
        await user.click(screen.getByText('Delete Component'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Delete "Alpha"?')).toBeTruthy();
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
        expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/components/alpha']);
        await waitFor(() => expect(listCalls()).toBe(2));
        expect(screen.getByDisplayValue('input')).toBeTruthy();
        expect(window.location.search).toBe('');
    });

    it('cancelling the confirm sends nothing', async () => {
        const user = await renderLoaded();
        await user.click(screen.getAllByTitle('Delete component')[0]);
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    });

    it('deletes one component from the list without opening it', async () => {
        const user = await renderLoaded();
        // list order: AI tools (Beta, Gamma) then Data (Alpha)
        await user.click(screen.getAllByTitle('Delete component')[0]);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Delete "Beta"?')).toBeTruthy();
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(listCalls()).toBe(2));
        expect(calls.filter(c => c.method === 'GET' && c.url.startsWith('/components/'))).toEqual([]);
        expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/components/beta']);
        expect(screen.getByText('Select or Create a Component')).toBeTruthy();
    });

    it('deletes a whole category one by one, in list order', async () => {
        const user = await renderLoaded();
        await user.click(screen.getByTitle('Delete all 2 components in AI tools'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Delete all 2 components in "AI tools"?')).toBeTruthy();
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(listCalls()).toBe(2));
        expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/components/beta', '/components/gamma']);
    });

    it('a refused delete shows the server error', async () => {
        overrides['DELETE /components/beta'] = () => json({ error: 'in use' }, false, 409);
        const user = await renderLoaded();
        await user.click(screen.getAllByTitle('Delete component')[0]);
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to delete component: in use'));
        expect(listCalls()).toBe(1);
    });
});

describe('ComponentBuilder — code and test tabs', () => {
    it('shows the code with its line count', async () => {
        const user = await renderLoaded();
        await openAlpha(user);
        await user.click(screen.getByRole('button', { name: 'index.js' }));
        expect(screen.getByText('2 lines')).toBeTruthy();
        expect((await screen.findByTestId('monaco-javascript')).textContent).toBe('line1\nline2');
    });

    it('runs a test with the default inputs and saves the result as sample output', async () => {
        overrides['POST /test-component'] = () => json({ total: 3, user: { name: 'a', tags: ['x'] }, list: [{ id: 1 }] });
        const user = await renderLoaded();
        await openAlpha(user);
        await user.click(screen.getByRole('button', { name: 'Test' }));
        expect(JSON.parse((await screen.findByTestId('monaco-json')).textContent!)).toEqual({ q: '', key: '', n: '5' });
        await user.click(screen.getByRole('button', { name: /Run Test/ }));
        await screen.findByText('Success');
        expect(calls.find(c => c.url === '/test-component')).toEqual({
            url: '/test-component',
            method: 'POST',
            body: { componentId: 'alpha', inputs: { q: '', key: '', n: '5' } },
        });
        await user.click(screen.getByTitle('Save as sample output'));
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Saved! Updated both sampleOutput and outputs schema.'));
        const put = calls.find(c => c.method === 'PUT')!;
        expect(put.url).toBe('/components/alpha');
        expect(put.body).toEqual({
            sampleOutput: { total: 3, user: { name: 'a', tags: ['x'] }, list: [{ id: 1 }] },
            outputs: { total: 'number', 'user.name': 'string', 'user.tags': 'array<string>', list: 'array<object>' },
        });
    });

    it('a refused sample save shows the server error', async () => {
        overrides['POST /test-component'] = () => json({ ok: 1 });
        overrides['PUT /components/alpha'] = () => json({ error: 'bad' }, false, 400);
        const user = await renderLoaded();
        await openAlpha(user);
        await user.click(screen.getByRole('button', { name: 'Test' }));
        await user.click(screen.getByRole('button', { name: /Run Test/ }));
        await screen.findByText('Success');
        await user.click(screen.getByTitle('Save as sample output'));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to save: bad'));
    });

    it('a failed run shows the error and no save button', async () => {
        overrides['POST /test-component'] = () => { throw new Error('boom'); };
        const user = await renderLoaded();
        await openAlpha(user);
        await user.click(screen.getByRole('button', { name: 'Test' }));
        await user.click(screen.getByRole('button', { name: /Run Test/ }));
        await screen.findByText('Error');
        expect(JSON.parse(screen.getAllByTestId('monaco-json')[1].textContent!)).toEqual({ error: 'boom' });
        expect(screen.queryByTitle('Save as sample output')).toBeNull();
    });

    it('a new draft cannot be run', async () => {
        const user = await renderLoaded();
        await user.click(screen.getByText('New'));
        await user.click(screen.getByRole('button', { name: 'Test' }));
        expect((screen.getByRole('button', { name: /Run Test/ }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('Save the component first to test it')).toBeTruthy();
    });
});

describe('ComponentBuilder — AI designer', () => {
    it('opens the designer, reloads the list when it creates one, and closes', async () => {
        const user = await renderLoaded();
        await user.click(screen.getByRole('button', { name: 'AI' }));
        expect(screen.getByTestId('ai-designer')).toBeTruthy();
        await user.click(screen.getByText('ai-created'));
        await waitFor(() => expect(listCalls()).toBe(2));
        expect(screen.getByTestId('ai-designer')).toBeTruthy();
        await user.click(screen.getByText('ai-close'));
        expect(screen.queryByTestId('ai-designer')).toBeNull();
    });
});
