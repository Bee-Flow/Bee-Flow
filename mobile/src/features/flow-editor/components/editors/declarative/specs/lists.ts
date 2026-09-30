/**
 * The collection steps — Limit, Remove duplicates, Collect a field,
 * Summarise — the web's LimitFields, DedupeFields, AggregateFields and
 * SummarizeFields (collectionEditors.jsx): each works through a list picked
 * from an earlier step, with the optional input cap.
 */

import { msg, type EditorSpec } from '../spec';
import { itemKeys, MAX_ITEMS, SOURCE_LIST, TITLES } from './common';

const config = (type: string, fields: EditorSpec['sections'][number]['fields']): EditorSpec => ({
    type,
    sections: [{ key: 'config', title: TITLES.configuration, defaultOpen: true, fields: [SOURCE_LIST, MAX_ITEMS, ...fields] }],
});

export const LIMIT = config('limit', [
    {
        kind: 'select',
        key: 'mode',
        label: msg('mobile.flow.limit.which_end', 'Which end'),
        options: [
            { value: 'first', label: msg('mobile.flow.limit.first', 'Keep the first few') },
            { value: 'last', label: msg('mobile.flow.limit.last', 'Keep the last few') },
        ],
    },
    {
        kind: 'number',
        key: 'count',
        min: 0,
        integer: true,
        label: msg('mobile.flow.limit.count', 'How many to keep'),
        hint: msg('mobile.flow.limit.count_hint', '0 keeps nothing.'),
    },
]);

export const DEDUPE = config('dedupe', [
    {
        kind: 'text',
        key: 'keyField',
        example: 'id',
        suggest: itemKeys,
        label: msg('mobile.flow.dedupe.key_field', 'Key field'),
        hint: msg(
            'mobile.flow.dedupe.key_field_hint',
            'Optional. Two items with the same value here count as the same item. Leave it blank to drop only items that are identical all the way through.',
        ),
    },
]);

export const AGGREGATE = config('aggregate', [
    {
        kind: 'text',
        key: 'field',
        example: 'email',
        suggest: itemKeys,
        label: msg('mobile.flow.aggregate.field', 'Field'),
        hint: msg(
            'mobile.flow.aggregate.field_hint',
            'The field to take from every item. The result is a plain list of just those values. If no item has this field the step is skipped rather than handing on a list of blanks.',
        ),
    },
]);

export const SUMMARIZE = config('summarize', [
    {
        kind: 'text',
        key: 'field',
        example: 'amount',
        suggest: itemKeys,
        // `count` counts items and ignores the field, so it is not asked for.
        visibleWhen: (draft) => draft.op !== 'count',
        label: msg('mobile.flow.summarize.field', 'Field'),
        hint: msg(
            'mobile.flow.summarize.field_hint',
            'The number to work with, read from every item. If no item has this field the step is skipped rather than reporting 0.',
        ),
    },
    {
        kind: 'select',
        key: 'op',
        label: msg('mobile.flow.summarize.op', 'What to work out'),
        options: [
            { value: 'sum', label: msg('mobile.flow.summarize.sum', 'Total — add them all up') },
            { value: 'count', label: msg('mobile.flow.summarize.count', 'Count — how many items') },
            { value: 'avg', label: msg('mobile.flow.summarize.avg', 'Average') },
            { value: 'min', label: msg('mobile.flow.summarize.min', 'Lowest') },
            { value: 'max', label: msg('mobile.flow.summarize.max', 'Highest') },
        ],
    },
]);
