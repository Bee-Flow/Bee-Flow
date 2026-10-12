/**
 * The collection steps — Limit, Remove duplicates, Collect a field,
 * Summarise — the web's LimitFields, DedupeFields, AggregateFields and
 * SummarizeFields (collectionEditors.jsx): each works through a list picked
 * from an earlier step, with the optional input cap. And Flatten a list (the
 * web's FlattenFields.tsx): sentences over the shared plan, not a path to type.
 */

import type { FormDraft } from '@/features/flow-editor/formState';
import { humanizeFieldKey } from '@/features/flow-editor/model';

import { msg, type EditorSpec, type FieldSpec, type SpecContext, type SpecTranslate, type When } from '../spec';
import { itemKeys, MAX_ITEMS, SOURCE_LIST, TITLES } from './common';
import {
    columnsNote, columnsSentence, copiedKeys, emptyParents, fieldChips, levelChoices, levelLabel, nouns, oneDeep, routeOf, sourceHasItems,
    sourceOf, withKeptFields, withRoute, withSource, type FieldChip,
} from './flattenModel';

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

// ── Flatten a list ─────────────────────────────────────────────────────

const levels = (draft: FormDraft, ctx: SpecContext) => levelChoices(sourceOf(draft), ctx.sampleRoot);
/** The chooser shows for a one-deep route whose source offers two or more inner lists (D11). */
const choosing: When = (draft, ctx) => levels(draft, ctx).length >= 2 && oneDeep(routeOf(draft));
const emptyWarn = (draft: FormDraft, ctx: SpecContext) => emptyParents(draft, ctx.sampleRoot);
const nounParams = (draft: FormDraft) => nouns(draft) as unknown as Record<string, string>;

function levelSentence(draft: FormDraft, ctx: SpecContext, t: SpecTranslate): string {
    const route = routeOf(draft);
    if (!route) return '';
    const n = nouns(draft);
    const head = t('flatten_node.editor.one_level', 'One row per {child}', { child: n.child });
    const shape = t('flatten_node.editor.count_shape', 'Each {parent} holds a list of {children}.', { parent: n.parent, children: n.children });
    return choosing(draft, ctx) ? shape : `${head}. ${shape}`;
}

const FLATTEN_SOURCE: FieldSpec = {
    ...SOURCE_LIST,
    id: 'source',
    key: undefined,
    read: (draft) => sourceOf(draft),
    write: (value, draft, ctx) => withSource(draft, value, ctx.sampleRoot),
    label: msg('flatten_node.editor.working_through', 'Working through'),
    prompt: msg('flatten_node.editor.no_list', 'Pick the list to flatten.'),
};

const FLATTEN_CONFIG: readonly FieldSpec[] = [
    FLATTEN_SOURCE,
    {
        kind: 'note',
        id: 'noInner',
        tone: 'warning',
        visibleWhen: (draft, ctx) => !routeOf(draft) && sourceHasItems(sourceOf(draft), ctx.sampleRoot) && !levels(draft, ctx).length,
        hint: (draft) => msg(
            'flatten_node.editor.no_inner',
            'The {parents} in this list hold no list of their own, so there is nothing to flatten. Pick a list whose items each contain a list, such as emails with attachments.',
            { parents: nouns(draft).parents },
        ),
    },
    {
        kind: 'segmented',
        id: 'route',
        key: 'arrayRef',
        visibleWhen: choosing,
        write: (value, draft, ctx) => withRoute(draft, String(value), ctx.sampleRoot),
        label: msg('flatten_node.editor.row_per', 'One row per'),
        options: (draft, ctx) => levels(draft, ctx).map((l) => ({ value: l.path, label: levelLabel(l.path) })),
    },
    { kind: 'display', id: 'level', show: levelSentence },
    { kind: 'display', id: 'columns', show: (draft, ctx, t) => columnsSentence(draft, ctx.sampleRoot, t) },
    { kind: 'display', id: 'columnsNote', show: (draft, ctx, t) => columnsNote(draft, ctx.sampleRoot, t) },
    {
        kind: 'note',
        id: 'emptyWarn',
        tone: 'warning',
        visibleWhen: (draft, ctx) => draft.keepEmpty !== true && emptyWarn(draft, ctx).emptyCount > 0,
        hint: (draft, ctx) => {
            const vars = { ...emptyWarn(draft, ctx), parents: nouns(draft).parents, children: nouns(draft).children };
            return vars.emptyCount === 1
                ? msg('flatten_node.editor.empty_warn', '{emptyCount} of the {outerCount} {parents} has no {children}, so it makes no row.', vars)
                : msg('flatten_node.editor.empty_warn_plural', '{emptyCount} of the {outerCount} {parents} have no {children}, so they make no rows.', vars);
        },
    },
    {
        kind: 'toggle',
        key: 'keepEmpty',
        visibleWhen: (draft, ctx) => draft.keepEmpty === true || emptyWarn(draft, ctx).emptyCount > 0,
        label: (draft) => msg('flatten_node.advanced.empty_keep', 'Keep each as one row with empty {child} fields', nounParams(draft)),
        description: (draft) => (draft.keepEmpty === true
            ? msg('flatten_node.editor.kept_note', '{parents} without {children} get one row without {child} details.', nounParams(draft))
            : msg('flatten_node.advanced.empty_keep_help', 'Steps after this one may then get rows without {children}.', nounParams(draft))),
    },
    {
        kind: 'chips',
        id: 'fields',
        visibleWhen: (draft) => !!routeOf(draft),
        read: (draft) => copiedKeys(draft),
        write: (value, draft, ctx) => withKeptFields(draft, value, ctx.sampleRoot),
        label: (draft) => msg('flatten_node.fields.from_each', 'From each {parent}', nounParams(draft)),
        options: (draft, ctx) => fieldChips(draft, ctx.sampleRoot).map((c) => ({
            value: c.key,
            label: humanizeFieldKey(c.key),
            disabled: c.reason !== 'copy',
            blurb: chipBlurb(c.reason, draft),
        })),
    },
];

function chipBlurb(reason: FieldChip['reason'], draft: FormDraft) {
    if (reason === 'fill') return msg('flatten_node.fields.already', 'already on each {child}', nounParams(draft));
    return reason === 'long_text' ? msg('flatten_node.editor.reason_long', 'long text') : undefined;
}

export const FLATTEN: EditorSpec = {
    type: 'flatten',
    sections: [
        { key: 'config', title: msg('automations.node.flatten.typeLabel', 'Flatten a list'), defaultOpen: true, fields: FLATTEN_CONFIG },
        { key: 'more', title: msg('flatten_node.advanced.title', 'More options'), fields: [MAX_ITEMS] },
    ],
};
