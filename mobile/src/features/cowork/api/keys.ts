/** React Query keys for Cowork schedules and their history. */

export const coworkKeys = {
    schedules: ['cowork', 'schedules'] as const,
    schedule: (id: string) => ['cowork', 'schedule', id] as const,
    runs: (id: string) => ['cowork', 'runs', id] as const,
};
