import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hooks a page that DRIVES the app builder needs (Studio Playbooks): a
 * brief the pane sends itself once at mount, a pinned tier, and the end of
 * the turn as the stream reported it. The second half covers the assistant's
 * work modes, ideas and questions.
 */

vi.mock('@/components/MarkdownRenderer', () => ({ default: ({ content }) => <div>{content}</div> }));
vi.mock('../studioAppsApi', () => {
    const api = { getBuilderSession: vi.fn() };
    return { studioAppsApi: api, default: api };
});
vi.mock('@/utils/helpers', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, authFetch: vi.fn() };
});
vi.mock('@/utils/imageResize', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, resizeImageForUpload: vi.fn(async () => { throw new Error('no canvas in jsdom'); }) };
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { authFetch } from '@/utils/helpers';
import scopedStorage, { setCurrentUser } from '@/utils/scopedStorage';
import BuilderChatPane, { canAutoSendApp } from './BuilderChatPane';
import { EditorChromeContext } from '../editor/EditorChromeContext';
import { AppEditorProvider, useAppEditor } from '../state/AppEditorContext';
import { BLANK_APP, KITCHEN_SINK } from '../state/sampleDefinitions';
import { studioAppsApi } from '../studioAppsApi';

const enc = new TextEncoder();
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sseResponse(events) {
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(events.join(''))); c.close(); } });
    return { ok: true, status: 200, body: stream };
}
const streamCalls = () => authFetch.mock.calls.filter(([u]) => String(u).includes('/builder/stream'));
const streamBody = (i) => JSON.parse(streamCalls()[i][1].body);

const ctxRef = { current: null };
function Probe() { const ctx = useAppEditor(); useEffect(() => { ctxRef.current = ctx; }); return null; }

function mountPane(props, streams) {
    let i = 0;
    authFetch.mockImplementation((url) => {
        if (String(url).includes('/data/tables')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ tables: [] }) });
        if (String(url).includes('/ai/config/tiers-for-user')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        return Promise.resolve(streams[Math.min(i++, streams.length - 1)]);
    });
    const chrome = { commitTurn: vi.fn(), markSaved: vi.fn(), publishBuildCue: vi.fn() };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (p) => (
        <QueryClientProvider client={qc}>
            <AppEditorProvider app={{ id: 'app-1', definition: KITCHEN_SINK, version: 3 }}>
                <EditorChromeContext.Provider value={chrome}>
                    <BuilderChatPane appId="app-1" {...p} />
                    <Probe />
                </EditorChromeContext.Provider>
            </AppEditorProvider>
        </QueryClientProvider>
    );
    const r = render(ui(props));
    return { ...r, rerenderWith: (p) => r.rerender(ui(p)), chrome };
}

beforeEach(() => {
    vi.clearAllMocks();
    setCurrentUser('u1');
    scopedStorage.removeItem?.('appBuilderTier');
    scopedStorage.removeItem?.('appBuilderWorkMode');
    scopedStorage.removeItem?.('appBuilderPlanLarge');
    const notFound = new Error('no session'); notFound.status = 404;
    studioAppsApi.getBuilderSession.mockRejectedValue(notFound);
});

describe('canAutoSendApp', () => {
    it('fires only for a non-empty brief on a fresh, idle pane', () => {
        expect(canAutoSendApp({ autoSend: 'Build it', messageCount: 0, busy: false })).toBe(true);
        expect(canAutoSendApp({ autoSend: 'Build it', messageCount: 2, busy: false })).toBe(false);
        expect(canAutoSendApp({ autoSend: 'Build it', messageCount: 0, busy: true })).toBe(false);
        expect(canAutoSendApp({ autoSend: '  ', messageCount: 0, busy: false })).toBe(false);
        expect(canAutoSendApp({ autoSend: null, messageCount: 0, busy: false })).toBe(false);
    });
});

describe('BuilderChatPane — autoSend / forcedTier / onTurnEnd', () => {
    it('sends the brief exactly once at mount with planMode never and the pinned tier, never touches the tier preference, and reports the turn end', async () => {
        const onTurnEnd = vi.fn();
        const { rerenderWith } = mountPane(
            { autoSend: 'Build a Dutch invoice app on my table "Facturen".', forcedTier: 'fast', onTurnEnd },
            [sseResponse([
                sse('builder_session', { sessionId: 'as-1', appId: 'app-1' }),
                sse('message', { content: 'Done.' }),
                sse('done', { appId: 'app-1', finalized: true }),
            ])],
        );
        await waitFor(() => expect(streamCalls().length).toBe(1));
        expect(streamBody(0)).toMatchObject({ message: 'Build a Dutch invoice app on my table "Facturen".', modelTier: 'fast', planMode: 'never', appId: 'app-1' });
        // A host's brief carries no work mode: today's behaviour.
        expect(streamBody(0)).not.toHaveProperty('workMode');
        await waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1));
        expect(onTurnEnd.mock.calls[0][0]).toEqual({ finalized: true, stopped: false, awaitingPlan: false, error: null, code: null });
        // Re-renders (same props) never fire it again.
        rerenderWith({ autoSend: 'Build a Dutch invoice app on my table "Facturen".', forcedTier: 'fast', onTurnEnd });
        await waitFor(() => expect(ctxRef.current.streamLock).toBe(false));
        expect(streamCalls().length).toBe(1);
        expect(scopedStorage.getItem('appBuilderTier')).not.toBe('fast');
        // The brief is in the transcript as the user's turn.
        expect(screen.getByText('Build a Dutch invoice app on my table "Facturen".')).toBeInTheDocument();
    });

    it('a stream error ends the turn with the error and its code', async () => {
        const onTurnEnd = vi.fn();
        mountPane(
            { autoSend: 'Build it', onTurnEnd },
            [sseResponse([
                sse('builder_session', { sessionId: 'as-2', appId: 'app-1' }),
                sse('error', { message: 'The model gave up.', code: 'model_empty_reply' }),
            ])],
        );
        await waitFor(() => expect(onTurnEnd).toHaveBeenCalledTimes(1));
        expect(onTurnEnd.mock.calls[0][0]).toMatchObject({ finalized: false, error: 'The model gave up.', code: 'model_empty_reply' });
    });

    it('without autoSend nothing is sent; initialPrompt only prefills', async () => {
        mountPane({ initialPrompt: 'Prefilled' }, [sseResponse([sse('done', { appId: 'app-1', finalized: false })])]);
        expect(screen.getByLabelText('Message the AI builder').value).toBe('Prefilled');
        await new Promise((r) => setTimeout(r, 50));
        expect(streamCalls().length).toBe(0);
    });

    it('a pinned-tier mount keeps today\'s typed turn: no workMode, no planMode, and no mode picker', async () => {
        const user = userEvent.setup();
        mountPane({ forcedTier: 'fast' }, [sseResponse([sse('done', { appId: 'app-1', finalized: false })])]);
        expect(screen.queryByRole('button', { name: /change it right away/i })).not.toBeInTheDocument();
        await user.type(screen.getByLabelText('Message the AI builder'), 'Add a footer{Enter}');
        await waitFor(() => expect(streamCalls().length).toBe(1));
        expect(streamBody(0)).not.toHaveProperty('workMode');
        expect(streamBody(0)).not.toHaveProperty('planMode');
    });
});

/** SSE body that emits `first`, waits for release(), then emits `second`. */
function gatedStream(first, second) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const stream = new ReadableStream({
        async start(controller) {
            controller.enqueue(enc.encode(first.join('')));
            await gate;
            controller.enqueue(enc.encode(second.join('')));
            controller.close();
        },
    });
    return { stream, release: () => release() };
}

// The pane fetches /ai/config/tiers-for-user on mount (model tier selector),
// so order-based once-mocks would be consumed by the tier fetch. Route by URL
// instead: tier calls get an empty tier list; /builder/stream calls are served
// `streams` in order (the last one repeats).
function mockAuthFetchStreams(...streams) {
    let i = 0;
    authFetch.mockImplementation((url) => {
        if (String(url).includes('/data/tables')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ tables: [] }) });
        if (String(url).includes('/ai/config/tiers-for-user')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        }
        return Promise.resolve(streams[Math.min(i++, streams.length - 1)]);
    });
}

function renderPane({ chrome, queryClient, onAppUpdated, definition } = {}) {
    const c = chrome || { commitTurn: vi.fn(), markSaved: vi.fn() };
    const qc = queryClient || new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={qc}>
            <AppEditorProvider app={{ id: 'app-1', definition: definition || KITCHEN_SINK, version: 3 }}>
                <EditorChromeContext.Provider value={c}>
                    <BuilderChatPane appId="app-1" onAppUpdated={onAppUpdated || null} />
                    <Probe />
                </EditorChromeContext.Provider>
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    return c;
}

async function sendMessage(text) {
    const user = userEvent.setup();
    const textarea = screen.getByLabelText('Message the AI builder');
    await user.clear(textarea);
    await user.type(textarea, text);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    // The turn waits for the pre-turn flush, so the request (and the lock that
    // rides with it) lands a microtask later — resolve once it is really away.
    await waitFor(() => expect(streamCalls().length).toBeGreaterThan(0));
    return textarea;
}

describe('BuilderChatPane — work modes, ideas and questions', () => {
    it('an idea click sends a small targeted ask: workMode build + planMode never, whatever the chosen mode', async () => {
        const user = userEvent.setup();
        scopedStorage.setItem('appBuilderWorkMode', 'describe');
        authFetch.mockResolvedValue(sseResponse([sse('done', { appId: 'app-1', finalized: true })]));
        renderPane({ chrome: { flush: vi.fn().mockResolvedValue(), commitTurn: vi.fn(), markSaved: vi.fn() } });

        await user.click((await screen.findAllByTestId('app-assistant-idea'))[0]);

        await waitFor(() => expect(streamCalls().length).toBe(1));
        expect(JSON.parse(streamCalls()[0][1].body)).toMatchObject({ workMode: 'build', planMode: 'never' });
    });

    it('an example brief on the blank app is sent in the chosen mode', async () => {
        const user = userEvent.setup();
        authFetch.mockResolvedValue(sseResponse([sse('done', { appId: 'app-1', finalized: false })]));
        renderPane({ definition: BLANK_APP });

        await user.click(screen.getByTestId('app-assistant-ask-first'));
        expect(screen.getByTestId('app-assistant-ask-first-on')).toBeInTheDocument();
        await user.click(screen.getAllByTestId('app-assistant-example-brief')[0]);

        await waitFor(() => expect(streamCalls().length).toBe(1));
        expect(JSON.parse(streamCalls()[0][1].body)).toMatchObject({ workMode: 'describe', planMode: 'always' });
    });

    it('Fix all asks for every validation error to be repaired, as a small ask', async () => {
        const user = userEvent.setup();
        mockAuthFetchStreams(
            sseResponse([
                sse('validation_errors', { errors: [{ message: 'Broken binding', hint: 'Pick a table.' }], warnings: [] }),
                sse('done', { appId: 'app-1', finalized: false }),
            ]),
            sseResponse([sse('done', { appId: 'app-1', finalized: true })]),
        );
        renderPane({ chrome: { flush: vi.fn().mockResolvedValue(), commitTurn: vi.fn(), markSaved: vi.fn() } });
        await sendMessage('Build something');
        await waitFor(() => expect(ctxRef.current.streamLock).toBe(false));

        await user.click(await screen.findByRole('button', { name: 'Fix all' }));

        await waitFor(() => expect(streamCalls().length).toBe(2));
        const body = JSON.parse(streamCalls()[1][1].body);
        expect(body.message).toMatch(/^Fix the validation errors/);
        expect(body).toMatchObject({ workMode: 'build', planMode: 'never' });
    });

    // ── Work modes ───────────────────────────────────────────────────
    const modeCases = [
        ['describe', true, 'always'],
        ['plan', true, 'always'],
        ['discuss', true, 'never'],
        ['build', true, 'auto'],
        ['build', false, 'never'],
    ];
    it.each(modeCases)('mode %s (check big changes: %s) sends planMode %s', async (mode, large, planMode) => {
        scopedStorage.setItem('appBuilderWorkMode', mode);
        scopedStorage.setItem('appBuilderPlanLarge', String(large));
        authFetch.mockResolvedValue(sseResponse([sse('done', { appId: 'app-1', finalized: false })]));
        renderPane();
        await sendMessage('Add a button');
        expect(JSON.parse(streamCalls()[0][1].body)).toMatchObject({ workMode: mode, planMode });
    });

    it('defaults to "Change it right away" with the big-change check on, and remembers a new choice per user', async () => {
        const user = userEvent.setup();
        renderPane();
        const trigger = screen.getByRole('button', { name: /change it right away/i });
        await user.click(trigger);
        expect(screen.getByRole('checkbox', { name: /check with me for big changes/i })).toBeChecked();
        await user.click(screen.getByRole('menuitemradio', { name: /just advise/i }));
        await user.click(screen.getByRole('button', { name: /just advise/i }));
        await user.click(screen.getByRole('checkbox', { name: /check with me for big changes/i }));
        expect(scopedStorage.getItem('appBuilderWorkMode')).toBe('discuss');
        expect(scopedStorage.getItem('appBuilderPlanLarge')).toBe('false');
    });

    it('Alt+M cycles the work mode in the app order, and not while a build runs', async () => {
        const user = userEvent.setup();
        const { stream, release } = gatedStream(
            [sse('builder_session', { sessionId: 'bs-alt', appId: 'app-1' })],
            [sse('done', { appId: 'app-1', finalized: true })],
        );
        authFetch.mockImplementation((url) => Promise.resolve(String(url).includes('/data/tables')
            ? { ok: true, status: 200, json: async () => ({ tables: [] }) }
            : String(url).includes('/ai/config/tiers-for-user')
                ? { ok: true, status: 200, json: async () => ({}) }
                : { ok: true, status: 200, body: stream }));
        renderPane({ chrome: { flush: vi.fn().mockResolvedValue(), commitTurn: vi.fn(), markSaved: vi.fn() } });
        const textarea = screen.getByLabelText('Message the AI builder');
        await user.click(textarea);
        await user.keyboard('{Alt>}m{/Alt}');
        expect(scopedStorage.getItem('appBuilderWorkMode')).toBe('describe');   // build → describe (wraps)
        await user.keyboard('{Alt>}m{/Alt}');
        expect(scopedStorage.getItem('appBuilderWorkMode')).toBe('discuss');

        await sendMessage('Go');
        await waitFor(() => expect(ctxRef.current.streamLock).toBe(true));
        fireEvent.keyDown(textarea, { key: 'm', code: 'KeyM', altKey: true });
        expect(scopedStorage.getItem('appBuilderWorkMode')).toBe('discuss');
        release();
        await waitFor(() => expect(ctxRef.current.streamLock).toBe(false));
    });

    it('a plan approval is a "plan" turn, or "describe" when that is the mode', async () => {
        const user = userEvent.setup();
        scopedStorage.setItem('appBuilderWorkMode', 'describe');
        mockAuthFetchStreams(
            sseResponse([
                sse('plan', { planId: 'pl-9', plan: { title: 'Tracker', tables: [], roles: [], datasets: [], screens: [] } }),
                sse('done', { appId: 'app-1', awaitingPlan: true }),
            ]),
            sseResponse([sse('done', { appId: 'app-1', finalized: true })]),
        );
        renderPane({ chrome: { flush: vi.fn().mockResolvedValue(), commitTurn: vi.fn(), markSaved: vi.fn() } });
        await sendMessage('A tracker');
        await user.click(await screen.findByText('Build it'));
        await waitFor(() => expect(streamCalls().length).toBe(2));
        expect(JSON.parse(streamCalls()[1][1].body).workMode).toBe('describe');
    });

    // ── The builder's questions ──────────────────────────────────────
    it('review_questions show the shared questions card; answering starts a turn with the Q/A text in the current mode', async () => {
        const user = userEvent.setup();
        scopedStorage.setItem('appBuilderWorkMode', 'plan');
        mockAuthFetchStreams(
            sseResponse([
                sse('review_questions', { questions: [{ id: 'q1', prompt: 'Who uses the app?', options: ['The team', 'Customers'] }] }),
                sse('done', { appId: 'app-1', finalized: false }),
            ]),
            sseResponse([sse('done', { appId: 'app-1', finalized: false })]),
        );
        renderPane({ chrome: { flush: vi.fn().mockResolvedValue(), commitTurn: vi.fn(), markSaved: vi.fn() } });
        await sendMessage('A planner');
        expect(await screen.findByTestId('questions-card')).toBeInTheDocument();
        expect(screen.getAllByText('Who uses the app?').length).toBeGreaterThan(0);

        await user.click(screen.getByRole('button', { name: /send answer/i }));

        await waitFor(() => expect(streamCalls().length).toBe(2));
        const body = JSON.parse(streamCalls()[1][1].body);
        expect(body.message).toMatch(/Who uses the app\?/);
        expect(body.message).toMatch(/The team/);
        expect(body).toMatchObject({ workMode: 'plan', planMode: 'always' });
        // The card is gone once the next turn starts.
        await waitFor(() => expect(screen.queryByTestId('questions-card')).toBeNull());
    });

    it('questions on the done event and on a restored session show the card as well', async () => {
        studioAppsApi.getBuilderSession.mockResolvedValue({
            snapshot: { messages: [{ role: 'assistant', content: 'A question first.' }], sessionId: 'bs-r', reviewQuestions: [{ id: 'rq', prompt: 'Which screens?', options: ['One', 'Two'] }] },
        });
        renderPane();
        expect(await screen.findByTestId('questions-card')).toHaveTextContent('Which screens?');
    });
});
