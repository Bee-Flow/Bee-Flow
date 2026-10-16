/** The column settings a cell reads (cellValue.jsx); every member is optional. */
export interface CellColumn {
    format?: string;
    align?: 'left' | 'right' | 'center';
    truncate?: boolean;
    /** Value to tone / label. */
    toneMap?: Array<{ value?: unknown; tone?: string; label?: unknown } | null | undefined>;
    /** Sibling column whose value is (or maps to) the tone. */
    toneFrom?: string;
    /** Fixed tone (progress bar). */
    tone?: string;
    /** Tone of the dash shown for an empty cell. */
    emptyTone?: string;
    /** Sibling column holding a short flag text. */
    flagFrom?: string;
    flagTone?: string;
    /** Sibling column shown as a second line. */
    subtextFrom?: string;
    subtextToneFrom?: string;
    /** Sibling column used as a label by the formats that take one. */
    labelFrom?: string;
    badgeStyle?: string;
    /** Progress maximum. */
    max?: number;
}

/**
 * Props of CellValue (cellValue.jsx). `now` is epoch milliseconds from the
 * runtime scope; without it a 'relative' cell shows its timestamp.
 */
export interface CellValueProps {
    value?: unknown;
    format?: string;
    col?: CellColumn | null;
    row?: Record<string, unknown> | null;
    now?: number | null;
}
