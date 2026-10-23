import type { TranslateParams } from '../../hooks/useTranslation';
import type { RangeParams } from '../../utils/usageHelpers';

export interface TypeBadgeProps {
    type: string;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface StackedBarChartProps {
    data: { period: string; termination_type: string; count: number }[];
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface DetailRowProps {
    label: string;
    value: string | null | undefined;
    mono?: boolean;
}

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
