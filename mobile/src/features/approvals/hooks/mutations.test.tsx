import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { automationKeys } from '@/features/automations';
import { testQueryClient } from '@/shared/testing/renderWithProviders';

import { useDecideApproval } from './mutations';
import { approvalKeys } from '../api/keys';

jest.mock('../api/endpoints', () => ({ decideApproval: jest.fn(async () => undefined) }));

describe('useDecideApproval', () => {
    it('refreshes every approvals list, so a decided approval leaves Waiting, the badge and the hub', async () => {
        // Not a bare QueryClient: the finished mutation's five-minute gc timer kept Jest's worker from exiting.
        const client = testQueryClient();
        const invalidate = jest.spyOn(client, 'invalidateQueries');
        const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
        const { result } = await renderHook(() => useDecideApproval('ap1'), { wrapper });
        await act(async () => {
            await result.current.mutateAsync({ decision: 'approved' as never });
        });
        expect(invalidate).toHaveBeenCalledWith({ queryKey: automationKeys.approvalLists });
        // The lists' prefix really is the one every scope's key starts with.
        expect(approvalKeys.approvals('pending').slice(0, 2)).toEqual([...automationKeys.approvalLists]);
    });
});
