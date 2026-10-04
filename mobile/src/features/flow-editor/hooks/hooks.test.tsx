/**
 * The reads and the writes around the draft, over a mocked HTTP client: the
 * catalog is read once and hands its pick sources to the bindings layer; a
 * restore replaces the draft as one undo entry; links are created against a
 * saved draft; a template is installed as a new automation; and deactivating
 * clears the activation findings.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { api } from '@/core/api/client';
import { automationKeys } from '@/features/automations';

import { useCreateFromTemplate } from './library';
import { useActivateFlow, useRestoreVersion } from './lifecycle';
import { useFlowWebhooks } from './links';
import { useCatalog } from './queries';
import { useFlowDraft } from './useFlowDraft';
import { pickSourceById, resetPickSources } from '../bindings/flowDeps/pickSources';
import { applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';
import { resetDraftRegistry } from '../state/registry';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;

const DEF: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'webhook' }, steps: [{ id: 's1', type: 'set' }], edges: [] };
const OLD: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { queryClient, wrapper };
}

beforeEach(() => {
    for (const fn of [get, post, put]) fn.mockReset();
    resetPickSources();
    get.mockImplementation(async (path: string) => {
        if (path === '/api/automation/a1') return { automation: { id: 'a1', definition: DEF, version: 2 } };
        if (path === '/api/automation/a1/webhooks') return { webhooks: [{ id: 'slug', url: 'https://x/wh/slug' }] };
        if (path === '/api/automation/catalog') return { apps: [], formPickSources: [{ id: 'fireflies', label: 'Fireflies', sampleData: { date: 'x' } }] };
        if (path === '/api/automation/templates/t1') return { template: { id: 't1', title: 'Invoice inbox', definition: DEF } };
        return {};
    });
    put.mockImplementation(async (_p: string, body: { definition?: FlowDefinition }) => ({ automation: { id: 'a1', definition: body.definition ?? DEF, version: 3 }, warnings: [] }));
});

afterEach(() => resetDraftRegistry());

it('reads the catalog once and hands its pick sources to the bindings layer', async () => {
    const { wrapper } = setup();
    const first = await renderHook(() => useCatalog(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(pickSourceById('fireflies')).toMatchObject({ sampleData: { date: 'x' } });
    const second = await renderHook(() => useCatalog(), { wrapper });
    expect(second.result.current.data).toBe(first.result.current.data);
    expect(get.mock.calls.filter((c) => c[0] === '/api/automation/catalog')).toHaveLength(1);
    await first.unmount();
    await second.unmount();
});

it('reads the catalog anew when an automation opens, but not when a step opens or re-renders', async () => {
    const { wrapper } = setup();
    const catalogReads = () => get.mock.calls.filter((c) => c[0] === '/api/automation/catalog').length;
    // The first visit to an automation; the author then leaves for Studio → Datatables.
    const firstVisit = await renderHook(() => useCatalog({ freshOnMount: true }), { wrapper });
    await waitFor(() => expect(firstVisit.result.current.isSuccess).toBe(true));
    await firstVisit.unmount();
    expect(catalogReads()).toBe(1);

    get.mockImplementation(async (path: string) =>
        path === '/api/automation/catalog' ? { apps: [], datatables: [{ id: 'd1', name: 'Invoices' }], formPickSources: [] } : {},
    );
    // Back on the automation: the table made meanwhile is offered.
    const build = await renderHook(() => useCatalog({ freshOnMount: true }), { wrapper });
    await waitFor(() => expect(catalogReads()).toBe(2));
    await waitFor(() => expect(build.result.current.data?.datatables).toEqual([expect.objectContaining({ id: 'd1' })]));
    // A step editor opened over it, and every re-render, read the same copy.
    const step = await renderHook(() => useCatalog(), { wrapper });
    await build.rerender({});
    await step.rerender({});
    expect(catalogReads()).toBe(2);
    await step.unmount();
    await build.unmount();
});

it('a restore saves the draft first and comes back as one undo entry', async () => {
    const { wrapper } = setup();
    post.mockResolvedValue({ automation: { id: 'a1', definition: OLD, version: 4 }, restoredFromVersion: 1 });
    const { result, unmount } = await renderHook(() => ({ draft: useFlowDraft('a1'), restore: useRestoreVersion('a1') }), { wrapper });
    await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
    const store = result.current.draft.store;
    await act(async () => {
        store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'Mine' }));
    });
    await act(async () => {
        await result.current.restore.mutateAsync('v1');
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/automation/a1/versions/v1/restore', undefined, { retry: false });
    expect(store.getState()).toMatchObject({ definition: OLD, baseline: OLD, dirty: false, version: 4 });
    await act(async () => {
        store.getState().undo();
    });
    expect(store.getState().definition?.steps[0]?.label).toBe('Mine');
    await unmount();
});

it('creates a webhook against the saved draft and shows the secret from the answer', async () => {
    const { wrapper } = setup();
    post.mockResolvedValue({ webhook: { id: 'slug2', secret: 's3cr3t' }, url: 'https://x/wh/slug2' });
    const { result, unmount } = await renderHook(() => ({ draft: useFlowDraft('a1'), hooks: useFlowWebhooks('a1') }), { wrapper });
    await waitFor(() => expect(result.current.hooks.list.data).toHaveLength(1));
    await act(async () => {
        result.current.draft.store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'Mine' }));
    });
    let made: unknown;
    await act(async () => {
        made = await result.current.hooks.create.mutateAsync('trg');
    });
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0] ?? 0);
    expect(made).toMatchObject({ id: 'slug2', secret: 's3cr3t', url: 'https://x/wh/slug2' });
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === '/api/automation/a1/webhooks')).toHaveLength(2));
    await unmount();
});

it('installs a template as a new automation and refreshes the list', async () => {
    const { wrapper, queryClient } = setup();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    post.mockResolvedValue({ automation: { id: 'new', definition: DEF }, warnings: [] });
    const { result, unmount } = await renderHook(() => useCreateFromTemplate(), { wrapper });
    let out: unknown;
    await act(async () => {
        out = await result.current.mutateAsync('t1');
    });
    expect(out).toMatchObject({ automation: { id: 'new' } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: automationKeys.automations });
    await unmount();
});

it('deactivating clears the activation findings', async () => {
    const { wrapper } = setup();
    post.mockResolvedValue({ automation: { id: 'a1', definition: DEF, version: 2, isActive: false } });
    const { result, unmount } = await renderHook(() => ({ draft: useFlowDraft('a1'), activate: useActivateFlow('a1') }), { wrapper });
    await waitFor(() => expect(result.current.draft.store.getState().ready).toBe(true));
    const store = result.current.draft.store;
    await act(async () => {
        store.getState().setIssues('activate', { errors: [{ severity: 'error', message: 'Old refusal' }], warnings: [] });
    });
    await act(async () => {
        await result.current.activate.mutateAsync(false);
    });
    expect(post).toHaveBeenCalledWith('/api/automation/a1/deactivate', undefined, { retry: false });
    expect(put).not.toHaveBeenCalled();
    expect(store.getState().issues.errors).toEqual([]);
    await unmount();
});
