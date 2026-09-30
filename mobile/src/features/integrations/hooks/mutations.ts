/** Integration writes, each re-reading what it changed. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { connectGithub, disconnectIntegration, saveUserSettings } from '../api/endpoints';
import { integrationKeys } from '../api/keys';

/**
 * Save the model's app allow-list. Optimistic: the toggle has to move under
 * the thumb. On failure the previous answer is restored, and the settle
 * re-reads the server's either way.
 */
export function useSaveEnabledApps() {
    const queryClient = useQueryClient();
    const key = integrationKeys.userSettings;
    return useMutation({
        mutationFn: (enabledApps: string[]) => saveUserSettings({ enabledApps }),
        onMutate: async (enabledApps) => {
            await queryClient.cancelQueries({ queryKey: key });
            const previous = queryClient.getQueryData(key);
            queryClient.setQueryData(key, (old: unknown) =>
                old && typeof old === 'object' ? { ...old, enabledApps } : old,
            );
            return { previous };
        },
        onError: (_error, _vars, context) => {
            if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: key });
        },
    });
}

/** `onDone` runs after the re-read is queued, once per disconnect. */
export function useDisconnectIntegration({ onDone }: { onDone?: () => void } = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (provider: string) => disconnectIntegration(provider),
        onSuccess: (_data, provider) => {
            void queryClient.invalidateQueries({ queryKey: integrationKeys.status(provider) });
            void queryClient.invalidateQueries({ queryKey: integrationKeys.userSettings });
            onDone?.();
        },
    });
}

export function useConnectGithub() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (token: string) => connectGithub(token),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: integrationKeys.status('github') });
        },
    });
}
