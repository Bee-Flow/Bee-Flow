/** React Query keys for Cowork schedules and their history. */

export const coworkKeys = {
    schedules: ['cowork', 'schedules'] as const,
    needsYou: ['cowork', 'needs-you'] as const,
    schedule: (id: string) => ['cowork', 'schedule', id] as const,
    shared: ['cowork', 'shared'] as const,
    sharedItem: (id: string) => ['cowork', 'shared', id] as const,
    receipt: (id: string, runId: string) => ['cowork', 'receipt', id, runId] as const,
    goal: (id: string) => ['cowork', 'goal', id] as const,
    runs: (id: string) => ['cowork', 'runs', id] as const,
};
