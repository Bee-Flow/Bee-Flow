/**
 * Contract readers for the organisation's usage reports. Aggregates arrive as
 * strings from node-postgres; `field.num*` reads them. A count the server
 * redacted (the customer view) reads as null, not 0.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    BreakdownReport,
    BreakdownRow,
    FeedbackItem,
    FeedbackSummary,
    Termination,
    TerminationPoint,
    TerminationSummary,
    TerminationsByAgent,
    TimelinePoint,
    UsageTotals,
} from '../model/types';

const readSummaryFields = shapeOf({
    total_calls: field.numOrNull,
    total_tokens: field.numOrNull,
    total_estimated_cost: field.numOrNull,
    combined_total_cost: field.numOrNull,
    billed_cost: field.numOrNull,
    total_input_cost: field.numOrNull,
    total_output_cost: field.numOrNull,
    azure_services_total_cost: field.num(0),
    unique_users: field.num(0),
});

export function readUsageTotals(raw: unknown): UsageTotals {
    const s = readSummaryFields(raw ?? {});
    // usage.js maybeRedact: counts stripped, billed_cost added.
    const customerView = s.total_calls === null && s.billed_cost !== null;
    return {
        customerView,
        calls: s.total_calls,
        tokens: s.total_tokens,
        cost: (customerView ? s.billed_cost : (s.combined_total_cost ?? s.total_estimated_cost)) ?? 0,
        inputCost: s.total_input_cost,
        outputCost: s.total_output_cost,
        azureCost: s.azure_services_total_cost,
        activeUsers: s.unique_users,
    };
}

/** `/api/usage/azure-services/summary` → its `total_cost`. */
export function readAzureTotal(raw: unknown): number {
    return field.num(0)(pick(raw, 'total_cost'));
}

const readTimelineRows = shapeListOf({
    period: field.str(''),
    estimated_cost: field.numOrNull,
    billed_cost: field.numOrNull,
    total_tokens: field.numOrNull,
});

export function readTimeline(raw: unknown): TimelinePoint[] {
    return readTimelineRows(raw).map((r) => ({
        period: r.period,
        cost: r.estimated_cost ?? r.billed_cost ?? 0,
        tokens: r.total_tokens,
    }));
}

const readUsageRows = shapeListOf({
    user_id: field.strOrNull,
    display_name: field.strOrNull,
    model: field.strOrNull,
    source: field.strOrNull,
    agent_id: field.strOrNull,
    agent_name: field.strOrNull,
    service_type: field.strOrNull,
    calls: field.numOrNull,
    total_tokens: field.numOrNull,
    estimated_cost: field.numOrNull,
    billed_cost: field.numOrNull,
    total_cost: field.numOrNull,
});

type UsageRow = ReturnType<typeof readUsageRows>[number];

interface Naming {
    key: string;
    title: string;
    subtitle: string | null;
}

const userOf = (r: UsageRow) => r.display_name || r.user_id || '—';
const agentKey = (r: UsageRow) => r.agent_id ?? r.agent_name ?? 'direct';

/** Which columns name a row, per report. An agentless row is direct chat (title ''). */
const NAMING: Readonly<Record<BreakdownReport, (r: UsageRow) => Naming>> = {
    users: (r) => ({ key: r.user_id ?? userOf(r), title: userOf(r), subtitle: null }),
    models: (r) => ({ key: r.model ?? '—', title: r.model ?? '—', subtitle: null }),
    sources: (r) => ({ key: r.source ?? 'other', title: r.source ?? 'other', subtitle: null }),
    agents: (r) => ({ key: agentKey(r), title: r.agent_name ?? '', subtitle: null }),
    'models-by-agent': (r) => ({ key: `${agentKey(r)}|${r.model}`, title: r.agent_name ?? '', subtitle: r.model }),
    'models-by-user': (r) => ({ key: `${r.user_id}|${r.model}`, title: userOf(r), subtitle: r.model }),
    azure: (r) => ({ key: r.service_type ?? '—', title: r.service_type ?? '—', subtitle: null }),
};

/** Any breakdown report, most expensive first (the server orders most by cost, not all). */
export function readBreakdown(report: BreakdownReport, raw: unknown): BreakdownRow[] {
    return readUsageRows(raw)
        .map((r, i) => {
            const name = NAMING[report](r);
            return {
                ...name,
                key: `${name.key}#${i}`,
                calls: r.calls,
                tokens: r.total_tokens,
                cost: r.estimated_cost ?? r.billed_cost ?? r.total_cost ?? 0,
            };
        })
        .sort((a, b) => b.cost - a.cost);
}

// ── Feedback ──────────────────────────────────────────────────────────

export function readFeedbackSummary(raw: unknown): FeedbackSummary {
    const s = shapeOf({ total: field.num(0), thumbs_up: field.num(0), thumbs_down: field.num(0), with_comments: field.num(0) })(raw ?? {});
    return { total: s.total, up: s.thumbs_up, down: s.thumbs_down, withComments: s.with_comments };
}

const readFeedbackRows = shapeListOf({
    id: field.str(''),
    rating: field.oneOf(['up', 'down'] as const, 'down'),
    comment: field.strOrNull,
    user_id: field.strOrNull,
    agent_name: field.strOrNull,
    agent_id: field.strOrNull,
    model: field.strOrNull,
    source: field.strOrNull,
    created_at: field.str(''),
    conversation_snapshot: field.raw,
});

export function readFeedback(raw: unknown): FeedbackItem[] {
    return readFeedbackRows(raw).map((r, i) => ({
        id: r.id || `f${i}`,
        rating: r.rating,
        comment: r.comment || null,
        userId: r.user_id,
        agentName: r.agent_name ?? r.agent_id,
        model: r.model,
        source: r.source,
        createdAt: r.created_at,
        hasConversation: Boolean(r.conversation_snapshot),
    }));
}

// ── Terminations ──────────────────────────────────────────────────────

export function readTerminationSummary(raw: unknown): TerminationSummary {
    const by = shapeOf({ max_tokens: field.num(0), max_iterations: field.num(0), error: field.num(0), aborted: field.num(0) })(pick(raw, 'by_type') ?? {});
    return { total: field.num(0)(pick(raw, 'total')), byType: by };
}

const readTerminationRows = shapeListOf({
    id: field.num(0),
    timestamp: field.str(''),
    termination_type: field.str(''),
    agent_name: field.strOrNull,
    model: field.strOrNull,
    error_code: field.strOrNull,
    error_first_line: field.strOrNull,
});

/** `/api/terminations/org` answers `{ rows }`. */
export function readTerminations(raw: unknown): Termination[] {
    return readTerminationRows(pick(raw, 'rows')).map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        type: r.termination_type,
        agentName: r.agent_name,
        model: r.model,
        errorCode: r.error_code,
        errorLine: r.error_first_line,
    }));
}

const readByAgentRows = shapeListOf({ agent_id: field.strOrNull, agent_name: field.strOrNull, total: field.num(0), errors: field.num(0) });

export function readTerminationsByAgent(raw: unknown): TerminationsByAgent[] {
    return readByAgentRows(pick(raw, 'rows')).map((r) => ({ agentId: r.agent_id, agentName: r.agent_name, total: r.total, errors: r.errors }));
}

const readPointRows = shapeListOf({ period: field.str(''), termination_type: field.str(''), count: field.num(0) });

export function readTerminationTimeline(raw: unknown): TerminationPoint[] {
    return readPointRows(pick(raw, 'rows')).map((r) => ({ period: r.period, type: r.termination_type, count: r.count }));
}
