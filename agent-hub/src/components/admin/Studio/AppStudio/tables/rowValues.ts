import { displayValue } from '../runtime/uiBits';
import type { TranslateFn } from '../../../../../hooks/useTranslation';

/**
 * App Studio — how ONE cell value travels between the record endpoints and an
 * editor.
 *
 * The rows come back exactly as SQLite holds them (see the server's
 * queryCompiler.coerceValue): a yes/no is 0 or 1, a multi-select or file is a
 * JSON string, everything else is the literal. The row grid and the spreadsheet
 * import both read and write through these helpers, so a pasted value and a
 * typed value land in the column identically.
 */

/** The field facts the cell helpers read; the model carries more. */
export interface CellField {
    type?: string;
    options?: unknown[] | null;
}

/** One choice, as the editor shows it. */
export interface OptionPair {
    value: string;
    label: string;
}

/** A choice as the model stores it — options are strings OR { value, label }. */
export function optionPair(option: unknown): OptionPair {
    if (option && typeof option === 'object') {
        const o = option as { value?: unknown; label?: unknown };
        const value = o.value ?? o.label ?? '';
        return { value: String(value), label: String(o.label ?? value) };
    }
    return { value: String(option ?? ''), label: String(option ?? '') };
}

/** The usable choices of a select/multi-select field (blank placeholders drop). */
export function optionPairs(field: CellField | null | undefined): OptionPair[] {
    const raw: unknown[] = Array.isArray(field?.options) ? (field?.options as unknown[]) : [];
    return raw.map(optionPair).filter((o) => o.value !== '');
}

/** Multi-select/file values arrive as a JSON string; a single value as itself. */
export function listValue(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    return value == null || value === '' ? [] : [value];
}

/** SQLite has no boolean: 0/1 (and their text forms) mean no/yes. */
export function boolValue(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const t = String(value ?? '').trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'yes';
}

/**
 * The text a read-only cell shows. Dates keep their stored spelling rather than
 * being localised: '2026-03-14' has no time zone, so formatting it through
 * Date would shift the day for every viewer west of Greenwich.
 */
export function cellText(value: unknown, field: CellField | null | undefined, t?: TranslateFn | null): string {
    const type = field?.type || 'text';
    if (type === 'bool') return boolValue(value)
        ? (t ? t('studio_apps_tables.cell.yes', 'Yes') : 'Yes')
        : (t ? t('studio_apps_tables.cell.no', 'No') : 'No');
    if (type === 'multiselect' || type === 'file') {
        const list = listValue(value);
        return list.length ? list.map((v) => optionPair(v).label).join(', ') : displayValue(null);
    }
    if (type === 'date' || type === 'datetime') {
        const text = String(value ?? '').replace('T', ' ');
        return text || displayValue(null);
    }
    if (type === 'select') {
        const match = optionPairs(field).find((o) => o.value === String(value ?? ''));
        return match ? match.label : displayValue(value);
    }
    return displayValue(value);
}

/** What a date/datetime input needs: it only accepts 'YYYY-MM-DD[THH:mm]'. */
export function dateInputValue(value: unknown, type: string | null | undefined): string {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return type === 'datetime' ? text.replace(' ', 'T').slice(0, 16) : text.slice(0, 10);
}
