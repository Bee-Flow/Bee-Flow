import type { RangeParams } from '../../utils/usageHelpers';
import type { QualityPerson } from './usage/quality/qualityData';

export interface TerminationRow {
    id: string;
    timestamp?: string;
    termination_type: string;
    source?: string;
    conversation_id?: string;
    /** Pseudonym by default, display name after an audited reveal; null when unknown. */
    person?: QualityPerson | null;
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
    /** Ask for names instead of pseudonyms (the page records it in the access audit log). */
    reveal?: boolean;
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
