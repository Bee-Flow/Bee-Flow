/** Support writes: a new request, and a reply to one. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createSupportThread, replyToSupportThread } from '../api/endpoints';
import { supportKeys } from '../api/keys';

export function useCreateSupportThread() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: { subject: string; message: string }) => createSupportThread(body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: supportKeys.threads });
        },
    });
}

export function useReplyToSupportThread(threadId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (message: string) => replyToSupportThread(threadId ?? '', message),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: supportKeys.thread(threadId ?? 'none') });
            void queryClient.invalidateQueries({ queryKey: supportKeys.threads });
        },
    });
}
