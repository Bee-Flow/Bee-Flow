/**
 * Agents' reads. Screens and components use these, never useQuery itself, so
 * the keys and cache lifetimes are decided once.
 */

import { useQuery } from '@tanstack/react-query';

import {
    getAgent,
    getAgentConversation,
    listAgentConversations,
    listAgents,
    listAgentTools,
    listAllConversations,
    listCategories,
    listComponents,
    listFavorites,
} from '../api/endpoints';
import { agentKeys } from '../api/keys';

export function useAgents() {
    return useQuery({ queryKey: agentKeys.all, queryFn: ({ signal }) => listAgents(signal) });
}

export function useAgent(id: string) {
    return useQuery({
        queryKey: agentKeys.detail(id),
        queryFn: ({ signal }) => getAgent(id, signal),
        enabled: Boolean(id),
    });
}

/**
 * Tools come from the dedicated endpoint rather than `agent.tools`: it is the
 * one that is visibility-gated the same way the detail is, and it is the
 * shape the fixed params arrive in.
 */
export function useAgentTools(agentId: string) {
    return useQuery({
        queryKey: agentKeys.tools(agentId),
        queryFn: ({ signal }) => listAgentTools(agentId, signal),
    });
}

/**
 * The catalogue that turns `web-search` into "Web Search". Org-wide and
 * effectively static, so it is cached hard and never blocks a screen.
 */
export function useAgentComponents() {
    return useQuery({
        queryKey: agentKeys.components,
        queryFn: ({ signal }) => listComponents(signal),
        staleTime: 30 * 60_000,
    });
}

/** Categories are org configuration; they change on the order of months. */
export function useAgentCategories() {
    return useQuery({
        queryKey: agentKeys.categories,
        queryFn: ({ signal }) => listCategories(signal),
        staleTime: 10 * 60_000,
    });
}

/** DB-backed per user, so the same agents are starred here and on the web. */
export function useFavoriteAgents() {
    return useQuery({ queryKey: agentKeys.favorites, queryFn: ({ signal }) => listFavorites(signal) });
}

export function useAgentConversations(agentId: string) {
    return useQuery({
        queryKey: agentKeys.conversations(agentId),
        queryFn: ({ signal }) => listAgentConversations(agentId, signal),
        enabled: Boolean(agentId),
    });
}

/** Recent conversations across every agent — server-capped at 50 rows. */
export function useAllAgentConversations(options: { staleTime?: number } = {}) {
    return useQuery({
        queryKey: agentKeys.allConversations,
        queryFn: ({ signal }) => listAllConversations(signal),
        ...(options.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
    });
}

/** `null` is a chat the server has not created yet: nothing to fetch. */
export function useAgentConversation(agentId: string, conversationId: string | null) {
    return useQuery({
        queryKey: agentKeys.conversation(agentId, conversationId ?? 'new'),
        queryFn: ({ signal }) => getAgentConversation(agentId, conversationId as string, signal),
        enabled: Boolean(conversationId),
    });
}
