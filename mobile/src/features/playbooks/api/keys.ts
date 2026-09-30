/** React Query keys for playbooks. */

export const playbookKeys = {
    all: ['playbooks'] as const,
    list: ['playbooks', 'list'] as const,
    detail: (id: string) => ['playbooks', 'detail', id] as const,
    app: (appId: string) => ['playbooks', 'app', appId] as const,
    tables: ['playbooks', 'tables'] as const,
    tiers: ['playbooks', 'tiers'] as const,
};
