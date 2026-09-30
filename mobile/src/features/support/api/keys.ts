/** Query keys for support threads. */

export const supportKeys = {
    threads: ['support', 'mine'] as const,
    thread: (id: string) => ['support', 'thread', id] as const,
};
