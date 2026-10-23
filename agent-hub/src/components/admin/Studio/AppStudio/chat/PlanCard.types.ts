import type { ROW_ID } from './PlanCard.rowId';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';

/** One row of the plan the model authored: an object, or a bare string. */
export interface PlanObjectRow {
    key?: string;
    name?: string;
    label?: string;
    type?: string;
    seedCount?: number;
    fields?: PlanRow[];
    [ROW_ID]?: string;
    [other: string]: unknown;
}

export type PlanRow = string | PlanObjectRow;

/** The four editable lists of the plan. */
export type PlanList = 'tables' | 'roles' | 'datasets' | 'screens';

/** The plan as the card edits it. */
export interface PlanDraft {
    title: string;
    summary: string;
    tables: PlanRow[];
    roles: PlanRow[];
    datasets: PlanRow[];
    screens: PlanRow[];
    openQuestions: PlanRow[];
    [other: string]: unknown;
}

export interface PlanCardProps {
    pendingPlan: { planId?: string | null; plan?: unknown } | null | undefined;
    onBuild?: (plan: PlanDraft) => void;
    onDiscuss: () => void;
    disabled?: boolean;
}

/** A titled group with a leading icon. */
export interface SectionProps {
    icon: LucideIcon;
    title: string;
    children?: React.ReactNode;
}

/** One editable row: inline-rename input + optional subtitle + delete. */
export interface RowProps {
    value: string;
    placeholder: string;
    ariaLabel: string;
    subtitle?: string;
    small?: boolean;
    disabled: boolean;
    onChange?: (value: string) => void;
    onRemove: () => void;
}

/** A tiny inline "add a row" form. */
export interface AddRowProps {
    label: string;
    small?: boolean;
    disabled: boolean;
    onAdd?: (v: string) => void;
}
