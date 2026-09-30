/**
 * Query keys for usage and the plan. The licence and consumer-plan keys keep
 * their original `settings` root: Settings, Organisation, Administration and
 * Usage all read the same cached licence.
 */

export const usageKeys = {
    summary: (days: number, userId: string | null) => ['usage', 'summary', days, userId] as const,
    costTimeline: (days: number, userId: string | null) =>
        ['usage', 'cost-timeline', days, userId] as const,
    byModel: (days: number, userId: string | null) => ['usage', 'by-model', days, userId] as const,
    license: ['settings', 'license'] as const,
    consumerUsage: ['settings', 'consumer-usage'] as const,
};
