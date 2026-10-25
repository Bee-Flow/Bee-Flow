import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { AnalyticsScope } from '../analyticsApi';

// Shapes shared by ui.tsx and the analytics sections.

/** An icon component that takes a style (a lucide icon, or the tinted wrapper around one). */
type IconComponent = ComponentType<{ style?: CSSProperties }>;

/** One row of an Umami breakdown: `x` is the dimension value, `y` its count. */
export interface XYRow {
    x?: string | null;
    y?: number;
}

/** A breakdown row as `toRows` shapes it for the table: `isBlank` marks a missing label. */
export type BreakdownRow =
    | { label: string; isBlank: false; count: number; _key: string }
    | { label: null; isBlank: true; count: number; _key: string };

/** The dashboard-wide drill-down: add the filter `dim = value`. */
export type DrillHandler = (dim: string, value?: string | null) => void;

/** A stat field is `{ value, prev }` or a bare number, depending on the Umami version. */
export type StatField = number | { value?: number | null; prev?: number | null } | null | undefined;

export type CompareKind = 'count' | 'rate' | 'duration' | 'ratio';
type CompareState = 'up' | 'down' | 'flat' | 'new' | 'none';

export interface CompareResult {
    delta: number | null;
    display: string | null;
    state: CompareState;
}

export interface CardProps {
    title?: ReactNode;
    icon?: IconComponent;
    children?: ReactNode;
    style?: CSSProperties;
    action?: ReactNode;
    iconColor?: string;
}

export interface StatTileProps {
    icon?: IconComponent;
    label?: ReactNode;
    value?: ReactNode;
    color?: string;
    delta?: number | null;
    deltaLabel?: string;
    goodWhenDown?: boolean;
    subtitle?: ReactNode;
    deltaDisplay?: ReactNode;
    state?: CompareState;
}

export interface RenderStatTileArgs extends Omit<StatTileProps, 'icon' | 'deltaDisplay'> {
    Icon?: IconComponent;
    chipDisplay: ReactNode;
    t: TranslateFn;
}

export interface ErrorNoteProps {
    message?: ReactNode;
    onRetry?: () => void;
    compact?: boolean;
}

export interface SkeletonProps {
    height?: number;
    style?: CSSProperties;
}

export interface AsyncCardProps {
    title?: ReactNode;
    icon?: IconComponent;
    loading?: boolean;
    error?: ReactNode;
    onRetry?: () => void;
    isEmpty?: boolean;
    emptyText?: ReactNode;
    children?: ReactNode;
    right?: ReactNode;
    height?: number;
}

export interface BreakdownTableProps {
    rows?: unknown;
    labelHeader?: ReactNode;
    valueHeader?: ReactNode;
    onDrill?: (label: string) => void;
    maxRows?: number;
    emptyText?: ReactNode;
    blankLabel?: string;
}

export interface ShareBarProps {
    value: number;
    of: number;
    color?: string;
    height?: number;
    width?: number;
    label?: string;
}

interface SplitBarSegment {
    label?: ReactNode;
    value?: number;
    color?: string;
}

export interface SplitBarProps {
    segments?: SplitBarSegment[];
    mode?: 'stacked' | 'diverging';
    height?: number;
    legend?: boolean;
    formatValue?: (value: number | undefined) => ReactNode;
}

export interface BarListProps {
    /** A blank (missing or empty) `x` is listed under `blankLabel` and is not drillable. */
    rows?: { x?: string; y?: number }[];
    onDrill?: (label: string | undefined) => void;
    max?: number;
    formatValue?: (value: number) => ReactNode;
    emptyText?: ReactNode;
    color?: string;
    peak?: number;
    blankLabel?: string;
}

/** The props every dashboard section receives from the panel shell. */
export interface SectionProps {
    scope: AnalyticsScope;
    onDrill: DrillHandler;
}
