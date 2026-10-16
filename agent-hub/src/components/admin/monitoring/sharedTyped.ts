import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card as CardJs, Empty as EmptyJs, MetricCard as MetricCardJs } from './shared';
import MarkdownRendererJs from '../../renderers/MarkdownRenderer';

// shared.jsx and MarkdownRenderer are plain JS: TypeScript reads every
// destructured prop without a default as required. These are the props the
// TypeScript monitoring views pass (same approach as blog/jsComponents.ts).

export const Card = CardJs as unknown as ComponentType<{
    title?: ReactNode;
    icon?: LucideIcon;
    style?: CSSProperties;
    action?: ReactNode;
    children?: ReactNode;
}>;

export const Empty = EmptyJs as unknown as ComponentType<{ text: ReactNode }>;

export const MetricCard = MetricCardJs as unknown as ComponentType<{
    icon: LucideIcon;
    label: ReactNode;
    value: ReactNode;
    color: string;
    subtitle?: ReactNode;
    delta?: number;
    deltaLabel?: ReactNode;
}>;

export const MarkdownRenderer = MarkdownRendererJs;
