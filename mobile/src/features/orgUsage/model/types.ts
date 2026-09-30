/**
 * What the organisation's usage reports read, after the contract readers.
 * Written from server/routes/usage.js + stores/usageStore.js (consumption),
 * stores/azureServiceUsageStore.js, routes/feedback.js +
 * stores/feedbackStore.js and routes/terminations.js +
 * stores/terminationStore.js.
 *
 * Cloud org admins get the REDACTED customer view (usage.js maybeRedact):
 * call and token counts are stripped and `estimated_cost` becomes a
 * marked-up `billed_cost`. So counts are `number | null` — null is "not
 * shown to you", never zero.
 */

export interface UsageTotals {
    /** The redacted customer view: no counts, billed cost only. */
    customerView: boolean;
    calls: number | null;
    tokens: number | null;
    cost: number;
    inputCost: number | null;
    outputCost: number | null;
    azureCost: number;
    activeUsers: number;
}

export interface TimelinePoint {
    period: string;
    cost: number;
    tokens: number | null;
}

/** One row of any breakdown report, whatever it is grouped by. */
export interface BreakdownRow {
    key: string;
    title: string;
    subtitle: string | null;
    calls: number | null;
    tokens: number | null;
    cost: number;
}

export type BreakdownReport =
    | 'users'
    | 'models'
    | 'sources'
    | 'agents'
    | 'models-by-agent'
    | 'models-by-user'
    | 'azure';

export interface FeedbackSummary {
    total: number;
    up: number;
    down: number;
    withComments: number;
}

export interface FeedbackItem {
    id: string;
    rating: 'up' | 'down';
    comment: string | null;
    userId: string | null;
    agentName: string | null;
    model: string | null;
    source: string | null;
    createdAt: string;
    hasConversation: boolean;
}

export type TerminationType = 'max_tokens' | 'max_iterations' | 'error' | 'aborted';

export interface TerminationSummary {
    total: number;
    byType: Record<TerminationType, number>;
}

export interface Termination {
    id: number;
    timestamp: string;
    type: string;
    agentName: string | null;
    model: string | null;
    errorCode: string | null;
    errorLine: string | null;
}

export interface TerminationsByAgent {
    agentId: string | null;
    agentName: string | null;
    total: number;
    errors: number;
}

export interface TerminationPoint {
    period: string;
    type: string;
    count: number;
}
