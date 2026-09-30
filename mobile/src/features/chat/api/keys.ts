/** React Query keys for chat. The hooks own them; nothing else spells one out. */
export const chatKeys = {
    conversations: ['chat', 'conversations'] as const,
    conversation: (id: string) => ['chat', 'conversation', id] as const,
    labels: ['chat', 'labels'] as const,
    sessionSkills: (id: string) => ['chat', 'session-skills', id] as const,
};

/** The tiers a user may pick, per task type — entitlements, not preferences. */
export const tierKeys = {
    forTask: (taskType: string) => ['chat', 'tiers', taskType] as const,
};

/** What the composer offers and claims: the shield's status and the media gates. */
export const composerKeys = {
    shield: ['chat', 'shield-status'] as const,
    flags: ['chat', 'composer-flags'] as const,
};
