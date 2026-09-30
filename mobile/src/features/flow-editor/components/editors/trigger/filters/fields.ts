/**
 * The field shapes an app-event filter is made of, as declarative specs over
 * `draft.filter` — the web's filter sub-forms (triggerFilters.jsx) all use the
 * same five controls, and all follow one rule: an empty control CLEARS its key
 * (`value || undefined`), so the stored filter stays minimal and the matcher's
 * "if filter.X is set" checks short-circuit. A tick that is off is removed,
 * never stored as `false` — except where `false` is the meaning.
 */


import { msg, type FieldSpec, type Msg, type OptionSpec, type Words } from '@/features/flow-editor/components/editors/declarative/spec';
import { recordOf } from '@/features/flow-editor/components/editors/shared/list';
import type { FormDraft } from '@/features/flow-editor/formState';

export interface FilterForm {
    title: Msg;
    fields: readonly FieldSpec[];
}

export const filterOf = (draft: FormDraft): Record<string, unknown> => recordOf(draft.filter);

/** The draft with one filter key changed; `undefined` removes it. */
export function putFilter(draft: FormDraft, key: string, value: unknown): FormDraft {
    const next = { ...filterOf(draft) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return { filter: next };
}

interface Words2 {
    hint?: Words;
    example?: string;
}

export function textFilter(key: string, label: Msg, extra: Words2 = {}): FieldSpec {
    return {
        kind: 'text',
        id: key,
        key: `filter.${key}`,
        label,
        ...extra,
        write: (v, draft) => putFilter(draft, key, typeof v === 'string' && v ? v : undefined),
    };
}

/** A number box; blank clears. `shown` is what an unset key displays (the web's `?? 15`). */
export function numberFilter(key: string, label: Msg, extra: Words2 & { min?: number; max?: number; shown?: number } = {}): FieldSpec {
    const { min, max, shown, ...words } = extra;
    return {
        kind: 'number',
        id: key,
        key: `filter.${key}`,
        label,
        ...words,
        min,
        max,
        allowBlank: true,
        read: (draft) => filterOf(draft)[key] ?? shown ?? '',
        write: (v, draft) => putFilter(draft, key, v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v)),
    };
}

/**
 * A tick: the web's row label, and the words beside its checkbox. `inverse`:
 * the key is stored only as `false` (a default-on rule the author opts out
 * of), the web's `checked ? undefined : false`. A row hint goes in a
 * filterNote after it — the toggle row has room for one sentence.
 */
export function tickFilter(key: string, label: Msg, description: Msg, inverse = false): FieldSpec {
    return {
        kind: 'toggle',
        id: key,
        key: `filter.${key}`,
        label,
        description,
        read: (draft) => (inverse ? filterOf(draft)[key] !== false : filterOf(draft)[key] === true),
        write: (v, draft) => putFilter(draft, key, inverse ? (v ? undefined : false) : v ? true : undefined),
    };
}

/** A choice; the first option is the empty "any" that clears the key. */
export function selectFilter(key: string, label: Msg, options: readonly OptionSpec[], extra: Words2 = {}): FieldSpec {
    return {
        kind: 'select',
        id: key,
        key: `filter.${key}`,
        label,
        ...extra,
        options,
        read: (draft) => filterOf(draft)[key] ?? '',
        write: (v, draft) => putFilter(draft, key, typeof v === 'string' && v ? v : undefined),
    };
}

/** A list of short strings (the web's comma-separated box); none clears the key. */
export function listFilter(key: string, label: Msg, extra: Words2 = {}): FieldSpec {
    return {
        kind: 'list',
        id: key,
        key: `filter.${key}`,
        label,
        ...extra,
        read: (draft) => splitList(filterOf(draft)[key]),
        write: (v, draft) => {
            const rows = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
            return putFilter(draft, key, rows.length ? rows : undefined);
        },
    };
}

/** A stored list, or a legacy comma-separated string, as the list. */
export function splitList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
}

/** A standing sentence under the filter's fields. */
export function filterNote(id: string, words: Msg): FieldSpec {
    return { kind: 'note', id, hint: words };
}

/** An option that is its own word (a status, a priority): data, not copy. */
export const raw = (value: string): OptionSpec => ({ value, label: value });

export const ANY: OptionSpec = { value: '', label: msg('mobile.flow.filter.any', 'Any') };
