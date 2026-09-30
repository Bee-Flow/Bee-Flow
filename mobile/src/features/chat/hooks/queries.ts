/**
 * Chat's reads. Screens and components use these, never useQuery itself, so
 * the keys and cache lifetimes are decided once.
 */

import { useQuery } from '@tanstack/react-query';

import {
    fetchTiers,
    getConversation,
    getSessionSkills,
    listConversations,
    listLabels,
} from '../api/endpoints';
import { chatKeys, tierKeys } from '../api/keys';

export function useConversations() {
    return useQuery({
        queryKey: chatKeys.conversations,
        queryFn: ({ signal }) => listConversations(signal),
    });
}

/** `null` is a chat that does not exist on the server yet: nothing to fetch. */
export function useConversation(conversationId: string | null) {
    return useQuery({
        queryKey: chatKeys.conversation(conversationId ?? 'new'),
        queryFn: ({ signal }) => getConversation(conversationId as string, signal),
        enabled: Boolean(conversationId),
    });
}

export function useLabels() {
    return useQuery({
        queryKey: chatKeys.labels,
        queryFn: ({ signal }) => listLabels(signal),
        staleTime: 5 * 60_000,
    });
}

/**
 * Session skills only exist on a Standard-tier conversation, and the route is
 * behind the same tier config. A failure hides the section rather than
 * shouting: a chat without skills is the normal case, not an error.
 */
export function useSessionSkills(conversationId: string) {
    return useQuery({
        queryKey: chatKeys.sessionSkills(conversationId),
        queryFn: ({ signal }) => getSessionSkills(conversationId, signal),
        enabled: Boolean(conversationId),
        retry: false,
    });
}

/**
 * The tiers this user may pick. Entitlements change rarely, and a refetch
 * mid-conversation would reshuffle the tier row under the user's thumb.
 */
export function useTiers(taskType = 'direct_chat') {
    return useQuery({
        queryKey: tierKeys.forTask(taskType),
        queryFn: ({ signal }) => fetchTiers(taskType, signal),
        staleTime: 10 * 60_000,
    });
}

/**
 * How long chat trusts another feature's list it offers as a choice (the
 * knowledge bases, the projects): they change rarely, and the composer and the
 * details sheet ask for them every time they open.
 */
export const CHOICE_LIST_STALE_MS = 5 * 60_000;
