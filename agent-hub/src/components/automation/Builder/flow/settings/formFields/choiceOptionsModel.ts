/**
 * A choice question's fixed list: the text the author edits (one per line)
 * and the options array that is stored.
 *
 * The array holds plain strings for a simple list and `{ value, label?, hint? }`
 * only for a choice that has its own label or hint, so a list nobody
 * decorated is byte-identical to what older versions wrote.
 */

export interface OptionRow {
    value: string;
    label?: string;
    hint?: string;
}

/** One stored option as a row; null when it has no usable value (such rows stay invisible, as before). */
function rowOf(o: unknown): OptionRow | null {
    if (typeof o === 'string') return o ? { value: o } : null;
    if (o && typeof o === 'object') {
        const r = o as { value?: unknown; label?: unknown; hint?: unknown };
        const value = r.value == null ? '' : String(r.value);
        if (!value) return null;
        return {
            value,
            ...(typeof r.label === 'string' && r.label ? { label: r.label } : {}),
            ...(typeof r.hint === 'string' && r.hint ? { hint: r.hint } : {}),
        };
    }
    return null;
}

/** The rows the author can see and edit. */
export function visibleRows(options: unknown): OptionRow[] {
    return (Array.isArray(options) ? options : []).map(rowOf).filter((r): r is OptionRow => r !== null);
}

/** The stored options as the "one per line" text. */
export const joinOptions = (options: unknown): string => visibleRows(options).map(r => r.value).join('\n');

/** The reverse: the text the author typed as its non-blank, trimmed lines. */
export const splitOptions = (text: string): string[] => text.split('\n').map(s => s.trim()).filter(Boolean);

/** A row as it is stored: a bare string unless it carries its own label or a hint. */
export function toOption(row: OptionRow): string | OptionRow {
    // Kept as typed (a trailing space is part of typing "Brussels office");
    // text that is only blanks counts as nothing.
    const label = row.label && row.label.trim() && row.label !== row.value ? row.label : '';
    const hint = row.hint && row.hint.trim() ? row.hint : '';
    if (!label && !hint) return row.value;
    return { value: row.value, ...(label ? { label } : {}), ...(hint ? { hint } : {}) };
}

/**
 * New lines typed over the existing options. A line keeps the label and hint of
 * the option that stood at the same position, so retyping a value does not
 * throw away the words shown for it.
 */
export function mergeLines(lines: string[], options: unknown): (string | OptionRow)[] {
    const before = visibleRows(options);
    return lines.map((value, i) => toOption({ value, label: before[i]?.label, hint: before[i]?.hint }));
}

/** Set (or clear, with an empty string) one choice's label or hint. */
export function setDetail(options: unknown, i: number, key: 'label' | 'hint', text: string): (string | OptionRow)[] {
    return visibleRows(options).map((r, j) => toOption(j === i ? { ...r, [key]: text } : r));
}

/** Does any choice carry its own label or hint? (decides whether the details start open) */
export const hasDetails = (options: unknown): boolean => visibleRows(options).some(r => (r.label && r.label !== r.value) || r.hint);
