import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper, testQueryClient } from '../../test/queryWrapper';
import { SUGGESTIONS_DOM_EVENT, useDocumentSuggestions } from './suggestions';

const { get, post, handlers, projectHandlers } = vi.hoisted(() => ({
    get: vi.fn(), post: vi.fn(),
    handlers: new Set<(e: unknown) => void>(), projectHandlers: new Set<(k: string, e: unknown) => void>(),
}));
vi.mock('../client', () => ({ apiClient: { get, post } }));
vi.mock('../../hooks/useDocumentStream', () => ({
    default: () => ({ subscribe: (_t: string, h: (e: unknown) => void) => { handlers.add(h); return () => handlers.delete(h); } }),
}));
vi.mock('../../components/projects/workspace/ProjectLiveContext', () => ({
    useProjectLive: () => ({ subscribe: (h: (k: string, e: unknown) => void) => { projectHandlers.add(h); return () => projectHandlers.delete(h); } }),
}));

beforeEach(() => {
    get.mockReset(); handlers.clear(); projectHandlers.clear();
    get.mockResolvedValue({ suggestions: [{ id: 's1', status: 'open' }], open: 1 });
});

function mount() {
    return renderHook(() => useDocumentSuggestions('d1'), { wrapper: queryWrapper(testQueryClient()) as React.ComponentType });
}

describe('useDocumentSuggestions', () => {
    it('reads the list and the open count', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.data?.open).toBe(1));
        expect(get.mock.calls[0][0]).toBe('/api/studio-documents/d1/suggestions');
    });

    it('refetches on the document stream event', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.data).toBeDefined());
        get.mockResolvedValue({ suggestions: [], open: 0 });
        act(() => { handlers.forEach(h => h({ payload: { documentId: 'd1' } })); });
        await waitFor(() => expect(result.current.data?.open).toBe(0));
    });

    it('refetches on the project feed event about this document, not another', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.data).toBeDefined());
        const calls = get.mock.calls.length;
        act(() => { projectHandlers.forEach(h => h('doc.suggestions', { payload: { documentId: 'other' } })); });
        act(() => { projectHandlers.forEach(h => h('doc.edited', { payload: { documentId: 'd1' } })); });
        expect(get.mock.calls.length).toBe(calls);
        act(() => { projectHandlers.forEach(h => h('doc.suggestions', { payload: { documentId: 'd1' } })); });
        await waitFor(() => expect(get.mock.calls.length).toBe(calls + 1));
    });

    it('refetches on the chat DOM event for this document', async () => {
        const { result } = mount();
        await waitFor(() => expect(result.current.data).toBeDefined());
        const calls = get.mock.calls.length;
        act(() => { window.dispatchEvent(new CustomEvent(SUGGESTIONS_DOM_EVENT, { detail: { documentId: 'other' } })); });
        expect(get.mock.calls.length).toBe(calls);
        act(() => { window.dispatchEvent(new CustomEvent(SUGGESTIONS_DOM_EVENT, { detail: { documentId: 'd1', batchId: 'b', count: 2 } })); });
        await waitFor(() => expect(get.mock.calls.length).toBe(calls + 1));
    });
});
