/**
 * Create and delete, for the list screen's entry points, and the "used by"
 * check a delete asks first. Each mutation owns what it invalidates.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { MutationHandlers } from './mutations';
import { automationKeys } from '../api/keys';
import { createAutomation, deleteAutomation, getAutomationUsage } from '../api/lifecycle';
import type { CreateAutomationBody, CreateAutomationResult } from '../model/types';

/** Create an automation (a draft) and put it in the list. */
export function useCreateAutomation(handlers: MutationHandlers<CreateAutomationResult, CreateAutomationBody> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateAutomationBody) => createAutomation(body),
        onSuccess: (result, body) => {
            void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
            handlers.onSuccess?.(result, body);
        },
        onError: handlers.onError,
    });
}

/**
 * Delete an automation. Its cached row and runs go with it — a detail screen still
 * mounted underneath must not go on rendering an automation that no longer exists.
 */
export function useDeleteAutomation(handlers: MutationHandlers<boolean, string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteAutomation(id),
        onSuccess: (deleted, id) => {
            queryClient.removeQueries({ queryKey: automationKeys.automation(id) });
            queryClient.removeQueries({ queryKey: automationKeys.runs(id) });
            queryClient.removeQueries({ queryKey: automationKeys.usage(id) });
            void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
            void queryClient.invalidateQueries({ queryKey: automationKeys.recentRuns });
            handlers.onSuccess?.(deleted, id);
        },
        onError: handlers.onError,
    });
}

/**
 * The app buttons that start this automation. Asked fresh every time a delete is
 * about to be confirmed (`staleTime: 0`), and never retried into a false
 * "used nowhere": an error stays an error.
 */
export function useAutomationUsage(id: string, enabled = true) {
    return useQuery({
        queryKey: automationKeys.usage(id),
        queryFn: ({ signal }) => getAutomationUsage(id, signal),
        enabled: enabled && Boolean(id),
        staleTime: 0,
    });
}
