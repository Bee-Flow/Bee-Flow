/**
 * The list screen's create and delete, and the usage check before a delete:
 * each write refreshes the list, and a delete drops the routine's cached row
 * so a screen still mounted underneath cannot render a routine that is gone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { useAutomationUsage, useCreateAutomation, useDeleteAutomation } from './lifecycle';
import { automationKeys } from '../api/keys';
import { createAutomation, deleteAutomation, getAutomationUsage } from '../api/lifecycle';

jest.mock('../api/lifecycle', () => ({
    createAutomation: jest.fn(),
    deleteAutomation: jest.fn(),
    getAutomationUsage: jest.fn(),
}));

const create = createAutomation as jest.MockedFunction<typeof createAutomation>;
const remove = deleteAutomation as jest.MockedFunction<typeof deleteAutomation>;
const usage = getAutomationUsage as jest.MockedFunction<typeof getAutomationUsage>;

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { queryClient, wrapper };
}

afterEach(() => jest.resetAllMocks());

it('create refreshes the list and hands the result on', async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    create.mockResolvedValue({ automation: null, warnings: [] });
    const onSuccess = jest.fn();
    const { result } = await renderHook(() => useCreateAutomation({ onSuccess }), { wrapper });
    await act(async () => {
        await result.current.mutateAsync({ title: 'T', definition: {} });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: automationKeys.automations });
    expect(onSuccess).toHaveBeenCalledWith({ automation: null, warnings: [] }, { title: 'T', definition: {} });
});

it('delete drops the routine’s cached row and runs, and refreshes the lists', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(automationKeys.automation('a1'), { automation: { id: 'a1' }, summary: '' });
    queryClient.setQueryData(automationKeys.runs('a1'), []);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    remove.mockResolvedValue(true);
    const { result } = await renderHook(() => useDeleteAutomation(), { wrapper });
    await act(async () => {
        await result.current.mutateAsync('a1');
    });
    expect(queryClient.getQueryData(automationKeys.automation('a1'))).toBeUndefined();
    expect(queryClient.getQueryData(automationKeys.runs('a1'))).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: automationKeys.automations });
});

it('asks for the usage only when enabled, and keeps a failure a failure', async () => {
    const { wrapper } = setup();
    usage.mockRejectedValue(new Error('usage_unavailable'));
    const off = await renderHook(() => useAutomationUsage('a1', false), { wrapper });
    expect(usage).not.toHaveBeenCalled();
    await off.unmount();
    const on = await renderHook(() => useAutomationUsage('a1'), { wrapper });
    await waitFor(() => expect(on.result.current.isError).toBe(true));
    expect(on.result.current.data).toBeUndefined();
    await on.unmount();
});
