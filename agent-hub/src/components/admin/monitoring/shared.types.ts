import type { UsageRow } from './drawer/drawerTypes';
import type React from 'react';
import type { ReactNode, ComponentType, CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';

/** A usage row or one recent call, with the fields the monitoring pages read beyond UsageRow's. */
export interface UsageRecord extends UsageRow {
    id?: string | number;
    created_at?: string | number;
    reasoning_tokens?: number;
    avg_duration_ms?: number;
    cache_creation_tokens?: number;
    input_cost?: number;
    output_cost?: number;
    agent_id?: string;
    user_id?: string;
    display_name?: string;
    conversation_id?: string;
    models?: UsageRecord[];
    models_used?: string;
    source?: string;
    type?: string;
}

export interface ModelUsage extends UsageRecord { model: string }

export interface AgentUsage extends UsageRecord { agent_id: string }

export interface UserUsage extends UsageRecord { user_id: string }

export interface ToolUsage { tool_name: string; calls: number }

/** `GET /api/usage/summary`. */
export interface UsageSummary {
    total_calls?: number;
    total_tokens?: number;
    total_estimated_cost?: number;
    total_billed_cost?: number | string;
    avg_duration_ms?: number;
    total_cached_tokens?: number;
    total_reasoning_tokens?: number;
    total_cache_creation_tokens?: number;
}

/** One bucket of the token / cost timelines (and of the support insights volume). */
export interface ChartPoint {
    period?: string;
    calls?: number;
    total?: number;
    total_tokens?: number;
    total_cost?: number;
    total_billed_cost?: number;
}

export interface CardProps {
    title?: ReactNode;
    icon?: ComponentType<{ style?: CSSProperties }>;
    style?: CSSProperties;
    children?: ReactNode;
    action?: ReactNode;
}

export interface EmptyProps {
    text: ReactNode;
}

export interface MetricCardProps {
    icon: ComponentType<{ style?: CSSProperties }>;
    label: ReactNode;
    value: ReactNode;
    color: string;
    subtitle?: ReactNode;
    delta?: number | null;
    deltaLabel?: ReactNode;
}

export interface InOutBarProps {
    input?: number;
    output?: number;
    height?: number;
    style?: CSSProperties;
}

export interface InOutLabelProps {
    input?: number;
    output?: number;
    inputCost?: number | null;
    outputCost?: number | null;
    showCost?: boolean;
}

export interface SvgAreaChartProps {
    data?: ChartPoint[] | null;
    yKey?: Exclude<keyof ChartPoint, 'period'>;
    label?: string;
    color?: string;
    height?: number;
    formatY?: (value: number) => ReactNode;
    formatLabel?: (point: ChartPoint) => ReactNode;
}

export interface DonutItem {
    label: string;
    value?: number;
    color?: string;
}

export interface DonutChartProps {
    items: DonutItem[];
    size?: number;
    centerLabel?: string;
    centerValue?: string;
}

export interface FilterOption {
    value: string;
    label: string;
}

export interface FilterSelectProps {
    icon: LucideIcon;
    value: string | null;
    onChange: (value: string | null) => void;
    options: FilterOption[];
    placeholder: string;
}

export interface FilterState {
    user: string | null;
    agent: string | null;
    model: string | null;
    source: string | null;
}

export interface FilterBarProps {
    filters: FilterState;
    setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
    userOptions?: FilterOption[];
    agentOptions?: FilterOption[];
    modelOptions?: FilterOption[];
    sourceOptions?: FilterOption[];
}

export interface SortableColumn<Row> {
    key: string;
    label: ReactNode;
    width?: string;
    align?: string;
    sortable?: boolean;
    color?: string;
    render?: (row: Row, index: number) => ReactNode;
}

export interface SortableTableProps<Row> {
    columns: SortableColumn<Row>[];
    data: Row[];
    onRowClick?: (row: Row) => void;
    emptyText?: ReactNode;
    maxRows?: number;
}

export interface ModelRowProps {
    model: UsageRecord;
    index: number;
    maxTokens: number;
    cost?: number | null;
}

export interface SkeletonProps {
    height?: number;
    style?: CSSProperties;
}

export interface SkeletonGridProps {
    count?: number;
    height?: number;
}
