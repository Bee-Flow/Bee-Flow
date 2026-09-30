/** Password and two-factor writes. Each two-factor write re-reads the status it changed. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { changePassword, disableMfa, enableMfa, regenerateRecoveryCodes } from '../api/endpoints';
import { securityKeys } from '../api/keys';

function useInvalidateMfa() {
    const queryClient = useQueryClient();
    return () => void queryClient.invalidateQueries({ queryKey: securityKeys.mfa });
}

export function useEnableMfa() {
    const invalidate = useInvalidateMfa();
    return useMutation({
        mutationFn: (code: string) => enableMfa(code),
        onSuccess: invalidate,
    });
}

export function useDisableMfa() {
    const invalidate = useInvalidateMfa();
    return useMutation({
        mutationFn: (code: string) => disableMfa(code),
        onSuccess: invalidate,
    });
}

export function useRegenerateRecoveryCodes() {
    const invalidate = useInvalidateMfa();
    return useMutation({
        mutationFn: (code: string) => regenerateRecoveryCodes(code),
        onSuccess: invalidate,
    });
}

export function useChangePassword() {
    return useMutation({
        mutationFn: ({ current, next }: { current: string; next: string }) =>
            changePassword(current, next),
    });
}
