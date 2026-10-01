import React from 'react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import type { PickIntent } from '@shared/mapping/index.mjs';

/**
 * One muted sentence under a chip that says what the field will get, with a
 * "Change" link that opens PickOptions:
 *
 *   Comes as text: all 12, one per line. Change
 *   Comes as a list of 12.
 *   Only the first.                              (amber when a list goes into
 *                                                 a field for one value)
 *   Which column? [E-mail ▾]                     (a whole table into a list
 *                                                 field; amber when no column
 *                                                 matches the field)
 *
 * Nothing is said for one value used as it is: the chip says it all.
 * Presentational: derived from the props only, so it can never describe a
 * value the field no longer holds.
 */

export interface ColumnChoice {
    key: string;
    label: string;
}

export interface PickSentenceProps {
    intent: PickIntent;
    /** Values in the list (sample or last run), when known. */
    count?: number | null;
    /** Amber: the default had to make a choice the user should see (many_for_one). */
    warning?: boolean;
    onChange?: () => void;
    /** A whole table into a list field: the columns to choose from. */
    columns?: ColumnChoice[] | null;
    /** The chosen column's key; null when none matched the field. */
    column?: string | null;
    onColumn?: (key: string) => void;
}

/** take 'all': the sentence per `as`. */
function allSentence(t: TranslateFn, intent: PickIntent, count: number | null): string {
    const all = count === null
        ? t('mapping.slot.sentence.all', 'all of them')
        : t('mapping.slot.sentence.all_count', 'all {count}', { count });
    if (intent.as === 'text') {
        if (intent.join === 'comma') return t('mapping.slot.sentence.text_comma', 'Comes as text: {all}, separated by commas.', { all });
        if (intent.join === 'bullets') return t('mapping.slot.sentence.text_bullets', 'Comes as text: {all}, as a bulleted list.', { all });
        return t('mapping.slot.sentence.text_lines', 'Comes as text: {all}, one per line.', { all });
    }
    if (intent.as === 'list') return count === null
        ? t('mapping.slot.sentence.list', 'Comes as a list.')
        : t('mapping.slot.sentence.list_count', 'Comes as a list of {count}.', { count });
    if (intent.as === 'json') return t('mapping.slot.sentence.json', 'Comes as data: {all}.', { all });
    return t('mapping.slot.sentence.native', 'Comes as it is: {all}.', { all });
}

/** The sentence for an intent, or '' when there is nothing to say. Pure. */
export function pickSentence(t: TranslateFn, intent: PickIntent, count?: number | null): string {
    const known = typeof count === 'number' && Number.isFinite(count) ? count : null;
    switch (intent.take) {
        case 'all': return allSentence(t, intent, known);
        case 'each': return t('mapping.slot.sentence.each', 'One value per run, for each item.');
        case 'first': return known === null
            ? t('mapping.slot.sentence.first', 'Only the first.')
            : t('mapping.slot.sentence.first_of', 'Only the first of {count}.', { count: known });
        case 'last': return known === null
            ? t('mapping.slot.sentence.last', 'Only the last.')
            : t('mapping.slot.sentence.last_of', 'Only the last of {count}.', { count: known });
        case 'count': return known === null
            ? t('mapping.slot.sentence.count', 'The number of them.')
            : t('mapping.slot.sentence.count_n', 'The number of them ({count}).', { count: known });
        default:
            // One value into a list field is a list of one.
            return intent.as === 'list' ? t('mapping.slot.sentence.list_count', 'Comes as a list of {count}.', { count: 1 }) : '';
    }
}

const MUTED = 'text-[var(--text-tertiary)]';
const AMBER = 'text-[var(--warning-ink)]';

export default function PickSentence({ intent, count, warning = false, onChange, columns, column, onColumn }: PickSentenceProps) {
    const { t } = useTranslation();
    const change = onChange ? (
        <button type="button" onClick={onChange} className="ml-1 underline underline-offset-2 hover:text-[var(--text-primary)]">
            {t('mapping.slot.change', 'Change')}
        </button>
    ) : null;

    if (columns && columns.length) {
        const matched = !!column && columns.some(c => c.key === column);
        const question = matched
            ? t('mapping.slot.sentence.column', 'Which column?')
            : t('mapping.slot.sentence.column_none', 'No column matches this field. Which column?');
        return (
            <div data-testid="pick-sentence" data-tone={matched ? 'muted' : 'amber'} className={`flex flex-wrap items-center gap-1.5 text-[12px] ${matched ? MUTED : AMBER}`}>
                <label className="contents">
                    <span>{question}</span>
                    <select
                        value={matched ? column! : ''}
                        onChange={(e) => onColumn?.(e.target.value)}
                        className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-1 py-0.5 text-[12px] text-[var(--text-primary)]"
                    >
                        {!matched && <option value="" disabled>{t('mapping.slot.sentence.column_choose', 'Choose a column')}</option>}
                        {columns.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                </label>
                {change}
            </div>
        );
    }

    const sentence = pickSentence(t, intent, count);
    if (!sentence) return null;
    return (
        <p data-testid="pick-sentence" data-tone={warning ? 'amber' : 'muted'} className={`text-[12px] leading-[1.4] ${warning ? AMBER : MUTED}`}>
            {sentence}
            {change}
        </p>
    );
}
