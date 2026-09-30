/**
 * MCP writes: mint, revoke, re-probe. The minted token is deliberately NOT put
 * in the query cache — only the token's status is re-read — so the one copy
 * of the secret is the one on screen.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { mintMcpToken, revokeMcpToken } from '../api/endpoints';
import { mcpKeys } from '../api/keys';
import type { McpMintedToken } from '../model/types';

interface Handlers<D> {
    onSuccess?: (data: D) => void;
    onError?: (error: Error) => void;
}

export function useMintMcpToken(handlers: Handlers<McpMintedToken | null> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => mintMcpToken(),
        onSuccess: (result) => {
            handlers.onSuccess?.(result);
            if (result?.token) void queryClient.invalidateQueries({ queryKey: mcpKeys.token });
        },
        onError: handlers.onError,
    });
}

export function useRevokeMcpToken(handlers: Handlers<void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => revokeMcpToken(),
        onSuccess: () => {
            handlers.onSuccess?.();
            void queryClient.invalidateQueries({ queryKey: mcpKeys.token });
        },
        onError: handlers.onError,
    });
}
