import type { TranslateParams } from '@/hooks/useTranslation';
import type { StarterModel } from '@/api/runtimeTypes';
import type React from 'react';

export interface InOutBarProps {
    input: number | null | undefined;
    output: number | null | undefined;
    height?: number;
    style: { marginTop: number; maxWidth: number; };
}

export interface InOutLabelProps {
    input: number | null | undefined;
    output: number | null | undefined;
    inputCost: number | null | undefined;
    outputCost: number | null | undefined;
    showCost: boolean;
}

export interface LegendProps {
    inputLabel: string;
    outputLabel: string;
}

/** One bucket of the usage timeline; which fields are there depends on the view. */
export interface TimelineRow {
    bucket?: string;
    date?: string;
    period?: string;
    calls?: number;
    total_calls?: number;
    total?: number;
    total_tokens?: number;
    total_cost?: number;
    estimated_cost?: number;
    billed_cost?: number;
}

export interface SummaryRow {
    total_calls?: number;
    billed_cost?: number;
    unique_users?: number;
    combined_total_cost?: number;
    total_estimated_cost?: number;
    total_input_cost?: number;
    total_output_cost?: number;
    azure_services_total_cost?: number;
    total_tokens?: number;
}

/** A per-user, per-model or per-source row of the usage report. */
export interface UsageMetrics {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    input_cost?: number | null;
    output_cost?: number | null;
    estimated_cost?: number | null;
    billed_cost?: number | null;
    calls?: number;
}

export interface UserRow extends UsageMetrics {
    user_id: string;
    display_name?: string;
    avatarType?: string | null;
    avatar?: string | null;
}

export interface ModelRow extends UsageMetrics {
    model: string;
}

export interface SourceRow extends UsageMetrics {
    source: string;
}

/** modelsByUser: a user x model row. */
export interface ModelUserRow extends UsageMetrics {
    user_id: string;
    display_name?: string;
    avatarType?: string | null;
    avatar?: string | null;
    model: string;
}

/** modelsByAgent: an agent x model row (a pg SUM may arrive as a string). */
export interface AgentModelRow {
    agent_name?: string;
    agent_id?: string | null;
    model?: string | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    input_cost?: number | null;
    output_cost?: number | null;
    total_tokens?: number | string | null;
    estimated_cost?: number | string | null;
}

export interface AgentGroup {
    agent_name: string;
    agent_id: string | null | undefined;
    models: AgentModelRow[];
    total_tokens: number;
    estimated_cost: number;
}

export type AzureServiceType = 'doc_intelligence' | 'content_safety' | 'pii_detection' | 'embedding';

export interface AzureTypeRow {
    service_type: AzureServiceType;
    calls?: number;
    total_pages?: number;
    total_chars?: number;
    total_tokens?: number;
    total_cost?: number;
}

/** The subscription as the License page reads it (the cloud customer view). */
export interface SubscriptionInfo {
    status?: string;
    plan_name?: string;
    billing?: {
        plan_currency?: string;
        subscription_total?: number;
        per_seat?: boolean;
        seat_quantity?: number;
        plan_price?: number;
        billing_interval?: string;
    } | null;
    effective_limits?: { max_cost_per_month?: number };
    current_usage?: { cost?: number };
    billing_period?: { startDate?: string; endDate?: string };
}

export interface TrendChartProps {
    timeline: TimelineRow[];
    title: string;
    avgLabel: string;
    noDataLabel: string;
    valueField?: keyof TimelineRow;
    valueFormatter?: (v: number) => string;
}

export interface OverviewTabProps {
    t: (key: string, fallback?: string, params?: TranslateParams) => string;
    data: {
        summary: SummaryRow | null;
        timeline: unknown[];
        users: UserRow[];
        sources: SourceRow[];
        models: ModelRow[];
        modelsByAgent: unknown[];
        modelsByUser: unknown[];
        agents?: unknown[];
    };
    subscription: Record<string, unknown> | null;
    azureServices: { summary: Record<string, unknown> | null; byType: unknown[]; byUser?: unknown[] };
    isCustomerView: boolean;
    showTokens: boolean;
    tierForModel: (model: string | null) => string | null;
    modelTiers?: { fast?: StarterModel; standard?: StarterModel; thinking?: StarterModel; } | {};
    setFilterUser: React.Dispatch<React.SetStateAction<string | null>>;
    setFilterModel: React.Dispatch<React.SetStateAction<string | null>>;
    setFilterSource: React.Dispatch<React.SetStateAction<string | null>>;
}
