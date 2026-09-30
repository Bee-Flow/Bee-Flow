import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { automationKeys } from '@/features/automations';

import { useDecideApproval } from './mutations';
import { approvalKeys } from '../api/keys';

jest.mock('../api/endpoints', () => ({ decideApproval: jest.fn(async () => undefined) }));

describe('useDecideApproval', () => {
    it('refreshes every approvals list, so a decided approval leaves Waiting, the badge and the hub', async () => {
        const client = new QueryClient();
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
