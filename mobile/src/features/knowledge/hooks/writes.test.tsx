/**
 * Two knowledge-base writes and what they leave in the cache: an audience
 * change is shown at once (so a second tick builds on the first), and a
 * source write re-reads the list and the cross-base documents even when the
 * delete answered 409 after removing some documents.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { ApiError } from '@/core/api/client';

import { usePublishKnowledgeBase } from './manage';
import { useDeleteKbSource } from './sources';
import { INGESTED_DOCUMENTS, knowledgeKeys } from '../api/keys';
import { publishKnowledgeBase } from '../api/manageEndpoints';
import { deleteKbSource } from '../api/sourceEndpoints';

jest.mock('../api/manageEndpoints', () => ({ ...jest.requireActual('../api/manageEndpoints'), publishKnowledgeBase: jest.fn() }));
jest.mock('../api/sourceEndpoints', () => ({ ...jest.requireActual('../api/sourceEndpoints'), deleteKbSource: jest.fn() }));

const publish = publishKnowledgeBase as jest.MockedFunction<typeof publishKnowledgeBase>;
const removeSource = deleteKbSource as jest.MockedFunction<typeof deleteKbSource>;

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
    queryClient.setQueryData(knowledgeKeys.base('kb1'), { id: 'kb1', name: 'Prices', is_published: true, shared_groups: [] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { queryClient, wrapper };
}

afterEach(() => {
    publish.mockReset();
    removeSource.mockReset();
});

describe('usePublishKnowledgeBase', () => {
    it('shows the new audience before the server answers, and puts it back on a refusal', async () => {
        let refuse: (e: Error) => void = () => undefined;
        publish.mockReturnValue(new Promise<void>((_res, rej) => (refuse = rej)));
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => usePublishKnowledgeBase('kb1'), { wrapper });

        await act(async () => result.current.mutate({ isPublished: true, sharedGroups: ['g1'] }));
        await waitFor(() => expect(queryClient.getQueryData(knowledgeKeys.base('kb1'))).toMatchObject({ shared_groups: ['g1'] }));

        await act(async () => refuse(new Error('no')));
        await waitFor(() => expect(queryClient.getQueryData(knowledgeKeys.base('kb1'))).toMatchObject({ shared_groups: [] }));
    });
});

describe('useDeleteKbSource', () => {
    it('re-reads the list and the documents views after a partial delete', async () => {
        removeSource.mockRejectedValue(new ApiError('kept', { status: 409, body: { code: 'purge_incomplete', deletedDocuments: 2 } }));
        const { queryClient, wrapper } = setup();
        const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
        const { result } = await renderHook(() => useDeleteKbSource('kb1'), { wrapper });

        await act(async () => result.current.mutate('s1'));
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(invalidate).toHaveBeenCalledWith({ queryKey: knowledgeKeys.all });
        expect(invalidate).toHaveBeenCalledWith({ queryKey: INGESTED_DOCUMENTS });
    });
});
