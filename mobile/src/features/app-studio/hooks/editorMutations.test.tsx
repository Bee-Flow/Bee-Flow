/**
 * The autosave's mutation moves the cached row to the saved version and
 * leaves a conflict for the caller to reconcile; publish refreshes the app
 * only when it went through; delete drops everything cached about the app.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { useDeleteApp } from './appMutations';
import { usePublishApp, useSaveDefinition } from './editorMutations';
import { deleteApp } from '../api/endpointsApps';
import { saveDefinition } from '../api/endpointsDefinition';
import { publishApp } from '../api/endpointsPublish';
import { studioKeys } from '../api/keys';
import type { StudioAppDetail } from '../model/apiTypes';

jest.mock('../api/endpointsDefinition', () => ({ saveDefinition: jest.fn() }));
jest.mock('../api/endpointsPublish', () => ({ publishApp: jest.fn() }));
jest.mock('../api/endpointsApps', () => ({ deleteApp: jest.fn() }));

const save = saveDefinition as jest.MockedFunction<typeof saveDefinition>;
const publish = publishApp as jest.MockedFunction<typeof publishApp>;
const remove = deleteApp as jest.MockedFunction<typeof deleteApp>;

const detail = {
    app: { id: 'a1', name: 'Intake', definitionVersion: 4, definition: { screens: [], actions: {} } },
    readOnly: false,
} as unknown as StudioAppDetail;

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
        },
    });
    queryClient.setQueryData(studioKeys.row('a1'), detail);
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { queryClient, wrapper };
}

afterEach(() => jest.resetAllMocks());

describe('useSaveDefinition', () => {
    const next = { screens: [{ id: 's1', name: 'Home', sections: [] }], actions: {} };

    it('moves the cached row to the saved version and definition', async () => {
        save.mockResolvedValueOnce({ outcome: 'saved', version: 5, warnings: [], repairs: [] });
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => useSaveDefinition('a1'), { wrapper });
        await act(async () => result.current.mutate({ definition: next, baseVersion: 4 }));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(save).toHaveBeenCalledWith('a1', next, 4);
        const row = queryClient.getQueryData<StudioAppDetail>(studioKeys.row('a1'));
        expect(row?.app.definitionVersion).toBe(5);
        expect(row?.app.definition).toEqual(next);
    });

    it('hands a conflict to the caller and leaves the cache alone', async () => {
        save.mockResolvedValueOnce({ outcome: 'conflict', currentVersion: 6, definition: null });
        const onSuccess = jest.fn();
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => useSaveDefinition('a1', { onSuccess }), { wrapper });
        await act(async () => result.current.mutate({ definition: next, baseVersion: 4 }));
        await waitFor(() => expect(onSuccess).toHaveBeenCalled());
        expect(onSuccess.mock.calls[0][0]).toEqual({ outcome: 'conflict', currentVersion: 6, definition: null });
        expect(queryClient.getQueryData<StudioAppDetail>(studioKeys.row('a1'))?.app.definitionVersion).toBe(4);
    });
});

describe('usePublishApp', () => {
    it('refreshes the app after a publish, not after an invalid draft', async () => {
        const { queryClient, wrapper } = setup();
        const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
        const { result } = await renderHook(() => usePublishApp('a1'), { wrapper });

        publish.mockResolvedValueOnce({ outcome: 'invalid', errors: [], warnings: [] });
        await act(async () => result.current.mutate({ isPublished: true }));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(invalidate).not.toHaveBeenCalled();

        publish.mockResolvedValueOnce({ outcome: 'published', isPublished: true, sharedGroups: [], publishedVersion: 4 });
        await act(async () => result.current.mutate({ isPublished: true }));
        await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: studioKeys.app('a1') }));
    });
});

describe('useDeleteApp', () => {
    it('drops every cached query of the app', async () => {
        remove.mockResolvedValueOnce(undefined);
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => useDeleteApp(), { wrapper });
        await act(async () => result.current.mutate('a1'));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(queryClient.getQueryData(studioKeys.row('a1'))).toBeUndefined();
    });
});
