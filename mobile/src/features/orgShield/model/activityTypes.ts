/**
 * What the "What happened" endpoints return, the parts the phone shows.
 * Written from server/routes/usage.js, stores/guardrailEventStore.js
 * (getGuardrailOverview, getRecentGuardrailEvents) and
 * stores/integrationActivityStore.js (getIntegrationOverview, getEgressLog).
 */

import type { DestinationRow } from './activity';

/** `GET /api/usage/guardrails/overview`. */
export interface GuardOverview {
    totalEvents: number;
    piiCount: number;
    dlpBlocked: number;
    uniqueUsers: number;
    topCategories: { category: string; count: number }[];
    topUsers: { userId: string; name: string; total: number }[];
    lastEventAt: string | null;
}

/** `GET /api/usage/integrations/overview`. */
export interface IntegrationOverview {
    totalCalls: number;
    nonEuCount: number;
    piiNonEuCount: number;
    blockedCount: number;
    sovereigntyScore: number | null;
    scoreDelta: number | null;
    destinations: DestinationRow[];
    piiCategories: { category: string; count: number }[];
}

/** One row of `GET /api/usage/guardrails/recent`. */
export interface GuardEvent {
    id: number;
    timestamp: string;
    violationType: string;
    categories: string;
    action: string | null;
    userName: string;
    source: string | null;
    agentName: string | null;
    agentId: string | null;
    automationId: string | null;
}

/** One row of `GET /api/usage/integrations/egress`. */
export interface EgressRow {
    id: number;
    timestamp: string;
    integration: string;
    destination: string;
    countryName: string | null;
    isEu: boolean;
    isLocal: boolean;
    piiCategories: string;
    status: string | null;
    userName: string;
}

export interface ShieldActivity {
    guard: GuardOverview;
    integrations: IntegrationOverview;
    events: GuardEvent[];
    egress: EgressRow[];
}
