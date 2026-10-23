import type { LucideIcon } from 'lucide-react';

export interface TypeMeta { label: string; color: string; icon: LucideIcon }

/** One termination event, as `GET /api/terminations` lists it. */
export interface TerminationRow {
    id: string | number;
    timestamp?: string | number;
    agent_id?: string;
    agent_name?: string;
    model?: string;
    termination_type: string;
    error_code?: string;
    iteration_count?: number;
    duration_ms?: number;
    attachment_count: number;
    attachment_bytes: number;
    prompt_tokens: number;
    completion_tokens?: number;
    total_tokens?: number;
    source?: string;
    conversation_id?: string;
    user_id?: string;
    organization_id?: string;
    error_class?: string;
    error_first_line?: string;
    stack_first_line?: string;
}

export interface TerminationSummary {
    total?: number;
    by_type?: Record<string, number>;
}

export interface TimelineRow {
    period: string;
    type: string;
    count: number;
}

export interface AgentTerminations {
    agent_id?: string;
    agent_name?: string;
    total?: number;
    max_tokens?: number;
    max_iterations?: number;
    errors?: number;
    aborted?: number;
}

export interface TypeBadgeProps {
    type: string;
}

/** One timeline period: its label and the count per termination type. */
export interface Bucket {
    period: string;
    [type: string]: string | number;
}

export interface TerminationsPageProps {
    range?: string;
    customStart: string;
    customEnd: string;
    refreshKey?: number;
}

export interface DetailRowProps {
    label: string;
    value?: string | null;
    mono?: boolean;
}
