/** One aggregated model/agent row, or one recent call, as the usage endpoints return them. */
export interface UsageRow {
    model?: string;
    agent_name?: string;
    agent_type?: string;
    calls?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    billed_cost?: number | string;
    estimated_cost?: number;
    timestamp?: string | number;
    duration_ms?: number;
    [key: string]: unknown;
}

/** Per-1M-token rates for one model. */
export interface ModelRate {
    input: number;
    output: number;
    cacheRead?: number;
}

export type DetailType = 'model' | 'agent';

export interface DrawerDetail {
    type: DetailType;
    data: UsageRow;
}
