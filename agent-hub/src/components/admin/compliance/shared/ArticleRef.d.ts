// Types for the legal-reference atom (ArticleRef.jsx).
import type { ReactElement, ReactNode } from 'react';
import type { Translate } from '../header/registerSpecs';

export interface ArticleRefEntry {
    regulation?: string | null;
    ref?: unknown;
}

export const REGULATION_LABEL: Readonly<Record<string, string>>;
export function regulationLabel(regulation: string | null | undefined, t: Translate): string;
export function formatRef(ref: unknown): string;
export function formatArticleRef(regulation: string | null | undefined, ref: unknown, t: Translate): string;

export interface ArticleRefProps {
    refs: ArticleRefEntry[];
    children?: ReactNode;
    max?: number;
    mono?: boolean;
    className?: string;
    testId?: string;
}

export default function ArticleRef(props: ArticleRefProps): ReactElement;
