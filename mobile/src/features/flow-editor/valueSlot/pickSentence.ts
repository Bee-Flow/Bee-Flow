/**
 * The one muted sentence under a picked value that says what the field will
 * get — the web's Builder/valueSlot/PickSentence.tsx, with its keys, pinned
 * by valueSlot.lockstep.test.ts (differential):
 *
 *   Comes as text: all 12, one per line.
 *   Comes as a list of 12.
 *   Only the first.          (amber when a list goes into a field for one value)
 *
 * Nothing is said for one value used as it is: the chip says it all. Pure.
 */

import type { TranslateFn } from '@/core/i18n';
import type { PickIntent } from '@/shared/mapping';

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
    if (intent.as === 'list') {
        return count === null
            ? t('mapping.slot.sentence.list', 'Comes as a list.')
            : t('mapping.slot.sentence.list_count', 'Comes as a list of {count}.', { count });
    }
    if (intent.as === 'json') return t('mapping.slot.sentence.json', 'Comes as data: {all}.', { all });
    return t('mapping.slot.sentence.native', 'Comes as it is: {all}.', { all });
}

/** The sentence for an intent, or '' when there is nothing to say. */
export function pickSentence(t: TranslateFn, intent: PickIntent, count?: number | null): string {
    const known = typeof count === 'number' && Number.isFinite(count) ? count : null;
    switch (intent.take) {
        case 'all':
            return allSentence(t, intent, known);
        case 'each':
            return t('mapping.slot.sentence.each', 'One value per run, for each item.');
        case 'first':
            return t('mapping.slot.sentence.first', 'Only the first.');
        case 'last':
            return t('mapping.slot.sentence.last', 'Only the last.');
        case 'count':
            return known === null
                ? t('mapping.slot.sentence.count', 'The number of them.')
                : t('mapping.slot.sentence.count_n', 'The number of them ({count}).', { count: known });
        default:
            // One value into a list field is a list of one.
            return intent.as === 'list' ? t('mapping.slot.sentence.list_count', 'Comes as a list of {count}.', { count: 1 }) : '';
    }
}
