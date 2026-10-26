import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    agentConversationsOptions, allConversationsOptions, conversationLabelsOptions,
    directChatTiersOptions, directConversationsOptions,
} from '../api/queries/hubData';
import { useCacheSetter } from './useCacheState';
import type { ConversationLabel, ConversationRow } from './useConversationMeta';

const NO_ROWS: ConversationRow[] = [];
const NO_LABELS: ConversationLabel[] = [];
const NO_TIERS: Record<string, unknown> = {};

interface ConversationListsArgs {
    selectedAgentId: string | undefined;
    directChatMode: boolean;
    chatHistoryMode: string;
}

/**
 * The conversation lists the sidebar shows, and what belongs with them: the
 * selected agent's conversations, the direct conversations, the labels, the
 * "All Chats" timeline and the direct-chat model tiers. Each is a query; the
 * `set*` writers edit its cache (rename, pin, delete are optimistic) and the
 * `load*` functions re-read one on demand (after a chat is created or shared).
 *
 * Which list is read follows the mode: the agent's list while an agent is
 * selected, the direct list and the tiers in direct chat, the timeline in
 * all-chats mode. Labels are read for every mode.
 */
export default function useConversationLists({ selectedAgentId, directChatMode, chatHistoryMode }: ConversationListsArgs) {
    const queryClient = useQueryClient();

    const conversationsQuery = useQuery({
        ...agentConversationsOptions(selectedAgentId ?? ''),
        enabled: !!selectedAgentId,
    });
    const directQuery = useQuery({ ...directConversationsOptions(), enabled: directChatMode });
    const labelsQuery = useQuery(conversationLabelsOptions());
    const tiersQuery = useQuery({ ...directChatTiersOptions(), enabled: directChatMode });
    const allQuery = useQuery({ ...allConversationsOptions(), enabled: chatHistoryMode === 'all-chats' });

    // The same entries the queries above read (see hubKeys): the list of the selected agent, if any.
    const setConversations = useCacheSetter<ConversationRow[]>('conversations', selectedAgentId ?? null, NO_ROWS);
    const setDirectConversations = useCacheSetter<ConversationRow[]>('direct-conversations', null, NO_ROWS);
    const setConversationLabels = useCacheSetter<ConversationLabel[]>('labels', null, NO_LABELS);
    const setAllAgentConversations = useCacheSetter<ConversationRow[]>('all-conversations', null, NO_ROWS);

    // A re-read that fails keeps the list on screen; the failure is only logged.
    const reload = useCallback(async (read: () => Promise<unknown>, what: string) => {
        try { await read(); } catch (e) { console.error(`Failed to load ${what}:`, e); }
    }, []);
    const loadConversations = useCallback(async (agentId: string) => {
        if (agentId) await reload(() => queryClient.fetchQuery(agentConversationsOptions(agentId)), 'conversations');
    }, [queryClient, reload]);
    const loadDirectConversations = useCallback(() => reload(() => queryClient.fetchQuery(directConversationsOptions()), 'direct conversations'), [queryClient, reload]);
    const loadLabels = useCallback(() => reload(() => queryClient.fetchQuery(conversationLabelsOptions()), 'labels'), [queryClient, reload]);
    const loadModelTiers = useCallback(() => reload(() => queryClient.fetchQuery(directChatTiersOptions()), 'model tiers'), [queryClient, reload]);

    return {
        conversations: (selectedAgentId ? conversationsQuery.data : undefined) ?? NO_ROWS,
        directConversations: directQuery.data ?? NO_ROWS,
        conversationLabels: labelsQuery.data ?? NO_LABELS,
        allAgentConversations: allQuery.data ?? NO_ROWS,
        modelTiers: tiersQuery.data ?? NO_TIERS,
        setConversations, setDirectConversations, setConversationLabels, setAllAgentConversations,
        loadConversations, loadDirectConversations, loadLabels, loadModelTiers,
    };
}
