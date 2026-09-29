import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hooks a page that DRIVES the app builder needs (Studio Playbooks): a
 * brief the pane sends itself once at mount, a pinned tier, and the end of
 * the turn as the stream reported it.
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
import { KITCHEN_SINK } from '../state/sampleDefinitions';
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
});
