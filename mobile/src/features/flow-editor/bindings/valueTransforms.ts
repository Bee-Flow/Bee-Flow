/**
 * The one-click value transforms of the visual value builder, and the choices
 * two of them take. Data half of agent-hub `Builder/mapping/valueParts.js`.
 *
 * Each transform is one call in the shared expression language, so a
 * transformed pick stays a plain `fn(path)` / `fn(path, "arg")` —
 * round-trippable, and readable in the raw editor. `for` orders and annotates
 * the menu; it never removes an entry.
 *
 * The words carry their English beside an i18n key (`labelEn` / `hintEn`); a
 * screen renders them through `transformLabel` / `transformHint`. Pinned by
 * valueParts.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';

export interface ValueTransform {
    id: string;
    labelEn: string;
    hintEn: string;
    for: string;
    arg?: string;
    argDefault?: string;
    arg2Default?: string;
}

/** The date notations 2c names, plus the two an author reaches for next. */
export const NL_DATE_LONG = 'D MMMM YYYY';
export const DATE_FORMATS: readonly { value: string; example: string }[] = [
    { value: NL_DATE_LONG, example: '2 september 2026' },
    { value: 'DD-MM-YYYY', example: '02-09-2026' },
    { value: 'YYYY-MM-DD', example: '2026-09-02' },
    { value: 'D MMMM YYYY, HH:mm', example: '2 september 2026, 10:26' },
];

/** The three number formats ("bedrag · percentage · kaal"). */
export const NUMBER_STYLES: readonly { value: string; labelEn: string }[] = [
    { value: 'amount', labelEn: 'an amount (€ 1.500.000)' },
    { value: 'percent', labelEn: 'a percentage (12,5%)' },
    { value: 'plain', labelEn: 'plain (1.500.000)' },
];

export const VALUE_TRANSFORMS: readonly ValueTransform[] = [
    { id: 'lower', labelEn: 'lowercase', hintEn: 'Make the text lowercase', for: 'text' },
    { id: 'upper', labelEn: 'UPPERCASE', hintEn: 'Make the text uppercase', for: 'text' },
    { id: 'trim', labelEn: 'trim spaces', hintEn: 'Remove spaces around the text', for: 'text' },
    { id: 'number', labelEn: 'as a number', hintEn: 'Read the value as a number', for: 'any' },
    { id: 'round', labelEn: 'rounded', hintEn: 'Round to a whole number', for: 'any' },
    { id: 'toStr', labelEn: 'as text', hintEn: 'Read the value as text', for: 'any' },
    { id: 'first', labelEn: 'just the first one', hintEn: 'The first item of the list', for: 'list' },
    { id: 'last', labelEn: 'just the last one', hintEn: 'The last item of the list', for: 'list' },
    {
        id: 'join', labelEn: 'all of them, joined into text',
        hintEn: 'Every value in one piece of text, with a separator', for: 'list', arg: 'separator',
    },
    { id: 'count', labelEn: 'count of items', hintEn: 'How many items the list has', for: 'list' },
    {
        id: 'formatNumber', labelEn: 'as an amount or a percentage',
        hintEn: 'Write the number for people: € 1.500.000, 12,5% or 1.500.000',
        for: 'number', arg: 'style', argDefault: 'amount',
    },
    {
        id: 'formatDate', labelEn: 'as a written date',
        hintEn: 'Choose the notation: 2 september 2026 or 02-09-2026',
        for: 'date', arg: 'format', argDefault: NL_DATE_LONG,
    },
    {
        id: 'yesNoText', labelEn: 'as your own yes / no words', hintEn: 'Choose what it says for yes and for no',
        for: 'yesno', arg: 'words', argDefault: 'yes', arg2Default: 'no',
    },
    { id: 'groupSummary', labelEn: 'as a readable summary', hintEn: 'One "Label: value" line per field', for: 'group' },
    {
        id: 'asTable', labelEn: 'as a table',
        hintEn: 'A table with one column per field, in the order they appear', for: 'table',
    },
];

export const TRANSFORM_IDS: ReadonlySet<string> = new Set(VALUE_TRANSFORMS.map((tr) => tr.id));
/** Transforms whose second argument is a quoted string. */
export const ARG1_TRANSFORMS: ReadonlySet<string> = new Set(['join', 'formatNumber', 'formatDate', 'yesNoText']);
/** …and the one that carries a third as well. */
export const ARG2_TRANSFORMS: ReadonlySet<string> = new Set(['yesNoText']);

export const TRANSFORM_BY_ID: Readonly<Record<string, ValueTransform>> = Object.fromEntries(
    VALUE_TRANSFORMS.map((tr) => [tr.id, tr]),
);

function spec(id: unknown): ValueTransform | undefined {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(TRANSFORM_BY_ID, id)
        ? TRANSFORM_BY_ID[id]
        : undefined;
}

/** Label for a transform id (for the chip); the id itself when unknown. */
export function transformLabel(id: unknown): string {
    const tr = spec(id);
    return tr ? t(`mobile.flow.transform.${tr.id}`, tr.labelEn) : String(id);
}

/** The one-line explanation shown beside a transform. */
export function transformHint(id: unknown): string {
    const tr = spec(id);
    return tr ? t(`mobile.flow.transform.${tr.id}_hint`, tr.hintEn) : '';
}

/** A number style's words. */
export function numberStyleLabel(value: string): string {
    const style = NUMBER_STYLES.find((s) => s.value === value);
    return style ? t(`mobile.flow.number_style.${style.value}`, style.labelEn) : value;
}
