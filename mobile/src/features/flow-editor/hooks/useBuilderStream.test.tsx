/**
 * "Ask AI" wired into the draft store, over a fake stream: the draft is saved
 * before the turn, the store is locked while it streams, the AI's drafts
 * replace the definition without being sent back, its findings become the
 * builder's, and the transcript grows by the turn. A turn on an automation that
 * does not exist yet hands over the id the server created.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { api, ApiError } from '@/core/api/client';
import type { SseFrame } from '@/core/api/sse';

import { useBuilderStream } from './useBuilderStream';
import { NEW_FLOW_ID, useFlowDraft } from './useFlowDraft';
import { applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';
import { peekDraftStore, resetDraftRegistry } from '../state/registry';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const mockStreamSse = jest.fn();
jest.mock('@/core/api/sse', () => ({
    streamSse: (...args: unknown[]) => mockStreamSse(...args),
}));

const get = api.get as jest.Mock;
const put = api.put as jest.Mock;

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'set', label: 'First' }],
    edges: [{ from: 'trg', to: 's1' }],
};
const AI_DRAFT: FlowDefinition = { ...DEF, steps: [...DEF.steps, { id: 's2', type: 'wait' }], edges: [...DEF.edges, { from: 's1', to: 's2' }] };

/** A stream that yields the frames, pausing before `done` until the test lets it finish. */
function feed(frames: SseFrame[]) {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    mockStreamSse.mockImplementation(async function* () {
        for (const frame of frames) yield frame;
        await gate;
        yield { event: 'done', data: { finalized: false } };
    });
    return finish;
}

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { queryClient, wrapper };
}

beforeEach(() => {
    mockStreamSse.mockReset();
    get.mockReset();
    put.mockReset();
    get.mockImplementation(async (path: string) => {
        if (path === '/api/automation/a1') return { automation: { id: 'a1', definition: DEF, version: 2 } };
        if (path.startsWith('/api/automation/builder/session/')) {
            return { snapshot: { sessionId: 'bs0', conversation: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Sure' }] } };
        }
        return {};
    });
    put.mockImplementation(async (_path: string, body: { definition: FlowDefinition }) => ({ automation: { id: 'a1', definition: body.definition, version: 3 }, warnings: [] }));
});

afterEach(() => resetDraftRegistry());

it('saves first, locks while streaming, adopts the AI drafts and grows the transcript', async () => {
    const { wrapper } = setup();
    const finish = feed([
        { event: 'builder_session', data: { builderSessionId: 'bs1', automationId: 'a1' } },
        { event: 'draft', data: { definition: AI_DRAFT, automationId: 'a1' } },
        { event: 'validation_errors', data: { errors: [], warnings: [{ code: 'w', path: 'steps[s2].duration', message: 'Pick a duration' }] } },
        { event: 'message', data: { content: 'Added a wait.' } },
    ]);
    const { result, unmount } = await renderHook(
        () => {
            const draft = useFlowDraft('a1');
            return { draft, ai: useBuilderStream(draft, { modelTier: 'fast' }) };
        },
        { wrapper },
    );
    await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
    await waitFor(() => expect(result.current.ai.transcript).toHaveLength(2));
    const store = result.current.draft.store;
    await act(async () => {
        store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'Mine' }));
    });

    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
        sending = result.current.ai.send('Add a wait');
    });
    await waitFor(() => expect(store.getState().locked).toBe(true));
    expect(put).toHaveBeenCalledTimes(1);
    const [path, opts] = mockStreamSse.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe('/api/automation/builder/stream');
    expect(opts.body).toMatchObject({
        message: 'Add a wait',
        automationId: 'a1',
        builderSessionId: 'bs0',
        modelTier: 'fast',
        history: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Sure' }],
    });
    await waitFor(() => expect(store.getState().definition).toEqual(AI_DRAFT));
    expect(store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'blocked' }))).toBeNull();

    await act(async () => {
        finish();
        await sending;
    });
    expect(store.getState()).toMatchObject({ locked: false, dirty: false, baseline: AI_DRAFT });
    expect(store.getState().issuesByStep.get('s2')?.warnings).toHaveLength(1);
    expect(result.current.ai.transcript.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:Earlier',
        'assistant:Sure',
        'user:Add a wait',
        'assistant:Added a wait.',
    ]);
    expect(put).toHaveBeenCalledTimes(1);

    // One undo takes back the whole turn — and that is a local edit to save.
    await act(async () => {
        store.getState().undo();
    });
    expect(store.getState().definition?.steps).toHaveLength(1);
    expect(store.getState().dirty).toBe(true);
    await unmount();
});

it('a turn on a new automation hands over the id the server created', async () => {
    const { wrapper } = setup();
    const finish = feed([{ event: 'builder_session', data: { builderSessionId: 'bs1', automationId: 'made-by-ai' } }]);
    const onCreated = jest.fn();
    const { result, unmount } = await renderHook(
        () => {
            const draft = useFlowDraft(NEW_FLOW_ID, { onCreated });
            return { draft, ai: useBuilderStream(draft) };
        },
        { wrapper },
    );
    await act(async () => {
        const sending = result.current.ai.send('Build me a flow');
        finish();
        await sending;
    });
    expect((mockStreamSse.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body.automationId).toBeNull();
    expect(result.current.draft.store.getState().automationId).toBe('made-by-ai');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('made-by-ai'));
    expect(peekDraftStore('made-by-ai')).toBe(result.current.draft.store);
    await unmount();
});

it('refuses the turn when the latest edits cannot be saved', async () => {
    const { wrapper } = setup();
    put.mockRejectedValue(new ApiError('Invalid definition', { status: 400, body: { details: ['bad'] } }));
    const { result, unmount } = await renderHook(
        () => {
            const draft = useFlowDraft('a1');
            return { draft, ai: useBuilderStream(draft) };
        },
        { wrapper },
    );
    await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
    await act(async () => {
        result.current.draft.store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'Mine' }));
    });
    let failure: unknown;
    await act(async () => {
        failure = await result.current.ai.send('Anything').catch((e: unknown) => e);
    });
    expect((failure as Error).name).toBe('UnsavedDraftError');
    expect(mockStreamSse).not.toHaveBeenCalled();
    expect(result.current.draft.store.getState().locked).toBe(false);
    await unmount();
});
