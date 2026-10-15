import type { LucideIcon } from 'lucide-react';
import type { RelativeTimeInput } from '../../hooks/useRelativeTime';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { UsageRow as UsageRowData } from '../../hooks/useUsage';

// The shapes UsedByTab.tsx works with, kept apart so the component stays under its size ceiling.

/** A usage row in the contract above, plus the two fields only this table reads. */
export interface UsageEntry extends UsageRowData {
    lastAt?: string | null;
    lastLabel?: string;
}

/** What a usage endpoint may hand over: a contract row, or the legacy datatables shape. */
export interface UsageSourceRow extends UsageEntry {
    automationId?: string;
    automationTitle?: string | null;
    automationOwner?: string | null;
    mode?: string;
    columns?: (string | null | undefined)[];
}

export type UsageAdapter = (row: UsageSourceRow) => UsageEntry | null;

export interface KindVisual {
    Icon: LucideIcon | null;
    color: string;
}

export type KindLabelFn = (kind: string | null | undefined, n: number) => string;

export interface UsedByTabProps {
    /** null = not loaded; [] = loaded, nothing. */
    rows?: UsageSourceRow[] | null;
    /** Explicit loading flag (rows === null also counts). */
    loading?: boolean;
    error?: string | null;
    currentUserId?: string | null;
    onNavigate?: ((href: string) => void) | null;
    roleHeader?: string;
    emptyText?: string;
    adapt?: UsageAdapter;
    /** The kind pills above the table (default true). */
    showSummary?: boolean;
    unchecked?: string[];
    className?: string;
}

export interface UsageSummaryProps {
    counts: { kind: string; n: number }[];
    t: TranslateFn;
    kindLabel: KindLabelFn;
    incomplete?: boolean;
}

export interface UsageRowProps {
    row: UsageEntry;
    last: boolean;
    currentUserId?: string | null;
    onNavigate?: ((href: string) => void) | null;
    t: TranslateFn;
    rel: (date: RelativeTimeInput) => string;
    kindLabel: KindLabelFn;
}
