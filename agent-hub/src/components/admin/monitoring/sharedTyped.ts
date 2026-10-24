import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card as CardJs, Empty as EmptyJs, MetricCard as MetricCardJs } from './shared';
import MarkdownRendererJs from '../../renderers/MarkdownRenderer';

// shared.jsx and MarkdownRenderer are plain JS: TypeScript reads every
// destructured prop without a default as required. These are the props the
// TypeScript monitoring views pass (same approach as blog/jsComponents.ts).

export const Card = CardJs;

export const Empty = EmptyJs;

export const MetricCard = MetricCardJs;

export const MarkdownRenderer = MarkdownRendererJs;
