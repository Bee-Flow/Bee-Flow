import type React from 'react';
import type { LucideIcon } from 'lucide-react';

export type ChipValue = string | number | boolean | null;

export interface SparklineProps { values?: number[] | null; color?: string; width?: number; height?: number }

export interface StatusPillProps { label: React.ReactNode; color: string; dot?: boolean }

export interface TrendChipProps { delta?: number | null; display?: React.ReactNode; title?: string; goodWhenDown?: boolean }

export interface CardProps {
    children?: React.ReactNode;
    style?: React.CSSProperties;
    title?: React.ReactNode;
    icon?: LucideIcon;
    right?: React.ReactNode;
    pad?: boolean;
}

export interface MetricCardProps {
    icon?: LucideIcon;
    label: React.ReactNode;
    value: React.ReactNode;
    color?: string;
    subtitle?: React.ReactNode;
    spark?: number[] | null;
    size?: 'sm' | 'md' | 'lg';
    onClick?: () => void;
}

export interface MetricGridProps { children?: React.ReactNode; cols?: number; min?: number; gap?: number }

export interface MonitorHeroProps {
    accent?: string;
    eyebrow?: React.ReactNode;
    infoTip?: React.ReactNode;
    value: React.ReactNode;
    valueColor?: string;
    valueSize?: number;
    status?: { label: React.ReactNode; color: string };
    trend?: React.ReactNode;
    subline?: React.ReactNode;
    leftRatio?: number;
    children?: React.ReactNode;
    aside?: React.ReactNode;
}

export interface TabHeaderProps {
    icon?: LucideIcon;
    iconColor?: string;
    title: React.ReactNode;
    description?: React.ReactNode;
    status?: { label: React.ReactNode; color: string; dot?: boolean };
    actions?: React.ReactNode;
}

export interface AlertBannerProps {
    severity?: string;
    title?: React.ReactNode;
    message?: React.ReactNode;
    ctaLabel?: React.ReactNode;
    onCta?: () => void;
    icon?: LucideIcon;
}

export interface SectionTitleProps { children?: React.ReactNode; icon?: LucideIcon; right?: React.ReactNode }

export interface ListRowProps { children?: React.ReactNode; onClick?: () => void; style?: React.CSSProperties }

export interface FilterChipBarProps {
    value?: ChipValue;
    onChange: (value: ChipValue) => void;
    options: Array<{ value: ChipValue; label: React.ReactNode; icon?: LucideIcon; color?: string; count?: number | null }>;
    size?: 'sm' | 'md';
}

export interface DrillChipProps { axis: React.ReactNode; label?: string | null; onClear: () => void }

export interface ShowMoreProps { remaining?: number | null; onMore: () => void; label?: string }

export interface CollapsibleSectionProps {
    title: React.ReactNode;
    icon?: LucideIcon;
    count?: number | null;
    defaultOpen?: boolean;
    right?: React.ReactNode;
    children?: React.ReactNode;
}

export interface EmptyInlineProps { text: React.ReactNode; icon?: LucideIcon; boxed?: boolean }
