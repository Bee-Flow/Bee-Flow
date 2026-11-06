import type { RangeParams } from '../../utils/usageHelpers';

export interface TerminationRow {
    id: string;
    timestamp?: string;
    termination_type: string;
    source?: string;
    conversation_id?: string;
    user_id?: string;
    agent_id?: string;
    agent_name?: string;
    model?: string;
    error_code?: string;
    error_class?: string;
    error_first_line?: string;
    stack_first_line?: string;
    iteration_count?: number;
    duration_ms?: number;
    attachment_count: number;
    attachment_bytes?: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface TerminationsByType {
    max_iterations?: number;
    max_tokens?: number;
    error?: number;
    aborted?: number;
}

export interface OrgTerminationsPanelProps {
    rangeParams: RangeParams;
    showTokens?: boolean;
}

export interface TerminationsSummary {
    total: number;
    by_type: TerminationsByType;
}

export interface TimelinePoint {
    period: string;
    termination_type: string;
    count: number;
}

export interface ByAgentRow {
    agent_id?: string;
    agent_name?: string;
    total: number;
    max_tokens?: number;
    max_iterations?: number;
    errors?: number;
    aborted?: number;
}
