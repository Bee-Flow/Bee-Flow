import type { AnalyticsScope } from '../../analyticsApi';
import type { DrillHandler } from '../ui.types';

/** A response that is either the bare row list or `{ data: rows }`, depending on the Umami build. */
export type Listish<T> = (T[] & { data?: undefined }) | { data?: T[] } | null | undefined;

export interface BehaviorSectionProps {
    scope: AnalyticsScope;
    onDrill: DrillHandler;
}

export type FunnelRow = { value?: string; x?: string; type?: string; visitors?: number; y?: number; count?: number; dropoff?: number | string | null };

/** One step of a funnel: `type` is `path` or `event`. */
export type Step = { type: string; value?: string | null };

export interface FunnelPanelProps {
    scope: AnalyticsScope;
}

export type JourneyRow = { items?: string[]; path?: string[]; count?: number; y?: number; visitors?: number };

export interface JourneyPanelProps {
    scope: AnalyticsScope;
    onDrill: DrillHandler;
}

export type RetentionRow = { date?: string; cohort?: string; day?: number; offset?: number; percentage?: number | string | null; visitors?: number; returnVisitors?: number | string | null };

export interface RetentionPanelProps {
    scope: AnalyticsScope;
}

/** Umami's goal answer: `num` visitors reached it out of `total` in the period. */
export type GoalPayload = { num?: number | string | null; total?: number | string | null } | number | null;

export interface GoalsPanelProps {
    scope: AnalyticsScope;
}
