/** "Pick from a conversation": the reads and the take. Screens call these rather than useQuery. */

import { useMutation, useQuery } from '@tanstack/react-query';

import { exampleFromMessage, listExampleConversations, listExampleMessages } from '../api/exampleEndpoints';
import { skillKeys } from '../api/keys';
import type { SkillExample } from '../model/types';

export function useExampleConversations(enabled: boolean) {
    return useQuery({
        queryKey: skillKeys.exampleConversations,
        queryFn: ({ signal }) => listExampleConversations(signal),
        enabled,
    });
}

/** Redacted on every read — never cached past the picker, so a stale copy is not reused. */
export function useExampleMessages(conversationId: string | null) {
    return useQuery({
        queryKey: skillKeys.exampleMessages(conversationId ?? ''),
        queryFn: ({ signal }) => listExampleMessages(conversationId ?? '', signal),
        enabled: Boolean(conversationId),
        gcTime: 0,
    });
}

export function useTakeExample(skillId: string, onTaken: (example: SkillExample) => void) {
    return useMutation({
        mutationFn: (input: { conversationId: string; messageIndex: number }) => exampleFromMessage(skillId, input),
        onSuccess: (example) => {
            if (example) onTaken(example);
        },
    });
}
