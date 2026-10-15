export type Tab = 'funnel' | 'journey' | 'retention' | 'goals';

/** One row of a metric list: a label (x) and a count (y). */
export interface MetricRow {
    x: string;
    y: number;
}

/** One step of a funnel: a page or an event, by name. */
export interface StepSpec {
    type: string;
    value: string;
}

export interface FunnelRow {
    value?: string;
    x?: string;
    type?: string;
    visitors?: number;
    y?: number;
    count?: number;
    dropoff?: number | null;
}

export type FunnelPayload = FunnelRow[] | { data?: FunnelRow[] } | null | undefined;

export interface JourneyRow {
    items?: string[];
    path?: string[];
    count?: number;
    y?: number;
    visitors?: number;
}

export type JourneyPayload = JourneyRow[] | { data?: JourneyRow[] } | null | undefined;

export interface RetentionRow {
    date?: string;
    cohort?: string;
    day?: number;
    offset?: number;
    percentage?: number | null;
    visitors?: number;
    returnVisitors?: number | null;
}

export type RetentionPayload = RetentionRow[] | { data?: RetentionRow[] } | null | undefined;

export interface CohortAcc {
    cohort: string;
    visitors: number;
    days: Map<number, number | null>;
}

export interface GoalPayload {
    num?: number | string;
    total?: number | string;
}
