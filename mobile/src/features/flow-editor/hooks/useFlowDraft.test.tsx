/**
 * The draft store's lifecycle on a screen, over a mocked HTTP client: the
 * routine loads into the store, two screens share one store, nothing typed is
 * lost when the screen closes or the app goes to the background, a new
 * routine is created by its first save and announced, and the actions that
 * read the STORED definition (activate, test a step) save the draft first.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';
import { AppState } from 'react-native';

import { api, ApiError } from '@/core/api/client';

import { useActivateFlow } from './lifecycle';
import { useStepRun } from './runs';
import { NEW_FLOW_ID, useDraftState, useFlowDraft } from './useFlowDraft';
import { applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';
import { peekDraftStore, resetDraftRegistry } from '../state/registry';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'set', label: 'First' }],
    edges: [{ from: 'trg', to: 's1' }],
};

const row = (id: string, definition: unknown, version = 1) => ({ id, definition, version, title: 'Flow', isActive: false });

let appStateListeners: ((state: string) => void)[] = [];

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { queryClient, wrapper };
}

const rename = (label: string) => (d: FlowDefinition) => applyPatchStep(d, 's1', { label });

beforeEach(() => {
    get.mockReset();
    post.mockReset();
    put.mockReset();
    appStateListeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (state: string) => void) => {
        appStateListeners.push(handler);
        return { remove: () => (appStateListeners = appStateListeners.filter((l) => l !== handler)) };
    }) as unknown as typeof AppState.addEventListener);
    get.mockImplementation(async (path: string) => (path === '/api/automation/a1' ? { automation: row('a1', DEF, 4), summary: 'Sets a value' } : {}));
    put.mockImplementation(async (path: string, body: { definition: FlowDefinition }) => ({ automation: row('a1', body.definition, 5), warnings: [] }));
});

afterEach(() => {
    resetDraftRegistry();
    jest.restoreAllMocks();
});

describe('useFlowDraft', () => {
    it('loads the routine into the store and shares the store between screens', async () => {
        const { wrapper } = setup();
        const first = await renderHook(() => useFlowDraft('a1'), { wrapper });
        await waitFor(() => expect(first.result.current.store.getState().ready).toBe(true));
        expect(first.result.current.store.getState()).toMatchObject({ definition: DEF, version: 4, dirty: false });
        expect(first.result.current.summary).toBe('Sets a value');
        const second = await renderHook(() => useFlowDraft('a1'), { wrapper });
        expect(second.result.current.store).toBe(first.result.current.store);
        await second.unmount();
        await first.unmount();
    });

    it('saves unsaved edits when the screen closes', async () => {
        const { wrapper } = setup();
        const { result, unmount } = await renderHook(() => useFlowDraft('a1'), { wrapper });
        await waitFor(() => expect(result.current.store.getState().ready).toBe(true));
        await act(async () => {
            result.current.store.getState().applyOp(rename('Edited'));
        });
        await unmount();
        await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
        expect(put.mock.calls[0]?.[1].definition.steps[0].label).toBe('Edited');
    });

    it('saves unsaved edits when the app goes to the background', async () => {
        const { wrapper } = setup();
        const { result, unmount } = await renderHook(() => useFlowDraft('a1'), { wrapper });
        await waitFor(() => expect(result.current.store.getState().ready).toBe(true));
        await act(async () => {
            result.current.store.getState().applyOp(rename('Edited'));
        });
        await act(async () => {
            appStateListeners.forEach((l) => l('background'));
        });
        await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(result.current.store.getState().dirty).toBe(false));
        await unmount();
    });

    it('creates a new routine on its first save and announces it once', async () => {
        const { wrapper } = setup();
        post.mockResolvedValue({ automation: row('made', DEF, 1), warnings: [] });
        const onCreated = jest.fn();
        const { result, unmount } = await renderHook(() => useFlowDraft(NEW_FLOW_ID, { title: 'Mine', onCreated }), { wrapper });
        const store = result.current.store;
        expect(store.getState()).toMatchObject({ ready: true, automationId: null });
        expect(get).not.toHaveBeenCalled();

        await act(async () => {

            store.getState().applyOp((d) => ({ ...d, steps: [{ id: 'x', type: 'set' }] }));

        });
        await act(async () => void (await store.getState().flush()));
        expect(post).toHaveBeenCalledWith('/api/automation', expect.objectContaining({ title: 'Mine' }), { retry: false });
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith('made'));
        expect(onCreated).toHaveBeenCalledTimes(1);
        expect(peekDraftStore('made')).toBe(store);
        await unmount();
    });
});

describe('actions that read the stored routine', () => {
    it('activation saves first, and a refusal’s details become the store’s activation findings', async () => {
        const { wrapper } = setup();
        post.mockRejectedValueOnce(
            new ApiError('Invalid definition', {
                status: 400,
                body: { error: 'Invalid definition', details: [{ code: 'tool.unknown', path: 'steps[s1].tool', message: 'Unknown tool' }] },
            }),
        );
        const { result, unmount } = await renderHook(
            () => {
                const draft = useFlowDraft('a1');
                const errors = useDraftState(draft.store, (s) => s.issues.errors);
                return { draft, errors, activate: useActivateFlow('a1') };
            },
            { wrapper },
        );
        await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
        await act(async () => {
            result.current.draft.store.getState().applyOp(rename('Edited'));
        });
        await act(async () => {
            await result.current.activate.mutateAsync(true).catch(() => undefined);
        });
        expect(put).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith('/api/automation/a1/activate', undefined, { retry: false });
        expect(put.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0] ?? 0);
        await waitFor(() => expect(result.current.errors.map((e) => e.message)).toEqual(['Unknown tool']));
        expect(result.current.draft.store.getState().issuesByStep.get('s1')?.errors).toHaveLength(1);
        await unmount();
    });

    it('a step test saves first and runs the stored definition', async () => {
        const { wrapper } = setup();
        post.mockResolvedValue({ run: { id: 'r1', status: 'success' }, steps: [{ stepId: 's1', status: 'success' }], stepRecord: { stepId: 's1' } });
        const { result, unmount } = await renderHook(() => ({ draft: useFlowDraft('a1'), run: useStepRun('a1') }), { wrapper });
        await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
        await act(async () => {
            result.current.draft.store.getState().applyOp(rename('Edited'));
        });
        let out: unknown;
        await act(async () => {
            out = await result.current.run.mutateAsync({ stepId: 's1', mode: 'from' });
        });
        expect(put).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith('/api/automation/a1/steps/s1/run', { mode: 'from' }, expect.objectContaining({ retry: false }));
        expect(out).toMatchObject({ stepRecord: { stepId: 's1' } });
        await unmount();
    });

    it('refuses to test a step whose latest edits cannot be saved', async () => {
        const { wrapper } = setup();
        put.mockRejectedValue(new ApiError('Invalid definition', { status: 400, body: { details: ['bad'] } }));
        const { result, unmount } = await renderHook(() => ({ draft: useFlowDraft('a1'), run: useStepRun('a1') }), { wrapper });
        await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
        await act(async () => {
            result.current.draft.store.getState().applyOp(rename('Edited'));
        });
        let failure: unknown;
        await act(async () => {
            failure = await result.current.run.mutateAsync({ stepId: 's1' }).catch((e: unknown) => e);
        });
        expect((failure as Error).name).toBe('UnsavedDraftError');
        expect(post).not.toHaveBeenCalled();
        await unmount();
    });
});
