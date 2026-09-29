import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * WebpagesPage — characterisation tests for the SAVE DISCIPLINE (Track W0).
 *
 * These pin the behaviour that must survive the list / editor / hook split:
 *   - opening a page never fires a phantom save (the loaded snapshot is
 *     "already saved"), and the persisted chat is not re-PUT;
 *   - manual edits debounce into ONE PUT carrying the full {html, css, js}
 *     snapshot; extras are PUT per path and a failed extra is re-queued;
 *   - Ctrl+S inside the IDE pane flushes immediately, outside it does not;
 *   - leaving the editor (back, ZIP) flushes pending edits FIRST;
 *   - leaving the editor aborts in-flight page-scoped mutations silently and
 *     a late response can never land on the page that is loaded next;
 *   - chat history is saved only after the assistant turn settles, "New chat"
 *     is one DELETE with no trailing PUT, a restored version is not re-saved.
 *
 * Everything below the page is mocked at its module boundary (useChatEngine,
 * WebpageIDE, WebpagePreview, the share/publish pickers, licensing) so the
 * tests exercise the page's own state machine and nothing else. The mocked
 * paths resolve to the same files after the split — vi.mock keys on the
 * resolved module, not on the importer.
 */

const BASE = 'https://host.example';

const state = vi.hoisted(() => ({
    engine: { opts: null, setLoading: null, setMessages: null },
    downloadZip: null,
}));

const authFetch = vi.fn();
vi.mock('../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

vi.mock('../hooks/useChatEngine', async () => {
    const React = await import('react');
    function useChatEngineMock(opts) {
            state.engine.opts = opts;
            const [messages, setMessages] = React.useState([]);
            const [isLoading, setIsLoading] = React.useState(false);
            state.engine.setLoading = setIsLoading;
            state.engine.setMessages = setMessages;
            return {
                messages,
                setMessages,
                isLoading,
                sendMessage: (text) => setMessages(prev => [...prev, { id: `u${prev.length}`, role: 'user', content: text }]),
                stopGenerating: () => {},
                retryMessage: () => {},
                editAndRegenerate: () => {},
            };
    }
    return { default: useChatEngineMock };
});

vi.mock('./webpages/WebpageIDE', async () => {
    const React = await import('react');
    return {
        default: (p) => React.createElement('div', { 'data-testid': 'ide' },
            React.createElement('textarea', {
                'data-testid': 'html', value: p.html, onChange: (e) => p.onHtmlChange(e.target.value),
            }),
            React.createElement('input', { 'data-testid': 'ide-input' }),
            React.createElement('div', { 'data-testid': 'save-state' }, p.saveState),
            React.createElement('div', { 'data-testid': 'dirty' }, Object.keys(p.dirtyFiles || {}).sort().join(',')),
            React.createElement('div', { 'data-testid': 'extra-files' }, (p.extraFiles || []).map(f => f.path).join(',')),
            React.createElement('div', { 'data-testid': 'extra-contents' }, Object.keys(p.extraContents || {}).join(',')),
            React.createElement('div', { 'data-testid': 'chat' }, (p.chatMessages || []).map(m => m.content).join('|')),
            React.createElement('button', { 'data-testid': 'edit-extra', onClick: () => p.onExtraChange('extra.css', 'body{color:red}') }),
            React.createElement('button', { 'data-testid': 'create-file', onClick: () => p.onCreateFile('notes.txt') }),
            React.createElement('button', { 'data-testid': 'upload', onClick: () => p.onUploadAsset(new File(['x'], 'pic.png', { type: 'image/png' })) }),
            React.createElement('button', { 'data-testid': 'send', onClick: () => p.onChatSend('hello', []) }),
            React.createElement('button', { 'data-testid': 'new-chat', onClick: () => p.onNewChat() }),
            React.createElement('button', { 'data-testid': 'versions', onClick: () => p.onVersionsClick() }),
            React.createElement('button', { 'data-testid': 'download', onClick: () => p.onDownload() }),
        ),
    };
});

vi.mock('./webpages/WebpagePreview', () => ({ default: () => null }));
vi.mock('../components/agents/AgentWizard/pickers/PublishMenu', () => ({ default: () => null }));
vi.mock('../components/agents/AgentWizard/pickers/ExternalShareSection', () => ({ default: () => null }));
vi.mock('../components/agents/AgentWizard/pickers/ShareLinksMenu', () => ({ default: () => null }));
vi.mock('../components/licensing/LicenseContext', () => ({ RequireTier: ({ children }) => children }));
vi.mock('../components/licensing/Gate', () => ({ useCan: () => true }));
vi.mock('../utils/downloadWebpageZip', () => ({
    default: (...args) => state.downloadZip(...args),
}));
vi.mock('../utils/imageResize', () => ({
    resizeImageForUpload: async (file) => ({ blob: file, mimeType: file.type }),
}));

import WebpagesPage from './WebpagesPage';

/* ── fixtures ─────────────────────────────────────────────────────────── */

const USER = { id: 'u1', organizationId: 'org1' };
const NOW = '2026-09-04T10:00:00.000Z';

function row(id, name) {
    return {
        id, name, userId: 'u1', updatedAt: NOW, htmlSize: 100, cssSize: 0, jsSize: 0,
        isPublished: false, sharedGroups: [], settings: {},
    };
}

const PAGES = [row('A', 'Page A'), row('B', 'Page B')];
const BUNDLES = {
    A: {
        webpage: PAGES[0], sources: [],
        files: { html: '<h1>A</h1>', css: '', js: '' },
        chatMessages: [{ id: 'm1', role: 'user', content: 'hi' }],
        extraFiles: [{ path: 'extra.css', mimeType: 'text/css' }],
    },
    B: {
        webpage: PAGES[1], sources: [],
        files: { html: '<h1>B</h1>', css: '', js: '' },
        chatMessages: [],
        extraFiles: [],
    },
};

/* ── fetch harness ────────────────────────────────────────────────────── */

const calls = [];
const overrides = [];

function respond(body, status = 200) {
    return { ok: status < 400, status, json: async () => body };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Route a request to an override (matched by method + regex) or the default table. */
function route(method, url, opts) {
    for (const o of overrides) {
        if (o.method === method && o.re.test(url)) return o.handler(opts, url);
    }
    const path = url.replace(BASE, '');
    if (path === '/auth/groups') return [];
    if (path === '/ai/config/chat-models') return {};
    if (method === 'GET' && path === '/api/webpages') return { webpages: PAGES };
    let m;
    if (method === 'GET' && (m = path.match(/^\/api\/webpages\/([^/?]+)$/))) return BUNDLES[m[1]];
    if (method === 'GET' && (m = path.match(/^\/api\/webpages\/([^/]+)\/files\?path=(.+)$/))) {
        return { content: `/* ${decodeURIComponent(m[2])} */` };
    }
    // "Wie gebruikt deze pagina" (W5) — de verwijderdialoog vraagt het vóór
    // hij iets vraagt.
    //
    // De standaard is de ECHTE standaard van de server, niet de prettige:
    // `complete` is er nooit waar en `unchecked` bevat altijd minstens `chat`
    // en `agent` (twee soorten hebben geen rij die ze kan beantwoorden — zie
    // server/core/webpages/webpageUsage.js). Een fixture met
    // `complete: true, unchecked: []` beschrijft een antwoord dat de route niet
    // kan geven, en liet de enige paginabrede verwijdertest door een scherm
    // lopen dat geen enkele gebruiker ooit ziet.
    if (method === 'GET' && /\/usage$/.test(path)) {
        return {
            usage: [],
            unchecked: ['chat', 'agent'],
            sources: {
                solution: { status: 'checked', found: 0 },
                automation: { status: 'checked', found: 0 },
                chat: { status: 'unavailable', found: null, reason: 'not-recorded' },
                agent: { status: 'unavailable', found: null, reason: 'not-recorded' },
            },
            complete: false,
        };
    }
    if (method === 'GET' && /\/versions/.test(path)) {
        return { versions: [{ id: 'v1', summary: 'Snapshot', createdAt: NOW, contentLength: 2048 }], hasMore: false };
    }
    if (method === 'POST' && /\/versions\/v1\/restore$/.test(path)) {
        return { files: { html: '<p>restored</p>', css: '', js: '' } };
    }
    if (method === 'PUT' && /\/files$/.test(path)) {
        const body = JSON.parse(opts.body);
        return { file: { path: body.path, mimeType: 'text/plain', isText: true } };
    }
    if (method === 'POST' && /\/assets$/.test(path)) {
        return { file: { path: 'assets/pic.png', mimeType: 'image/png' }, contentBase64: 'AAAA' };
    }
    if (method === 'PUT' || method === 'DELETE' || method === 'PATCH') return {};
    throw new Error(`unexpected fetch: ${method} ${url}`);
}

function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
        promise.then(resolve, reject);
    });
}

function override(method, re, handler) {
    overrides.unshift({ method, re, handler });
}

function callsTo(method, re) {
    return calls.filter(c => c.method === method && re.test(c.url));
}

function jsonBody(call) {
    return JSON.parse(call.opts.body);
}

/** Drain microtasks (and optionally the fake clock) inside act(). */
async function flush(ms = 0) {
    await act(async () => {
        if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 25; i++) await Promise.resolve();
    });
}

async function renderPage() {
    const utils = render(<WebpagesPage user={USER} embedded />);
    await flush();
    expect(screen.getByText('Page A')).toBeInTheDocument();
    return utils;
}

function cardOf(name) {
    return screen.getByText(name).closest('[aria-busy]');
}

async function openInEditor(name) {
    fireEvent.click(within(cardOf(name)).getByTitle('Edit in IDE'));
    await flush();
    expect(screen.getByTestId('ide')).toBeInTheDocument();
}

function typeHtml(value) {
    fireEvent.change(screen.getByTestId('html'), { target: { value } });
}

function backToList() {
    fireEvent.click(screen.getByTitle('Back to list'));
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(NOW));
    calls.length = 0;
    overrides.length = 0;
    state.engine = { opts: null, setLoading: null, setMessages: null };
    state.downloadZip = vi.fn(async () => {});
    authFetch.mockReset();
    authFetch.mockImplementation((url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        const call = { method, url: String(url), opts };
        calls.push(call);
        const p = Promise.resolve().then(() => route(method, call.url, opts)).then(body => {
            if (body && typeof body === 'object' && 'ok' in body && typeof body.json === 'function') return body;
            return respond(body);
        });
        return opts.signal ? abortable(p, opts.signal) : p;
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/* ── loading ──────────────────────────────────────────────────────────── */

describe('WebpagesPage — loading a page', () => {
    it('hydrates the editor from the bundle and fires no phantom save or chat PUT', async () => {
        await renderPage();
        await openInEditor('Page A');

        expect(screen.getByTestId('html')).toHaveValue('<h1>A</h1>');
        expect(screen.getByTestId('extra-files')).toHaveTextContent('extra.css');
        expect(screen.getByTestId('extra-contents')).toHaveTextContent('extra.css');
        expect(screen.getByTestId('chat')).toHaveTextContent('hi');
        expect(screen.getByTestId('dirty')).toHaveTextContent('');

        await flush(3000);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(0);
        expect(callsTo('PUT', /\/api\/webpages\/A\/chat$/)).toHaveLength(0);
        expect(screen.getByTestId('save-state')).toHaveTextContent('idle');
    });
});

/* ── debounced save ───────────────────────────────────────────────────── */

describe('WebpagesPage — debounced save', () => {
    it('coalesces rapid edits into ONE PUT carrying the full snapshot and marks the slot clean', async () => {
        await renderPage();
        await openInEditor('Page A');

        typeHtml('<h1>A1</h1>');
        typeHtml('<h1>A2</h1>');
        expect(screen.getByTestId('dirty')).toHaveTextContent('html');

        await flush(1000);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(0);

        await flush(600);
        const puts = callsTo('PUT', /\/api\/webpages\/A$/);
        expect(puts).toHaveLength(1);
        expect(jsonBody(puts[0])).toEqual({ html: '<h1>A2</h1>', css: '', js: '' });
        expect(screen.getByTestId('save-state')).toHaveTextContent('saved');
        expect(screen.getByTestId('dirty')).toHaveTextContent('');

        // Nothing changed since — a further debounce window must not PUT again.
        await flush(2000);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(1);
    });

    it('Ctrl+S flushes immediately only when focus is inside the IDE pane', async () => {
        await renderPage();
        await openInEditor('Page A');

        typeHtml('<h1>outside</h1>');
        document.body.focus();
        fireEvent.keyDown(window, { key: 's', ctrlKey: true });
        await flush();
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(0);

        screen.getByTestId('ide-input').focus();
        fireEvent.keyDown(window, { key: 's', ctrlKey: true });
        await flush();
        const puts = callsTo('PUT', /\/api\/webpages\/A$/);
        expect(puts).toHaveLength(1);
        expect(jsonBody(puts[0]).html).toBe('<h1>outside</h1>');

        // The debounce timer was cleared by the flush — no second PUT later.
        await flush(2000);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(1);
    });

    it('PUTs a dirty extra file per path and leaves the clean primary slots alone', async () => {
        await renderPage();
        await openInEditor('Page A');

        fireEvent.click(screen.getByTestId('edit-extra'));
        expect(screen.getByTestId('dirty')).toHaveTextContent('extra:extra.css');
        await flush(1600);

        const filePuts = callsTo('PUT', /\/api\/webpages\/A\/files$/);
        expect(filePuts).toHaveLength(1);
        expect(jsonBody(filePuts[0])).toEqual({ path: 'extra.css', content: 'body{color:red}' });
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(0);
        expect(screen.getByTestId('save-state')).toHaveTextContent('saved');
        expect(screen.getByTestId('dirty')).toHaveTextContent('');
    });

    it('re-queues a failed extra save and retries it on the next debounce', async () => {
        let fail = true;
        override('PUT', /\/api\/webpages\/A\/files$/, () => {
            if (fail) return respond({ error: 'boom' }, 500);
            return { file: { path: 'extra.css', mimeType: 'text/css', isText: true } };
        });
        await renderPage();
        await openInEditor('Page A');

        fireEvent.click(screen.getByTestId('edit-extra'));
        await flush(1600);
        expect(callsTo('PUT', /\/api\/webpages\/A\/files$/)).toHaveLength(1);
        expect(screen.getByTestId('save-state')).toHaveTextContent('error');
        expect(screen.getByTestId('dirty')).toHaveTextContent('extra:extra.css');

        fail = false;
        typeHtml('<h1>A3</h1>');
        await flush(1600);
        expect(callsTo('PUT', /\/api\/webpages\/A\/files$/)).toHaveLength(2);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(1);
        expect(screen.getByTestId('save-state')).toHaveTextContent('saved');
        expect(screen.getByTestId('dirty')).toHaveTextContent('');
    });

    it('a failed primary save still attempts the extras and reports error', async () => {
        override('PUT', /\/api\/webpages\/A$/, () => respond({ error: 'nope' }, 500));
        await renderPage();
        await openInEditor('Page A');

        typeHtml('<h1>A4</h1>');
        fireEvent.click(screen.getByTestId('edit-extra'));
        await flush(1600);

        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(1);
        expect(callsTo('PUT', /\/api\/webpages\/A\/files$/)).toHaveLength(1);
        expect(screen.getByTestId('save-state')).toHaveTextContent('error');
        // The extra was saved; the primary slot stays dirty for the next retry.
        expect(screen.getByTestId('dirty')).toHaveTextContent('html');
    });
});

/* ── leaving the page ─────────────────────────────────────────────────── */

describe('WebpagesPage — leaving the editor', () => {
    it('flushes pending edits before going back to the list', async () => {
        await renderPage();
        await openInEditor('Page A');

        typeHtml('<h1>bye</h1>');
        backToList();
        await flush();

        const puts = callsTo('PUT', /\/api\/webpages\/A$/);
        expect(puts).toHaveLength(1);
        expect(jsonBody(puts[0]).html).toBe('<h1>bye</h1>');
        expect(screen.getByText('Page A')).toBeInTheDocument();
        expect(screen.queryByTestId('ide')).not.toBeInTheDocument();
    });

    it('flushes before zipping so the ZIP matches what is saved', async () => {
        await renderPage();
        await openInEditor('Page A');

        typeHtml('<h1>zip</h1>');
        fireEvent.click(screen.getByTestId('download'));
        await flush();

        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(1);
        expect(state.downloadZip).toHaveBeenCalledTimes(1);
        expect(state.downloadZip.mock.calls[0][0]).toMatchObject({ name: 'Page A', html: '<h1>zip</h1>' });
        const putIndex = calls.findIndex(c => c.method === 'PUT' && /\/api\/webpages\/A$/.test(c.url));
        expect(putIndex).toBeGreaterThanOrEqual(0);
        await flush(2000);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(1);
    });

    it('aborts in-flight page-scoped mutations silently on leave', async () => {
        const pending = deferred();
        override('PUT', /\/api\/webpages\/A\/files$/, () => pending.promise);
        await renderPage();
        await openInEditor('Page A');

        fireEvent.click(screen.getByTestId('create-file'));
        fireEvent.click(screen.getByTestId('upload'));
        await flush();
        const filePut = callsTo('PUT', /\/api\/webpages\/A\/files$/)[0];
        const upload = callsTo('POST', /\/api\/webpages\/A\/assets$/)[0];
        expect(filePut.opts.signal).toBeDefined();
        expect(upload.opts.signal).toBeDefined();
        expect(filePut.opts.signal.aborted).toBe(false);

        // Switching to another page arms a fresh controller and aborts the
        // previous page's outstanding mutations. (Whether the abort already
        // fires on "back to list" is deliberately NOT pinned — the monolith
        // aborted only on the next load; a per-page editor may abort on
        // unmount. Both satisfy the contract below.)
        backToList();
        await flush();
        await openInEditor('Page B');
        expect(filePut.opts.signal.aborted).toBe(true);
        expect(upload.opts.signal.aborted).toBe(true);
        // AbortError is the switch cancelling on purpose — never an error banner.
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByTestId('html')).toHaveValue('<h1>B</h1>');
        expect(screen.getByTestId('extra-files')).toHaveTextContent('');
    });

    it('a late SSE file fetch cannot land on the page loaded next', async () => {
        const late = deferred();
        override('GET', /\/api\/webpages\/A\/files\?path=late\.js$/, () => late.promise);
        await renderPage();
        await openInEditor('Page A');

        await act(async () => {
            state.engine.opts.onWebpageExtraUpdate({ path: 'late.js', meta: { path: 'late.js', mimeType: 'text/javascript' } });
        });
        await flush();
        expect(screen.getByTestId('extra-files')).toHaveTextContent('extra.css,late.js');

        backToList();
        await flush();
        await openInEditor('Page B');
        expect(screen.getByTestId('html')).toHaveValue('<h1>B</h1>');

        late.resolve({ content: 'console.log(1)' });
        await flush();
        expect(screen.getByTestId('extra-contents')).toHaveTextContent('');
        expect(screen.getByTestId('extra-files')).toHaveTextContent('');
    });

    it('an uploaded asset lands in the extras of the page it was uploaded to', async () => {
        await renderPage();
        await openInEditor('Page A');

        fireEvent.click(screen.getByTestId('upload'));
        await flush();
        const upload = callsTo('POST', /\/api\/webpages\/A\/assets$/)[0];
        expect(upload.opts.body).toBeInstanceOf(FormData);
        expect(upload.opts.body.get('path')).toBe('assets/pic.png');
        expect(screen.getByTestId('extra-files')).toHaveTextContent('extra.css,assets/pic.png');
        expect(screen.getByTestId('extra-contents')).toHaveTextContent('extra.css,assets/pic.png');
    });
});

/* ── chat persistence ─────────────────────────────────────────────────── */

describe('WebpagesPage — chat persistence', () => {
    it('saves the chat only after the assistant turn settles', async () => {
        await renderPage();
        await openInEditor('Page A');

        await act(async () => { state.engine.setLoading(true); });
        fireEvent.click(screen.getByTestId('send'));
        expect(screen.getByTestId('chat')).toHaveTextContent('hi|hello');
        await flush(1500);
        expect(callsTo('PUT', /\/api\/webpages\/A\/chat$/)).toHaveLength(0);

        await act(async () => { state.engine.setLoading(false); });
        await flush(500);
        expect(callsTo('PUT', /\/api\/webpages\/A\/chat$/)).toHaveLength(0);
        await flush(400);
        const puts = callsTo('PUT', /\/api\/webpages\/A\/chat$/);
        expect(puts).toHaveLength(1);
        expect(jsonBody(puts[0]).messages.map(m => m.content)).toEqual(['hi', 'hello']);

        // Unchanged since — no second PUT.
        await flush(2000);
        expect(callsTo('PUT', /\/api\/webpages\/A\/chat$/)).toHaveLength(1);
    });

    it('"New chat" is one DELETE with no trailing PUT', async () => {
        await renderPage();
        await openInEditor('Page A');

        fireEvent.click(screen.getByTestId('new-chat'));
        await flush();
        expect(screen.getByTestId('chat')).toHaveTextContent('');
        expect(callsTo('DELETE', /\/api\/webpages\/A\/chat$/)).toHaveLength(1);

        await flush(2000);
        expect(callsTo('PUT', /\/api\/webpages\/A\/chat$/)).toHaveLength(0);
    });
});

/* ── versions ─────────────────────────────────────────────────────────── */

describe('WebpagesPage — versions', () => {
    it('restoring a version replaces the content without re-saving it', async () => {
        await renderPage();
        await openInEditor('Page A');

        fireEvent.click(screen.getByTestId('versions'));
        await flush();
        expect(callsTo('GET', /\/api\/webpages\/A\/versions$/)).toHaveLength(1);
        fireEvent.click(screen.getByText('Restore'));
        await flush();

        // W4 verving de kale window.confirm() door de gedeelde bevestigingsdialoog
        // (components/shared/useConfirm): een browserdialoog kan geen uitleg
        // dragen over WAT er wel en niet wordt teruggezet, en in een sandboxed
        // frame negeert de browser hem stilzwijgend. Bevestigen is dus een tweede
        // klik in de app, geen native venster.
        expect(window.confirm).not.toHaveBeenCalled();
        // getBy…, niet findBy…: deze suite draait op nepklokken, en waitFor zou
        // dan op een timer wachten die niemand vooruitzet.
        const dialog = screen.getByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
        await flush();

        expect(callsTo('POST', /\/api\/webpages\/A\/versions\/v1\/restore$/)).toHaveLength(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        // History is sinds W4 een TAB en geen overlay meer: je blijft er staan na
        // het terugzetten, precies zoals bij elke andere sectie. De code komt
        // terug in beeld via de Code-tab, niet doordat er iets sluit.
        fireEvent.click(screen.getByRole('radio', { name: /Code/ }));
        await flush();
        expect(screen.getByTestId('html')).toHaveValue('<p>restored</p>');

        await flush(3000);
        expect(callsTo('PUT', /\/api\/webpages\/A$/)).toHaveLength(0);
    });
});

/* ── list CRUD ────────────────────────────────────────────────────────── */

describe('WebpagesPage — list', () => {
    /**
     * W5 deel C verving de kale `confirm('Delete this webpage?')` door de
     * gedeelde verwijderdialoog. Een browservenster kan de lijst van wat er
     * aan deze pagina hangt niet dragen, en dat is precies de vraag die de
     * persoon moet beantwoorden voordat hij op rood drukt. Bevestigen is dus
     * een tweede klik IN de app, tegen een lijst die de server heeft geleverd.
     */
    it('deletes a page through the dialog — never through window.confirm', async () => {
        // Het pad dat IEDEREEN loopt: niets gevonden, twee soorten niet te
        // controleren, dus de waarschuwing, de naam, en pas op de tweede druk
        // een bevestigd verzoek. De server weigert de eerste met 409 — dat is
        // hier de gesimuleerde stand, en het is de normale stand.
        let seen = 0;
        override('DELETE', /\/api\/webpages\/B/, (opts, url) => {
            seen += 1;
            if (String(url).includes('confirm=1')) return { success: true };
            return respond({
                error: 'Could not check what uses this webpage', code: 'in_use',
                usage: [], unchecked: ['chat', 'agent'], complete: false,
            }, 409);
        });
        // `container` sluit het portaal van de dialoog uit, zodat "de kaart
        // staat er nog" niet per ongeluk de naam in de dialoogkop leest.
        const { container } = await renderPage();
        fireEvent.click(within(cardOf('Page B')).getByTitle('Delete'));
        await flush();

        expect(window.confirm).not.toHaveBeenCalled();
        // De dialoog vraagt het eerst aan de server, en zegt pas daarna iets.
        expect(callsTo('GET', /\/api\/webpages\/B\/usage$/)).toHaveLength(1);
        const dialog = screen.getByRole('dialog');
        // Geen "niets gebruikt dit": dat is de zin die deze stand niet mag
        // opleveren.
        expect(within(dialog).queryByTestId('danger-unused')).toBeNull();
        expect(within(dialog).getByTestId('danger-unchecked')).toBeInTheDocument();
        expect(within(dialog).getByTestId('webpage-delete-unchecked')).toBeInTheDocument();
        expect(callsTo('DELETE', /\/api\/webpages\/B/)).toHaveLength(0);

        // Eerste druk: de naam typen, en het verzoek gaat ONBEVESTIGD uit.
        fireEvent.change(within(dialog).getByLabelText(/type the name/i), { target: { value: 'Page B' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
        await flush();

        let dels = callsTo('DELETE', /\/api\/webpages\/B/);
        expect(dels).toHaveLength(1);
        expect(dels[0].url).toBe(`${BASE}/api/webpages/B`);
        expect(within(container).getByText('Page B')).toBeInTheDocument();

        // Tweede druk, ná de weigering: nu mét bevestiging.
        fireEvent.change(within(dialog).getByLabelText(/type the name/i), { target: { value: 'Page B' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
        await flush();

        dels = callsTo('DELETE', /\/api\/webpages\/B/);
        expect(dels).toHaveLength(2);
        expect(dels[1].url).toBe(`${BASE}/api/webpages/B?confirm=1`);
        expect(seen).toBe(2);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByText('Page B')).not.toBeInTheDocument();
        expect(screen.getByText('Page A')).toBeInTheDocument();
    });

    it('a 409 keeps the page: the server list comes back and the name is asked', async () => {
        override('DELETE', /\/api\/webpages\/B/, () => respond({
            code: 'in_use', error: 'This webpage is still in use', unchecked: ['agent'],
            usage: [{ kind: 'solution', id: 'proj-1', title: 'Offertes', role: 'contains', ownerId: 'u1' }],
        }, 409));
        // `container` sluit het portaal van de dialoog uit, zodat "de kaart
        // staat er nog" niet per ongeluk de naam in de dialoogkop leest.
        const { container } = await renderPage();
        fireEvent.click(within(cardOf('Page B')).getByTitle('Delete'));
        await flush();

        const dialog = screen.getByRole('dialog');
        // Twee soorten zijn niet te controleren, dus de naam is óók zonder
        // gevonden rijen verplicht: dit is de standaardstand van dit product.
        fireEvent.change(within(dialog).getByLabelText(/type the name/i), { target: { value: 'Page B' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
        await flush();

        // De lijst van de server staat er, de pagina staat er nog, en de naam
        // wordt opnieuw gevraagd — tegen die lijst, niet tegen een lege.
        expect(within(dialog).getByText('Offertes')).toBeInTheDocument();
        expect(within(container).getByText('Page B')).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Delete for good' })).toBeDisabled();
    });

    it('cancelling the dialog leaves the page alone', async () => {
        await renderPage();
        fireEvent.click(within(cardOf('Page B')).getByTitle('Delete'));
        await flush();

        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
        await flush();

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(callsTo('DELETE', /\/api\/webpages\/B/)).toHaveLength(0);
        expect(screen.getByText('Page B')).toBeInTheDocument();
    });


    it('creates a page by name and opens it', async () => {
        override('POST', /\/api\/webpages$/, (opts) => ({ webpage: { ...row('C', JSON.parse(opts.body).name) } }));
        override('GET', /\/api\/webpages\/C$/, () => ({
            webpage: row('C', 'Page C'), sources: [], files: { html: '', css: '', js: '' }, chatMessages: [], extraFiles: [],
        }));
        await renderPage();

        fireEvent.change(screen.getByPlaceholderText('New webpage name…'), { target: { value: '  Page C ' } });
        fireEvent.click(screen.getByText('Create'));
        await flush();

        const posts = callsTo('POST', /\/api\/webpages$/);
        expect(posts).toHaveLength(1);
        expect(jsonBody(posts[0])).toEqual({ name: 'Page C' });
        // Opened in view mode: the header shows the page, the IDE is not mounted.
        expect(screen.getByTitle('Back to list')).toBeInTheDocument();
        expect(screen.queryByTestId('ide')).not.toBeInTheDocument();
        await flush(2000);
        expect(callsTo('PUT', /\/api\/webpages\/C$/)).toHaveLength(0);
    });
});

/* ── deep links ───────────────────────────────────────────────────────── */

describe('WebpagesPage — deep link', () => {
    it('opens the page named in the URL, even one absent from the list (BFSF-187)', async () => {
        override('GET', /\/api\/webpages$/, () => ({ webpages: [] }));
        render(<WebpagesPage user={USER} embedded initialWebpageId="A" />);
        await flush();

        expect(callsTo('GET', /\/api\/webpages\/A$/)).toHaveLength(1);
        expect(screen.getByTitle('Back to list')).toBeInTheDocument();
    });

    it('treats studio/webpages/new as "show the create form", not as an id to fetch', async () => {
        render(<WebpagesPage user={USER} embedded initialWebpageId="new" />);
        await flush();

        // No GET /api/webpages/new — that 404s and used to paint an error
        // banner over the create form the launcher sent the user to.
        expect(callsTo('GET', /\/api\/webpages\/new$/)).toHaveLength(0);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByPlaceholderText('New webpage name…')).toBeInTheDocument();
        expect(screen.getByText('Page A')).toBeInTheDocument();
    });
});
