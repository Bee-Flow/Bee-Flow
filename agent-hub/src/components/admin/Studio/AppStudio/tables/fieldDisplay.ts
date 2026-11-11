import type { ModelField } from './tablesManagerModel';

/**
 * The schema-3 shape of a data-model field, as the table editor edits it: the text `format` and
 * the `display` block, plus what choosing an autonumber means for the rest of the field. The
 * server checks the same per-type lists (core/dataEngine/fieldFormats.mts); fieldDisplay.test.ts
 * pins this copy to it.
 *
 * Like fieldRules.ts, every helper returns a NEW field and removes a key instead of writing it
 * empty, so a field nobody gave a format or a display keeps exactly the bytes it had.
 */

export interface FieldDisplay {
    currency?: string;
    decimals?: number;
    unit?: string;
    dateStyle?: string;
}

export type DisplayKey = keyof FieldDisplay;

export const TEXT_FORMATS = ['email', 'url', 'phone'] as const;

/** Which display keys apply to a field type. */
export const DISPLAY_BY_TYPE: Readonly<Record<string, readonly DisplayKey[]>> = {
    number: ['currency', 'decimals', 'unit'],
    computed: ['currency', 'decimals', 'unit'],
    date: ['dateStyle'],
    datetime: ['dateStyle'],
};

export const DATE_STYLES = ['short', 'medium', 'long', 'full'] as const;

/** The currencies the picker offers; a code set elsewhere (the AI builder) is shown as well. */
export const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'JPY'] as const;

export function displayOf(field: ModelField): FieldDisplay {
    const d = field.display;
    return d && typeof d === 'object' && !Array.isArray(d) ? d as FieldDisplay : {};
}

/** The field with one display key set, or removed when empty; `display` goes when nothing is left. */
export function withDisplay<K extends DisplayKey>(field: ModelField, key: K, value: FieldDisplay[K] | null): ModelField {
    const next: FieldDisplay = { ...displayOf(field) };
    if (value === undefined || value === null || value === '') delete next[key];
    else next[key] = value as FieldDisplay[K];
    // A currency and a unit do not go together: setting one drops the other.
    if (key === 'currency' && next.currency) delete next.unit;
    if (key === 'unit' && next.unit) delete next.currency;
    const { display: _old, ...rest } = field;
    return Object.keys(next).length ? { ...rest, display: next } : rest;
}

/** The field with a text format, or without one (null). */
export function withFormat(field: ModelField, value: string | null): ModelField {
    const { format: _old, ...rest } = field;
    return value ? { ...rest, format: value } : rest;
}

/**
 * A type change: the format and display of the old type do not apply to the new one, and an
 * autonumber is always unique, never required and has no default (the server refuses otherwise).
 */
export function withTypeShape(field: ModelField, type: string): ModelField {
    const { format: _f, display: _d, ...rest } = field;
    if (type !== 'autonumber') return rest;
    const { default: _default, ...noDefault } = rest;
    return { ...noDefault, required: false, unique: true };
}
