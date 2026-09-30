/** Query keys for integrations. The user-settings key keeps its `settings` root. */

export const integrationKeys = {
    status: (provider: string) => ['integrations', 'status', provider] as const,
    userSettings: ['settings', 'user-settings'] as const,
};
