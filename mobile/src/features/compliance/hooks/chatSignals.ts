/**
 * Chat signals' react-query hooks (port of the web's useChatMonitoring.ts
 * hooks). The summary is lazy on purpose: every read writes an access-audit
 * row, so it is fetched only after the person asks, and never prefetched.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
    chatSignalsKeys,
    deleteChatSignalCounts,
    getChatSignalsActivity,
    getChatSignalsConfig,
    getChatSignalsSummary,
    recordChatSignalsDpia,
    saveChatSignals,
    type ChatSignalsDpiaInput,
} from '../api/chatSignals';
import type { ChatSignalsConfig } from '../api/chatSignalsReaders';
import type { PutBody } from '../model/chatSignals/form';

export function useChatSignalsConfig(enabled = true) {
    return useQuery({
        queryKey: chatSignalsKeys.config(),
        queryFn: ({ signal }) => getChatSignalsConfig(signal),
        enabled,
        retry: false,
        staleTime: 0,
    });
}

/** On success the answer is the new configuration; the register and the checks move with it. */
export function useSaveChatSignals() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (body: PutBody) => saveChatSignals(body),
        onSuccess: (config: ChatSignalsConfig) => {
            qc.setQueryData(chatSignalsKeys.config(), config);
            void qc.invalidateQueries({
                queryKey: ['compliance'],
                predicate: (q) => q.queryKey[1] !== 'chat-signals' || q.queryKey[2] === 'ropa',
            });
        },
    });
}

export function useChatSignalsSummary(days: 30 | 90, enabled: boolean) {
    return useQuery({
        queryKey: chatSignalsKeys.summary(days),
        queryFn: ({ signal }) => getChatSignalsSummary(days, signal),
        enabled,
        retry: false,
        staleTime: 60_000,
    });
}

export function useDeleteChatSignalCounts() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: () => deleteChatSignalCounts(),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: chatSignalsKeys.config() });
            void qc.invalidateQueries({ queryKey: [...chatSignalsKeys.all, 'summary'] });
        },
    });
}

export function useRecordChatSignalsDpia() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (input: ChatSignalsDpiaInput) => recordChatSignalsDpia(input),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: chatSignalsKeys.config() });
        },
    });
}

export function useChatSignalsActivity(enabled: boolean) {
    return useQuery({
        queryKey: chatSignalsKeys.activity(),
        queryFn: ({ signal }) => getChatSignalsActivity(signal),
        enabled,
        retry: false,
        staleTime: 60_000,
    });
}
