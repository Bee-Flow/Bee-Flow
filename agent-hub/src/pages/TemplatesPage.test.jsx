import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the Word-templates screen: the list (search, empty
 * states, rename, delete, download, upload), the AI-fill view (header,
 * parameters, tabs, instructions and knowledge settings, chat hand-off),
 * generation of the filled document, the auto fill-and-store on a JSON block
 * in the assistant's answer, and the background polling of a template that is
 * still being analysed. The chat engine and the heavy child panels are
 * stubbed; HTTP goes through a mocked authFetch/mutate.
 */

const api = vi.hoisted(() => ({ authFetch: vi.fn(), mutate: vi.fn() }));
vi.mock('../api/mutate', () => ({ API_BASE: '', authFetch: api.authFetch, mutate: api.mutate }));

const toastApi = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ toast: toastApi }));

const engine = vi.hoisted(() => ({
    state: { messages: [], isLoading: false },
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    lastArgs: null,
}));
vi.mock('../hooks/useChatEngine', () => ({
    default: (args) => {
        engine.lastArgs = args;
        return {
            messages: engine.state.messages,
            setMessages: engine.setMessages,
            isLoading: engine.state.isLoading,
            sendMessage: engine.sendMessage,
            stopGenerating: vi.fn(),
            retryMessage: vi.fn(),
            editAndRegenerate: vi.fn(),
        };
    },
}));

vi.mock('../components/chat/InputArea', () => ({
    default: ({ onSendMessage, input, setInput, selectedTier }) => (
        <div data-testid="input-area" data-tier={selectedTier}>
            <input aria-label="chat-input" value={input} onChange={e => setInput(e.target.value)} />
            <button onClick={() => onSendMessage('hello', [])}>send-stub</button>
        </div>
    ),
}));
vi.mock('../components/chat/MessageItem', () => ({
    default: ({ msg }) => <div data-testid="message-item">{msg.content}</div>,
}));
vi.mock('../components/knowledge/KnowledgePanel', () => ({
    default: ({ knowledgeBaseIds, onKnowledgeBaseIdsChange }) => (
        <div data-testid="knowledge-panel" data-ids={knowledgeBaseIds.join(',')}>
            <button onClick={() => onKnowledgeBaseIdsChange(['kb1'])}>kb-stub</button>
        </div>
    ),
}));
vi.mock('../components/meeting-picker/MeetingPicker', () => ({
    default: ({ value, onChange }) => (
        <div data-testid="meeting-picker" data-value={value.join(',')}>
            <button onClick={() => onChange(['n1', 'n2'])}>pick-notes</button>
        </div>
    ),
}));

import TemplatesPage from './TemplatesPage';

const json = (body, ok = true) => ({ ok, json: async () => body, blob: async () => new Blob(['x']) });

const T1 = { id: 't1', name: 'Contract', fileName: 'contract.docx', createdAt: '2026-01-01T00:00:00Z', parameters: ['client', { name: 'date', description: 'Start date' }], description: 'A contract', instructions: 'be formal', knowledgeBaseIds: [] };
const T2 = { id: 't2', name: 'Invoice', fileName: 'invoice.docx', createdAt: '2026-01-02T00:00:00Z', parameters: [], description: 'An invoice', instructions: '' };

let routes;
function setup(templates = [T1, T2]) {
    routes = { 'GET /api/templates': () => json({ templates }), 'GET /ai/config/chat-models': () => json({}) };
    api.authFetch.mockImplementation(async (url, opts) => {
        const key = `${opts?.method || 'GET'} ${url}`;
        const handler = routes[key];
        if (!handler) return json({}, false);
        return handler(url, opts);
    });
    api.mutate.mockResolvedValue({});
    const onBack = vi.fn();
    const utils = render(<TemplatesPage user={{ id: 'u' }} onBack={onBack} />);
    return { onBack, ...utils };
}

beforeEach(() => {
    vi.clearAllMocks();
    engine.state = { messages: [], isLoading: false };
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('TemplatesPage list view', () => {
    it('loads and renders the templates with their parameters', async () => {
        const { onBack } = setup();
        expect(await screen.findByText('Contract')).toBeTruthy();
        expect(screen.getByText('Invoice')).toBeTruthy();
        expect(screen.getByText('contract.docx')).toBeTruthy();
        expect(screen.getByText('client')).toBeTruthy();
        expect(screen.getByText('date').getAttribute('title')).toBe('Start date');
        expect(screen.getByText('Word Templates')).toBeTruthy();
        await userEvent.click(screen.getAllByRole('button')[0]);
        expect(onBack).toHaveBeenCalled();
    });

    it('filters by name or file name and shows the no-result state', async () => {
        setup();
        await screen.findByText('Contract');
        const search = screen.getByPlaceholderText('Search templates...');
        await userEvent.type(search, 'invoice');
        expect(screen.queryByText('Contract')).toBeNull();
        expect(screen.getByText('Invoice')).toBeTruthy();
        await userEvent.clear(search);
        await userEvent.type(search, 'zzz');
        expect(screen.getByText('No templates found')).toBeTruthy();
        expect(screen.getByText('Try a different search')).toBeTruthy();
    });

    it('shows the empty state with an upload button when there are no templates', async () => {
        setup([]);
        expect(await screen.findByText('No templates yet')).toBeTruthy();
        expect(screen.getByText('Upload Your First Template')).toBeTruthy();
    });

    it('renames through PUT and reloads the name in the field state', async () => {
        setup();
        await screen.findByText('Contract');
        routes['PUT /api/templates/t1'] = () => json({ template: { ...T1, name: 'Deal' } });
        await userEvent.click(screen.getAllByTitle('Rename')[0]);
        const input = screen.getByDisplayValue('Contract');
        await userEvent.clear(input);
        await userEvent.type(input, 'Deal{Enter}');
        await waitFor(() => {
            const put = api.authFetch.mock.calls.find(c => c[1]?.method === 'PUT');
            expect(put[0]).toBe('/api/templates/t1');
            expect(JSON.parse(put[1].body)).toEqual({ name: 'Deal' });
        });
        await waitFor(() => expect(screen.queryByDisplayValue('Deal')).toBeNull());
    });

    it('deletes after confirmation and removes the row', async () => {
        setup();
        await screen.findByText('Contract');
        routes['DELETE /api/templates/t1'] = () => json({});
        await userEvent.click(screen.getAllByTitle('Delete')[0]);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Delete this template?')).toBeTruthy();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(screen.queryByText('Contract')).toBeNull());
        expect(screen.getByText('Invoice')).toBeTruthy();
    });

    it('downloads the template file', async () => {
        setup();
        await screen.findByText('Contract');
        routes['GET /api/templates/t1/download'] = () => json({});
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        await userEvent.click(screen.getAllByTitle('Download')[0]);
        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    });

    it('rejects a non-docx upload', async () => {
        const { container } = setup();
        await screen.findByText('Contract');
        const input = container.querySelector('input[type="file"]');
        const bad = new File(['x'], 'a.pdf', { type: 'application/pdf' });
        await userEvent.upload(input, bad, { applyAccept: false });
        expect(toastApi.error).toHaveBeenCalledWith('Please select a .docx file');
    });

    it('uploads a docx, sends skipAutoParameterize when ticked and opens the new template', async () => {
        const { container } = setup();
        await screen.findByText('Contract');
        const fresh = { id: 't3', name: 'New', fileName: 'new.docx', parameters: ['a'], description: 'd', instructions: 'i' };
        routes['POST /api/templates/upload'] = () => json({ template: fresh });
        await userEvent.click(screen.getByLabelText('Skip AI detection'));
        const file = new File(['x'], 'New.docx');
        await userEvent.upload(container.querySelector('input[type="file"]'), file);
        expect(await screen.findByText('1 parameter · new.docx')).toBeTruthy();
        const post = api.authFetch.mock.calls.find(c => c[0] === '/api/templates/upload');
        expect(post[1].body.get('name')).toBe('New');
        expect(post[1].body.get('skipAutoParameterize')).toBe('true');
    });

    it('shows the server error of a failed upload', async () => {
        const { container } = setup();
        await screen.findByText('Contract');
        routes['POST /api/templates/upload'] = () => json({ error: 'too big' }, false);
        await userEvent.upload(container.querySelector('input[type="file"]'), new File(['x'], 'a.docx'));
        await waitFor(() => expect(toastApi.error).toHaveBeenCalledWith('too big'));
    });
});

describe('TemplatesPage fill view', () => {
    async function openFill(templates) {
        setup(templates);
        await screen.findByText('Contract');
        await userEvent.click(screen.getAllByText('Fill with AI')[0]);
        await screen.findByText('2 parameters · contract.docx');
    }

    it('opens with header, parameter chips, description, tier and empty chat', async () => {
        await openFill();
        expect(screen.getByText('{{client}}')).toBeTruthy();
        expect(screen.getByText('date: Start date')).toBeTruthy();
        expect(screen.getByText('A contract')).toBeTruthy();
        expect(screen.getByText('Fill this template with AI')).toBeTruthy();
        expect(screen.getByTestId('input-area').getAttribute('data-tier')).toBe('auto');
        expect(engine.lastArgs.directMode).toMatchObject({ enabled: true, modelTier: 'auto', customEndpoint: '/ai/chat/template/stream' });
        expect(engine.lastArgs.directMode.getExtraPayload()).toEqual({ templateId: 't1', meetingNoteIds: [] });
        expect(engine.setMessages).toHaveBeenCalledWith([]);
        expect(screen.getByText('Generate Document').closest('button').disabled).toBe(true);
    });

    it('fills the chat input from a suggestion and passes meeting notes to the payload', async () => {
        await openFill();
        await userEvent.click(screen.getByText('Help me fill this template'));
        expect(screen.getByLabelText('chat-input').value).toBe('Help me fill this template');
        await userEvent.click(screen.getByText('pick-notes'));
        expect(screen.getByText('2 selected')).toBeTruthy();
        expect(screen.getByText(/Meeting notes are loaded as context/)).toBeTruthy();
        expect(engine.lastArgs.directMode.getExtraPayload()).toEqual({ templateId: 't1', meetingNoteIds: ['n1', 'n2'] });
    });

    it('forwards a sent message to the chat engine', async () => {
        await openFill();
        await userEvent.click(screen.getByText('send-stub'));
        expect(engine.sendMessage).toHaveBeenCalledWith('hello', []);
    });

    it('renders chat messages without a parent', async () => {
        engine.state = { messages: [{ id: 'a', role: 'user', content: 'hi' }, { id: 'b', role: 'assistant', content: 'child', parentId: 'a' }], isLoading: false };
        await openFill();
        expect(screen.getAllByTestId('message-item').map(n => n.textContent)).toEqual(['hi']);
    });

    it('switches to settings: saves instructions on blur and persists knowledge base ids', async () => {
        await openFill();
        await userEvent.click(screen.getByText('Settings & Knowledge'));
        const ta = screen.getByDisplayValue('be formal');
        await userEvent.clear(ta);
        await userEvent.type(ta, 'be brief');
        await userEvent.tab();
        await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('/api/templates/t1', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ instructions: 'be brief' }) })));
        await userEvent.click(screen.getByText('kb-stub'));
        expect(screen.getByTestId('knowledge-panel').getAttribute('data-ids')).toBe('kb1');
        await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('/api/templates/t1', expect.objectContaining({ body: JSON.stringify({ knowledgeBaseIds: ['kb1'] }) })));
        await userEvent.click(screen.getByText('Chat'));
        expect(screen.getByTestId('input-area')).toBeTruthy();
    });

    it('toasts when saving instructions fails', async () => {
        await openFill();
        api.mutate.mockRejectedValueOnce(new Error('nope'));
        await userEvent.click(screen.getByText('Settings & Knowledge'));
        await userEvent.click(screen.getByDisplayValue('be formal'));
        await userEvent.tab();
        await waitFor(() => expect(toastApi.error).toHaveBeenCalledWith('nope'));
    });

    it('goes back to the list', async () => {
        await openFill();
        await userEvent.click(screen.getAllByRole('button')[0]);
        expect(await screen.findByText('Word Templates')).toBeTruthy();
    });

    it('asks the assistant for values when no JSON block exists yet', async () => {
        engine.state = { messages: [{ id: 'a', role: 'assistant', content: 'no json here' }], isLoading: false };
        await openFill();
        await userEvent.click(screen.getByText('Generate Document'));
        expect(engine.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Respond with a JSON code block'));
    });

    it('generates and downloads the filled document from the last JSON block', async () => {
        const block = '```json\n{"client":"Acme"}\n```';
        engine.state = { messages: [{ id: 'a', role: 'assistant', content: block }], isLoading: true };
        await openFill();
        engine.state = { messages: [{ id: 'a', role: 'assistant', content: block }], isLoading: false };
        routes['POST /api/templates/t1/fill'] = () => json({});
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        await userEvent.click(screen.getByText('Generate Document'));
        await waitFor(() => expect(click).toHaveBeenCalled());
        const post = api.authFetch.mock.calls.find(c => c[0] === '/api/templates/t1/fill');
        expect(JSON.parse(post[1].body)).toEqual({ values: { client: 'Acme' } });
    });

    it('toasts the server error when generating fails', async () => {
        const block = '```json\n{"client":"Acme"}\n```';
        engine.state = { messages: [{ id: 'a', role: 'assistant', content: block }], isLoading: true };
        await openFill();
        routes['POST /api/templates/t1/fill'] = () => json({ error: 'bad tpl' }, false);
        await userEvent.click(screen.getByText('Generate Document'));
        await waitFor(() => expect(toastApi.error).toHaveBeenCalledWith('bad tpl'));
    });

    it('auto-generates a document when the assistant ends with a JSON block', async () => {
        const block = '```json\n{"client":"Acme"}\n```';
        await openFill();
        routes['POST /api/templates/t1/fill-and-store'] = () => json({ downloadUrl: '/dl/f.docx', fileName: 'f.docx' });
        routes['GET /dl/f.docx'] = () => json({});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        engine.state = { messages: [{ id: 'a', role: 'assistant', content: block }], isLoading: false };
        // re-render by interacting
        await userEvent.click(screen.getByText('Settings & Knowledge'));
        await waitFor(() => expect(api.authFetch.mock.calls.some(c => c[0] === '/api/templates/t1/fill-and-store')).toBe(true));
        const post = api.authFetch.mock.calls.find(c => c[0] === '/api/templates/t1/fill-and-store');
        expect(JSON.parse(post[1].body)).toEqual({ values: { client: 'Acme' } });
        // first setMessages call appends the placeholder, a later one patches it
        const calls = engine.setMessages.mock.calls.map(c => c[0]).filter(f => typeof f === 'function');
        const placeholder = calls[0]([]);
        expect(placeholder[0]).toMatchObject({ role: 'assistant', isSystem: true, content: '⏳ Generating your document...' });
        await waitFor(() => expect(engine.setMessages.mock.calls.length).toBeGreaterThan(3));
        const patched = engine.setMessages.mock.calls.map(c => c[0]).filter(f => typeof f === 'function').pop()(placeholder);
        expect(patched[0].content).toContain('Download f.docx');
        expect(patched[0]._downloadUrl).toBe('/dl/f.docx');
    });

    it('does not auto-generate twice for the same message', async () => {
        const block = '```json\n{"client":"Acme"}\n```';
        await openFill();
        routes['POST /api/templates/t1/fill-and-store'] = () => json({}, false);
        engine.state = { messages: [{ id: 'a', role: 'assistant', content: block }], isLoading: false };
        await userEvent.click(screen.getByText('Settings & Knowledge'));
        await userEvent.click(screen.getByText('Chat'));
        await waitFor(() => expect(api.authFetch.mock.calls.filter(c => String(c[0]).endsWith('fill-and-store')).length).toBe(1));
    });
});

describe('TemplatesPage processing poll', () => {
    it('polls a template without parameters and description until it is analysed', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const raw = { id: 't9', name: 'Raw', fileName: 'raw.docx', createdAt: '2026-01-01T00:00:00Z', parameters: [], description: '' };
        setup([raw]);
        await screen.findByText('Raw');
        await userEvent.click(screen.getByText('Fill with AI'));
        expect(await screen.findByText('Detecting parameters...')).toBeTruthy();
        expect(screen.getByText('AI is processing your template...')).toBeTruthy();
        routes['GET /api/templates/t9'] = () => json({ template: { ...raw, parameters: ['x'], description: 'done', instructions: 'ins' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
        expect(await screen.findByText('1 parameter · raw.docx')).toBeTruthy();
        expect(screen.queryByText('AI is processing your template...')).toBeNull();
    });
});
