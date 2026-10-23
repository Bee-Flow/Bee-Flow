import type { TranslateParams } from '../../../../../../hooks/useTranslation';

/** Formats whose natural home is the right edge of the column. */
/** The column settings a cell reads. A grid column (or its spec) is passed as is; the rest of its keys are ignored here. */
export interface CellColumn {
    align?: string;
    format?: string;
    toneMap?: { value?: unknown; label?: unknown; tone?: string | null }[];
    toneFrom?: string;
    emptyTone?: string;
    badgeStyle?: string;
    max?: number;
    tone?: string;
    labelFrom?: string;
    flagFrom?: string;
    flagTone?: string;
    subtextFrom?: string;
    subtextToneFrom?: string;
    truncate?: boolean;
}

/**
 * The tone for one cell, from the column's own configuration.
 *
 * `toneMap` is the author naming tones value by value (the shape `list` and
 * `kanban` already use). `toneFrom` names a SIBLING column whose value IS the
 * tone — which is what finally uses the `color` every config table in a
 * template already stores next to its rows, and what stopped every status pill
 * on every screen from being the same grey.
 */
export interface ToneForCellArgs {
    col?: CellColumn | null;
    row?: unknown;
    value: unknown;
}

/** The label for one cell — a toneMap entry may relabel the stored value. */
export interface LabelForCellArgs {
    col?: CellColumn | null;
    value: unknown;
}

export interface PillProps {
    children?: React.ReactNode;
    tone?: string | null;
    dot?: boolean;
}

/**
 * A small uppercase marker beside the main text (spec: columns[].flagFrom) —
 * the SPOED case: one word that must be seen before the description is read,
 * without spending a whole column on it.
 */
export interface CellFlagProps {
    text: string;
    tone: string;
}

/**
 * A person's face without a photo.
 *
 * The tone is picked from the NAME, not at random, so the same colleague keeps
 * the same colour on every screen and across reloads — a monogram that changed
 * hue per render would be worse than no colour at all.
 */
export interface MonogramProps {
    name: unknown;
    size?: number;
}

/** The format switch — one cell's MAIN content, before any decorations. */
export interface RenderMainValueArgs {
    value: unknown;
    format: string;
    col?: CellColumn | null;
    row?: unknown;
    now: number | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/** @param {import('./cellValue.types').CellValueProps} props */
export interface CellValueProps {
    value?: unknown;
    format?: string;
    col?: CellColumn | null;
    row?: unknown;
    now?: number | null;
}
