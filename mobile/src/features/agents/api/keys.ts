/** React Query keys for agents. The hooks own them; nothing else spells one out. */
export const agentKeys = {
    /** The merged list of agents the signed-in user can actually open. */
    all: ['agents', 'list'] as const,
    detail: (id: string) => ['agents', 'detail', id] as const,
    /** The concept the editor opens (`?draft=1`): not the view a chat runs on. */
    draft: (id: string) => ['agents', 'draft', id] as const,
    tools: (id: string) => ['agents', 'tools', id] as const,
    components: ['agents', 'components'] as const,
    categories: ['agents', 'categories'] as const,
    favorites: ['agents', 'favorites'] as const,
    conversations: (agentId: string) => ['agents', 'conversations', agentId] as const,
    allConversations: ['agents', 'conversations', 'all'] as const,
    conversation: (agentId: string, conversationId: string) =>
        ['agents', 'conversation', agentId, conversationId] as const,
};
