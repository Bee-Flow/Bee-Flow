// The payload the Usage & Monitoring dashboard loads from /api/usage/*.
// Every field is optional where the code reads it defensively: the server
// redacts token and call counts for cloud customers, and older servers send
// some aggregates under a different name.

export interface UsageSummary {
    total_calls?: number;
    total_tokens?: number;
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_input_cost?: number;
    total_output_cost?: number;
    total_estimated_cost?: number;
    combined_total_cost?: number;
    azure_services_total_cost?: number;
    billed_cost?: number;
    unique_users?: number;
}


export interface UsageTimelineRow {
    total_tokens?: number;
    total?: number;
    total_calls?: number;
    calls?: number;
    total_cost?: number;
    estimated_cost?: number;
    billed_cost?: number;
}


export interface UsageSourceRow {
    source: string;
    calls?: number;
    total_tokens?: number;
    estimated_cost?: number;
    billed_cost?: number;
}


export interface UsageModelRow {
    model: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_cost?: number;
    output_cost?: number;
    estimated_cost?: number;
    billed_cost?: number;
    calls?: number;
}
