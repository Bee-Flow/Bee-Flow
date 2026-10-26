// The lists the Agent Hub shell shows: favourites, the agent catalogue, the
// knowledge-base picker, conversation lists, labels and the direct-chat model
// tiers. They used to be fetched by loader functions that effects and handlers
// called and that wrote into setState owned by AgentHub.tsx; now each is a
// query, and the loaders that remain (`loadConversations()` after a new chat,
// `loadDirectConversations()` after a share) call `queryClient.fetchQuery`
// with the same options, so a write and a list read share one cache entry.
//
// The raw fetchers stay in hubDataFetches.ts (they return the Response
// exactly as authFetch does); this file orders and interprets the answers.

import { queryOptions } from '@tanstack/react-query';
import type { ConversationLabel, ConversationRow } from '../../AgentHub/useConversationMeta';
import { API_BASE } from '../../utils/helpers';
import {
    fetchAllAgentConversations, fetchDirectConversations, fetchOwnAgents, fetchPublishedAgents,
} from './hubDataFetches';
import { readOrNull } from './refusableRead';

export const hubKeys = {
    all: ['hub'] as const,
    favorites: (userId: string | undefined) => (userId ? ['hub', 'favorites', userId] : ['hub', 'favorites']) as readonly string[],
    agents: () => ['hub', 'agents'] as const,
    knowledgeBases: () => ['hub', 'knowledge-bases'] as const,
    conversations: (agentId: string) => ['hub', 'conversations', agentId] as const,
    directConversations: () => ['hub', 'direct-conversations'] as const,
    allConversations: () => ['hub', 'all-conversations'] as const,
    labels: () => ['hub', 'labels'] as const,
    directTiers: () => ['hub', 'direct-tiers'] as const,
};

/** An agent row of the catalogue (the hub reads it through its own AgentLike type). */
export interface CatalogCategory { id: string; name: string; description: string; emoji: string }
export interface AgentCatalog<A extends { id: string }> { agents: A[]; categories: CatalogCategory[] }

/**
 * The agent list shown across the hub: what is published to the user's org and
 * groups, merged with the user's own agents INCLUDING personal drafts (without
 * the second source an agent set to "Personal" vanished for its owner). A
 * record in both lists is the published one: it carries the parsed tool_params.
 * Neither list readable throws, so the last known catalogue stays.
 */
export function agentCatalogOptions<A extends { id: string }>() {
    return queryOptions({
        queryKey: hubKeys.agents(),
        queryFn: async (): Promise<AgentCatalog<A>> => {
            const [publishedRes, ownRes] = await Promise.all([fetchPublishedAgents(), fetchOwnAgents()]);
            if (!publishedRes.ok && !ownRes.ok) throw new Error('agents not readable');
            const published = publishedRes.ok ? await publishedRes.json() : [];
            const own = ownRes.ok ? await ownRes.json() : [];
            const byId = new Map<string, A>();
            for (const a of (Array.isArray(own) ? own : [])) byId.set(a.id, a);
            for (const a of (Array.isArray(published) ? published : [])) byId.set(a.id, a);
            let categories: CatalogCategory[] = [];
            try {
                const cats = await readOrNull<unknown>(`${API_BASE}/agents/categories`);
                categories = Array.isArray(cats) ? cats : [];
            } catch (e) { console.warn('Failed to load agent categories', e); }
            return { agents: Array.from(byId.values()), categories };
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * GET /api/kb for the hub's picker. Webpage-owned knowledge bases are managed
 * inside the webpage UI, not here. A refusal or a non-array answer throws, so a
 * failed refresh leaves the last known list in place instead of an empty one.
 */
export function knowledgeBaseListOptions<K>() {
    return queryOptions({
        queryKey: hubKeys.knowledgeBases(),
        queryFn: async (): Promise<K[]> => {
            const data = await readOrNull<unknown>(`${API_BASE}/api/kb?excludeContext=webpage&t=${Date.now()}`);
            if (!Array.isArray(data)) throw new Error('knowledge bases not readable');
            return data as K[];
        },
        staleTime: 0,
        retry: false,
    });
}

const newestFirst = (a: { updated_at: string | number | Date }, b: { updated_at: string | number | Date }) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

/** One agent's conversations, newest first. A refusal throws (the list on screen stays). */
export function agentConversationsOptions(agentId: string) {
    return queryOptions({
        queryKey: hubKeys.conversations(agentId),
        queryFn: async (): Promise<ConversationRow[]> => {
            const data = await readOrNull<(ConversationRow & { updated_at: string })[]>(`${API_BASE}/agents/${agentId}/conversations`);
            if (!data) throw new Error('conversations not readable');
            return data.sort(newestFirst);
        },
        staleTime: 0,
        retry: false,
    });
}

/** The user's direct (agentless) conversations. A refusal throws. */
export function directConversationsOptions() {
    return queryOptions({
        queryKey: hubKeys.directConversations(),
        queryFn: async (): Promise<ConversationRow[]> => {
            const data = await readOrNull<ConversationRow[]>(`${API_BASE}/ai/direct/conversations`);
            if (!data) throw new Error('direct conversations not readable');
            return data;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The conversation labels. A refusal throws. */
export function conversationLabelsOptions() {
    return queryOptions({
        queryKey: hubKeys.labels(),
        queryFn: async (): Promise<ConversationLabel[]> => {
            const data = await readOrNull<ConversationLabel[]>(`${API_BASE}/ai/labels`);
            if (!data) throw new Error('labels not readable');
            return data;
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * The tiers the direct chat offers: the permission- and task-aware endpoint, so
 * a custom tier appears only when the user's groups grant it AND it is allowed
 * for the direct_chat task type. A refusal throws.
 */
export function directChatTiersOptions() {
    return queryOptions({
        queryKey: hubKeys.directTiers(),
        queryFn: async (): Promise<Record<string, unknown>> => {
            const data = await readOrNull<Record<string, unknown>>(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`);
            if (!data) throw new Error('model tiers not readable');
            return data;
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * Every conversation across agents plus the direct ones ("All Chats" mode),
 * newest first. Either half unreadable reads as empty; the other still shows.
 */
export function allConversationsOptions() {
    return queryOptions({
        queryKey: hubKeys.allConversations(),
        queryFn: async (): Promise<ConversationRow[]> => {
            const [agentRes, directRes] = await Promise.all([fetchAllAgentConversations(), fetchDirectConversations()]);
            let all: ConversationRow[] = [];
            if (agentRes.ok) {
                const agentConvs = await agentRes.json();
                all = [...agentConvs.map((c: ConversationRow) => ({ ...c, _source: 'agent' }))];
            }
            if (directRes.ok) {
                const directConvs = await directRes.json();
                all = [...all, ...directConvs.map((c: ConversationRow) => ({ ...c, _source: 'direct' }))];
            }
            all.sort((a, b) => new Date((b.updated_at || b.created_at) as string).getTime() - new Date((a.updated_at || a.created_at) as string).getTime());
            return all;
        },
        staleTime: 0,
        retry: false,
    });
}
