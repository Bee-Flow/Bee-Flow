/**
 * Date & Time — the web's DateTimeFields (collectionEditors.jsx). One date, or
 * a whole column of them ("Works on"): the mode IS the presence of
 * `arrayRef`, and dropping a column (`items[*].date`) into "Input date"
 * switches to it on its own (datetimeTarget `dateInputPatch`).
 *
 * The web shows the collection cap ("Max input items") here too, but its
 * formState never saves `maxItems` for this step — a control that looks
 * saved and saves nothing. It is left out until the step carries it.
 */

import { dateInputPatch, datetimeTargetColumn } from '@/features/flow-editor/bindings';
import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type EditorSpec } from '../spec';
import { SOURCE_LIST, TITLES } from './common';

const listMode = (draft: FormDraft): boolean => typeof draft.arrayRef === 'string';
const op = (draft: FormDraft) => String(draft.op || 'now');
const ADDS = new Set(['addDays', 'addHours', 'addMinutes']);

export const DATETIME: EditorSpec = {
    type: 'datetime',
    sections: [
        {
            key: 'config',
            title: TITLES.configuration,
            defaultOpen: true,
            fields: [
                {
                    kind: 'select',
                    key: 'op',
                    label: msg('mobile.flow.datetime.op', 'Operation'),
                    options: [
                        { value: 'now', label: msg('mobile.flow.datetime.now', 'Today’s date and time') },
                        { value: 'parse', label: msg('mobile.flow.datetime.parse', 'Read a date out of text') },
                        { value: 'format', label: msg('mobile.flow.datetime.format', 'Reformat a date') },
                        { value: 'addDays', label: msg('mobile.flow.datetime.add_days', 'Add days') },
                        { value: 'addHours', label: msg('mobile.flow.datetime.add_hours', 'Add hours') },
                        { value: 'addMinutes', label: msg('mobile.flow.datetime.add_minutes', 'Add minutes') },
                        { value: 'diff', label: msg('mobile.flow.datetime.diff', 'Time between two dates') },
                        { value: 'extract', label: msg('mobile.flow.datetime.extract', 'Take one part of a date') },
                    ],
                },
                {
                    kind: 'select',
                    id: 'worksOn',
                    visibleWhen: (draft) => op(draft) !== 'now',
                    label: msg('mobile.flow.datetime.works_on', 'Works on'),
                    hint: msg('mobile.flow.datetime.works_on_hint', 'Set automatically when you drop a whole column into the input below.'),
                    options: [
                        { value: 'single', label: msg('mobile.flow.datetime.single', 'One date') },
                        { value: 'items', label: msg('mobile.flow.datetime.items', 'Each row of a list') },
                    ],
                    read: (draft) => (listMode(draft) ? 'items' : 'single'),
                    write: (value, draft) => ({ arrayRef: value === 'items' ? (draft.arrayRef ?? '') : null }),
                },
                { ...SOURCE_LIST, visibleWhen: listMode },
                {
                    kind: 'path',
                    key: 'input',
                    visibleWhen: (draft) => op(draft) !== 'now',
                    label: msg('mobile.flow.datetime.input', 'Input date'),
                    hint: (draft) =>
                        listMode(draft)
                            ? msg('mobile.flow.datetime.input_hint_list', 'Which column of that list holds the date. Write it as item.<column>.')
                            : msg('mobile.flow.datetime.input_hint', 'Pick a date from a previous step, or type a fixed date like 2026-07-01.'),
                    // A dropped COLUMN switches the step to list mode.
                    write: (value, draft) => dateInputPatch(value, { listMode: listMode(draft) }),
                },
                {
                    kind: 'text',
                    key: 'target',
                    visibleWhen: listMode,
                    label: msg('mobile.flow.datetime.target', 'New column'),
                    hint: (draft) =>
                        msg(
                            'mobile.flow.datetime.target_hint',
                            'Every row keeps its own columns and gains this one. Leave empty to call it “{column}”.',
                            { column: datetimeTargetColumn(draft) },
                        ),
                },
                {
                    kind: 'path',
                    key: 'input2',
                    example: 'trigger.output.endsAt',
                    visibleWhen: (draft) => op(draft) === 'diff',
                    label: msg('mobile.flow.datetime.input2', 'Second date'),
                    hint: msg('mobile.flow.datetime.input2_hint', 'Difference is calculated as second date − input date.'),
                },
                {
                    kind: 'number',
                    key: 'amount',
                    visibleWhen: (draft) => ADDS.has(op(draft)),
                    label: msg('mobile.flow.datetime.amount', 'Amount'),
                    hint: msg('mobile.flow.datetime.amount_hint', 'Positive to add, negative to subtract.'),
                },
                {
                    kind: 'text',
                    key: 'format',
                    example: 'yyyy-MM-dd HH:mm',
                    visibleWhen: (draft) => op(draft) === 'format',
                    label: msg('mobile.flow.datetime.format_label', 'Format'),
                    hint: msg(
                        'mobile.flow.datetime.format_hint',
                        'How the date should be written. Building blocks: yyyy (year), MM (month), dd (day), HH, mm, ss.',
                    ),
                },
                {
                    kind: 'select',
                    key: 'part',
                    visibleWhen: (draft) => op(draft) === 'extract',
                    label: msg('mobile.flow.datetime.part', 'Part'),
                    options: [
                        { value: 'year', label: msg('mobile.flow.datetime.year', 'year') },
                        { value: 'month', label: msg('mobile.flow.datetime.month', 'month') },
                        { value: 'day', label: msg('mobile.flow.datetime.day', 'day') },
                        { value: 'hour', label: msg('mobile.flow.datetime.hour', 'hour') },
                        { value: 'minute', label: msg('mobile.flow.datetime.minute', 'minute') },
                        { value: 'second', label: msg('mobile.flow.datetime.second', 'second') },
                        { value: 'dayOfWeek', label: msg('mobile.flow.datetime.day_of_week', 'day of the week') },
                    ],
                },
                {
                    kind: 'select',
                    key: 'unit',
                    visibleWhen: (draft) => op(draft) === 'diff',
                    label: msg('mobile.flow.datetime.unit', 'Unit'),
                    options: [
                        { value: 'days', label: msg('mobile.flow.datetime.days', 'days') },
                        { value: 'hours', label: msg('mobile.flow.datetime.hours', 'hours') },
                        { value: 'minutes', label: msg('mobile.flow.datetime.minutes', 'minutes') },
                        { value: 'seconds', label: msg('mobile.flow.datetime.seconds', 'seconds') },
                    ],
                },
            ],
        },
    ],
};
