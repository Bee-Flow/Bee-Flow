/**
 * One page, as its owner and as a colleague it was published to, against
 * canned server answers: the page rendered in the in-app preview (and how it
 * is fenced in), the sections each person gets, a builder turn that refreshes
 * the preview and stores the transcript, and a proposed plan approved.
 *
 * The chat feature's composer and transcript, the Library upload queue and
 * the automations list are stubbed: they have their own tests, and what is
 * checked here is what this screen sends and draws around them.
 */

import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { streamSse } from '@/core/api/sse';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders, testQueryClient } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { WebpageScreen } from './WebpageScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('expo-crypto', () => {
    let n = 0;
    return { randomUUID: () => `id-${(n += 1)}` };
});
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/sse', () => ({ streamSse: jest.fn() }));
jest.mock('@/features/chat', () => {
    const { Pressable: MockPressable, Text: MockText } = jest.requireActual('react-native');
    return {
        Composer: ({ onSend }: { onSend: (text: string, attachments: unknown[]) => void }) => (
            <MockPressable accessibilityRole="button" onPress={() => onSend('Add a menu', [])}>
                <MockText>Send</MockText>
            </MockPressable>
        ),
        ChatTranscript: ({ messages }: { messages: { id: string; content: string }[] }) => (
            <>
                {messages.map((m) => (
                    <MockText key={m.id}>{m.content}</MockText>
                ))}
            </>
        ),
        useTiers: () => ({ data: {} }),
        encodeAttachments: async (a: unknown[]) => a,
        toWire: () => [],
    };
});
jest.mock('@/features/knowledge', () => ({
    pickDocuments: jest.fn(async () => []),
    UploadQueue: () => null,
    useUploadQueue: () => ({
        items: [],
        add: jest.fn(),
        retry: jest.fn(),
        remove: jest.fn(),
        clearFinished: jest.fn(),
    }),
    useKnowledgeBases: () => ({ data: [], isLoading: false, isError: false }),
}));
jest.mock('@/features/automations', () => ({
    useAutomations: () => ({ data: [], isLoading: false, isError: false }),
}));

const PAGE = {
    id: 'wp1',
    userId: 'me',
    name: 'Launch',
    isPublished: false,
    htmlSize: 30,
    sourceCount: 1,
    settings: { framework: 'vanilla', runtime: 'light' },
};

/** GET /:id/draft-document's answer: the page as the server built it. */
function draftDoc(body: string) {
    return {
        status: 'ready',
        html: `<!DOCTYPE html><html><head><script>var TOKEN = "t";</script></head><body>${body}</body></html>`,
        framework: 'vanilla',
        runtime: 'light',
        updatedAt: null,
        buildError: null,
        expiresAt: Date.now() + 4 * 3600_000,
    };
}

const ANSWERS: Record<string, unknown> = {
    '/api/webpages/wp1': {
        webpage: PAGE,
        readOnly: false,
        files: { html: '<h1 class="hero">Launch</h1>', css: '', js: '' },
        extraFiles: [],
        chatMessages: [],
    },
    '/api/webpages/wp1/sources': {
        sources: [{ id: 's1', type: 'pdf', name: 'Brand.pdf', status: 'ready', wordCount: 900 }],
    },
    '/api/webpages/wp1/versions': {
        versions: [{ id: 'v1', seq: 4, summary: 'AI edit', source: 'ai' }],
        hasMore: false,
    },
    '/api/webpages/wp1/public-shares': { shares: [] },
    '/api/webpages/wp1/audience': {
        public: { on: false },
        columnGate: { tables: [{ datatableId: 't1', label: 'Leads', columns: ['name', 'email'], publicColumns: [] }] },
    },
    '/api/webpages/wp1/grants': { integrations: [], automations: [{ automationId: 'a1', label: 'Lead digest' }] },
    '/api/webpages/wp1/data-cards': { tables: [{ datatableId: 't1', name: 'Leads', rowCount: 12 }], automations: [] },
    '/api/webpages/wp1/bindings': { code: { scanned: true, calls: [] } },
    '/api/webpages/wp1/draft-document': draftDoc('<h1 class="hero">Launch</h1>'),
};

const sse = streamSse as jest.Mock;

function frames(list: [string, unknown][]) {
    return async function* () {
        for (const [event, data] of list) yield { event, data };
    };
}

let client: QueryClient | null = null;
afterEach(() => client?.clear());

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.put as jest.Mock).mockResolvedValue({ success: true });
});

async function renderPage(tab?: string) {
    client = testQueryClient();
    client.setDefaultOptions({ ...client.getDefaultOptions(), mutations: { retry: false, gcTime: Infinity } });
    await renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <WebpageScreen pageId="wp1" tab={tab} />
            </ConfirmProvider>
        </ToastProvider>,
        { queryClient: client },
    );
    await screen.findAllByText('Launch');
}

function webview() {
    return screen.getByTestId('webview').props as Record<string, unknown> & { source: { html: string } };
}

describe('WebpageScreen as the owner', () => {
    it('opens on the rendered page, sandboxed, with the other sections and no Code', async () => {
        await renderPage();
        for (const label of ['History', 'Data & links', 'Knowledge', 'Share', 'Settings', 'AI Chat']) {
            expect(screen.getByText(label)).toBeTruthy();
        }
        expect(screen.getAllByText('Preview').length).toBeGreaterThan(0);
        expect(screen.queryByText('Code')).toBeNull();
        expect(screen.queryByText('Build')).toBeNull();

        await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy());
        const props = webview();
        expect(props.source.html).toContain('sandbox="allow-scripts allow-forms"');
        expect(props.source.html).toContain('&lt;h1 class=&quot;hero&quot;&gt;Launch');
        expect(props.onMessage).toBeUndefined();
        expect(props.injectedJavaScript).toBeUndefined();
        expect(props.incognito).toBeUndefined();
        expect(props).toMatchObject({
            thirdPartyCookiesEnabled: false,
            allowFileAccess: false,
            mixedContentMode: 'never',
            setSupportMultipleWindows: false,
            domStorageEnabled: false,
        });
        const guard = props.onShouldStartLoadWithRequest as (e: { url: string; isTopFrame: boolean }) => boolean;
        expect(guard({ url: 'about:blank', isTopFrame: true })).toBe(true);
        expect(guard({ url: 'javascript:alert(1)', isTopFrame: false })).toBe(false);
    });

    it('sends a turn with the page’s files, refreshes the preview and stores the transcript', async () => {
        sse.mockImplementation(
            frames([
                ['content', { text: 'Added a menu grid.' }],
                ['webpage_doc_update', { file: 'html', content: '<h1 class="hero">Menu</h1>' }],
                ['done', {}],
            ]),
        );
        await renderPage();
        await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy());
        const before = ANSWERS['/api/webpages/wp1/draft-document'];
        ANSWERS['/api/webpages/wp1/draft-document'] = draftDoc('<h1 class="hero">Menu</h1>');
        try {
            await fireEvent.press(screen.getByText('Send'));
            await waitFor(() => expect(webview().source.html).toContain('&gt;Menu&lt;'));
        } finally {
            ANSWERS['/api/webpages/wp1/draft-document'] = before;
        }

        const [path, { body }] = sse.mock.calls[0];
        expect(path).toBe('/ai/chat/webpage/stream');
        expect(body).toMatchObject({
            webpageId: 'wp1',
            message: 'Add a menu',
            chatMode: 'auto',
            htmlContent: '<h1 class="hero">Launch</h1>',
            history: [],
        });
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/webpages/wp1/chat', {
                messages: [
                    expect.objectContaining({ role: 'user', content: 'Add a menu' }),
                    expect.objectContaining({ role: 'assistant', content: 'Added a menu grid.' }),
                ],
            }),
        );
        await fireEvent.press(screen.getByText('AI Chat'));
        expect(await screen.findByText('Added a menu grid.')).toBeTruthy();
    });

    it('holds a proposed plan until it is approved, then builds it', async () => {
        sse.mockImplementationOnce(
            frames([
                ['content', { text: 'Here is my plan.' }],
                [
                    'webpage_plan_proposed',
                    { planId: 'p1', plan: { title: 'Menu grid', summary: 'Six dishes', steps: [] } },
                ],
                ['done', {}],
            ]),
        ).mockImplementationOnce(
            frames([
                ['content', { text: 'Built it.' }],
                ['done', {}],
            ]),
        );
        await renderPage();
        await fireEvent.press(screen.getByText('AI Chat'));
        await fireEvent.press(screen.getByText('Propose first'));
        await fireEvent.press(screen.getByText('Send'));
        expect(await screen.findByText('Menu grid')).toBeTruthy();
        expect(sse.mock.calls[0][1].body.chatMode).toBe('ask');

        await fireEvent.press(screen.getByText('Approve & build'));
        expect(await screen.findByText('Built it.')).toBeTruthy();
        expect(sse.mock.calls[1][1].body.planExecution).toEqual({ planId: 'p1', action: 'execute' });
        expect(screen.queryByText('Approve & build')).toBeNull();
    });

    it('offers the example briefs on a page with nothing built yet', async () => {
        const answer = ANSWERS['/api/webpages/wp1'] as { webpage: object; files: object };
        ANSWERS['/api/webpages/wp1'] = {
            ...answer,
            webpage: { ...PAGE, htmlSize: 0 },
            files: { html: '', css: '', js: '' },
        };
        try {
            await renderPage();
            expect(screen.getByText('Describe a page, get a webpage')).toBeTruthy();
            expect(screen.queryByTestId('webview')).toBeNull();
        } finally {
            ANSWERS['/api/webpages/wp1'] = answer;
        }
    });

    it('shows a React page as the server built it, in the same sandboxed frame', async () => {
        const answer = ANSWERS['/api/webpages/wp1'] as { webpage: object };
        const doc = ANSWERS['/api/webpages/wp1/draft-document'];
        ANSWERS['/api/webpages/wp1'] = { ...answer, webpage: { ...PAGE, settings: { framework: 'react-mui' } } };
        ANSWERS['/api/webpages/wp1/draft-document'] = draftDoc('<div id="root"></div><script type="module">render()</script>');
        try {
            await renderPage();
            await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy());
            expect(api.get).toHaveBeenCalledWith('/api/webpages/wp1/draft-document', expect.anything());
            expect(webview().source.html).toContain('sandbox="allow-scripts allow-forms"');
            expect(webview().source.html).toContain('&lt;div id=&quot;root&quot;&gt;');
        } finally {
            ANSWERS['/api/webpages/wp1'] = answer;
            ANSWERS['/api/webpages/wp1/draft-document'] = doc;
        }
    });

    it('says why a React page did not build, instead of framing a blank page', async () => {
        const doc = ANSWERS['/api/webpages/wp1/draft-document'];
        ANSWERS['/api/webpages/wp1/draft-document'] = { status: 'build_error', html: null, buildError: 'Could not resolve "./Missing.jsx"' };
        try {
            await renderPage();
            expect(await screen.findByText('Build error')).toBeTruthy();
            expect(screen.getByText('Could not resolve "./Missing.jsx"')).toBeTruthy();
            expect(screen.queryByTestId('webview')).toBeNull();
        } finally {
            ANSWERS['/api/webpages/wp1/draft-document'] = doc;
        }
    });

    it('says why a full-runtime page that is not public has no preview, and never opens the Studio', async () => {
        const answer = ANSWERS['/api/webpages/wp1'] as { webpage: object };
        ANSWERS['/api/webpages/wp1'] = { ...answer, webpage: { ...PAGE, settings: { framework: 'react-mui', runtime: 'full' } } };
        try {
            await renderPage();
            expect(screen.getByText('No preview on the phone yet')).toBeTruthy();
            expect(screen.queryByTestId('webview')).toBeNull();
        } finally {
            ANSWERS['/api/webpages/wp1'] = answer;
        }
    });

    it('lists versions and saves a snapshot', async () => {
        (api.post as jest.Mock).mockResolvedValue({ success: true });
        await renderPage('history');
        expect(await screen.findByText('v4 · AI edit')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save snapshot'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/webpages/wp1/versions', {}));
    });
});

describe('WebpageScreen, the owner’s other sections', () => {
    it('makes the page public with the columns chosen', async () => {
        await renderPage('share');
        expect(await screen.findByText('On the open internet')).toBeTruthy();
        await fireEvent.press(await screen.findByText('Make public'));
        await fireEvent.press(screen.getByText('name'));
        const buttons = screen.getAllByText('Make public');
        await fireEvent.press(buttons[buttons.length - 1]!);
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/webpages/wp1/audience/public', {
                on: true,
                publicColumns: { t1: ['name'] },
                accessMode: 'unlisted',
                expiresAt: null,
            }),
        );
    });

    it('shows what the page is wired to', async () => {
        await renderPage('data');
        expect(await screen.findByText('Lead digest')).toBeTruthy();
        expect(screen.getByText('Leads')).toBeTruthy();
        expect(screen.getByText('The page makes no calls of its own to other sites.')).toBeTruthy();
    });

    it('saves the page’s details from Settings', async () => {
        await renderPage('settings');
        await fireEvent.changeText(screen.getByLabelText('Name'), 'Launch 2');
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/webpages/wp1', {
                name: 'Launch 2',
                description: '',
                instructions: '',
            }),
        );
        expect(screen.getByText('HTML, CSS and JavaScript')).toBeTruthy();
    });

    it('adds a web page to the page’s knowledge', async () => {
        (api.post as jest.Mock).mockResolvedValue({ success: true, source: { id: 's2' } });
        await renderPage('knowledge');
        await fireEvent.press(await screen.findByText('URL'));
        await fireEvent.changeText(screen.getByLabelText('Address'), 'https://example.com');
        await fireEvent.press(screen.getByText('Add to knowledge'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/webpages/wp1/sources/url', { url: 'https://example.com' }),
        );
    });
});

describe('WebpageScreen as a colleague it was published to', () => {
    it('shows the page and Share, with nothing to edit and no public address', async () => {
        ANSWERS['/api/webpages/wp1'] = { ...(ANSWERS['/api/webpages/wp1'] as object), readOnly: true };
        await renderPage('history');
        expect(screen.queryByText('History')).toBeNull();
        expect(screen.queryByText('AI Chat')).toBeNull();
        expect(screen.queryByText('Send')).toBeNull();
        expect(screen.getByText('Running shielded')).toBeTruthy();
        await waitFor(() => expect(screen.getByTestId('webview')).toBeTruthy());

        await fireEvent.press(screen.getByText('Share'));
        expect(await screen.findByText('Inside your organisation')).toBeTruthy();
        expect(screen.getByText('Someone else owns this page, so publishing is theirs to change.')).toBeTruthy();
        expect(screen.queryByText('On the open internet')).toBeNull();
    });
});
