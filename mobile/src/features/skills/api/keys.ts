/** React Query keys for skills. */

export const skillKeys = {
    all: ['skills'] as const,
    list: ['skills', 'list'] as const,
    detail: (id: string) => ['skills', 'detail', id] as const,
    usageSummary: ['skills', 'usage-summary'] as const,
    usage: (id: string) => ['skills', 'usage', id] as const,
    testAgents: ['skills', 'test-agents'] as const,
    testRuns: (id: string) => ['skills', 'test-runs', id] as const,
    exampleConversations: ['skills', 'example-conversations'] as const,
    exampleMessages: (conversationId: string) => ['skills', 'example-messages', conversationId] as const,
    picker: (list: 'automations' | 'kbs' | 'tables') => ['skills', 'picker', list] as const,
};
