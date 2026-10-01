/**
 * A composed text in a BindingInput: the pill of each value (named the way
 * its chip names it, a list with how many it holds) and, under the field,
 * the values that take from a list, each with the sentence and the sheet
 * that changes how it is used — a pill inside a text field cannot be tapped
 * on its own.
 */

import React from 'react';

import type { TranslateFn } from '@/core/i18n';
import { PickedValue, countAt, groupLabelOf, isStale, markersIn, pickLabel, type Sample } from '@/features/flow-editor/valueSlot';
import { describeSource, type PickIntent, type PickPart } from '@/shared/mapping';

import type { VariablePickerValue } from '../variables';
import type { TextChip } from './bindingText';
import type { FieldState } from './placePick';

/** The pills of a composed text: each value by its name, a list with how many it holds. */
export function composeChips(t: TranslateFn, parts: readonly PickPart[], picker: VariablePickerValue, sample: Sample) {
    return (raw: string): TextChip[] =>
        markersIn(raw, parts).map(({ start, end, part }) => {
            const name = pickLabel(t, part, groupLabelOf(part.from, picker.groups, picker.stepLabelById));
            const count = part.take === 'all' ? countAt(part.from, sample) : null;
            return {
                path: describeSource(part.from),
                start,
                end,
                name: count === null ? name : `${name} · ${count}`,
                suffix: '',
                missing: isStale(part.from, picker.groups, sample),
            };
        });
}

/** The values of a composed text that take from a list: how each is used, under the field. */
export function ComposeValues({ field }: { field: FieldState }) {
    const { text, slot, sample, picker, editable, props } = field;
    const { shown, emit } = text;
    const parts = shown.compose ?? [];
    const listed = markersIn(shown.text, parts).filter(({ part }) => part.take !== 'one');
    if (!listed.length) return null;
    const replace = (part: PickPart, intent: PickIntent) => {
        const next = parts.map((p) => {
            if (p !== part) return p;
            const { label: _label, join: _join, ...rest } = p;
            return { ...rest, ...intent };
        });
        emit({ ...shown, compose: next });
    };
    const remove = (start: number, end: number) => emit({ ...shown, text: shown.text.slice(0, start) + shown.text.slice(end) });
    return (
        <>
            {listed.map(({ part, start, end }, i) => (
                <PickedValue
                    key={`${start}-${i}`}
                    pick={part}
                    slot={{ as: 'text', multiLine: slot.multiLine }}
                    sample={sample}
                    groups={picker.groups}
                    stepLabelById={picker.stepLabelById}
                    onChange={(intent) => replace(part, intent)}
                    onRemove={editable ? () => remove(start, end) : undefined}
                    disabled={!editable}
                    testID={props.testID ? `${props.testID}-value-${i}` : undefined}
                />
            ))}
        </>
    );
}

