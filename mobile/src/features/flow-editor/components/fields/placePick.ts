/**
 * Where a value picked from an earlier step goes in a BindingInput — the
 * decision the header of BindingInput.tsx describes, kept apart so the field
 * component only draws. Pure apart from the state handles it is given.
 */

import { partFromPath, pickFromPath, type Sample, type SlotView } from '@/features/flow-editor/valueSlot';
import type { Slot } from '@/shared/mapping';

import type { VariablePickerValue } from '../variables';
import type { BindingInputProps } from './BindingInput';
import { insertPath, textToParts, type BindingInputMode } from './bindingText';
import type { BindingTextState } from './useBindingText';

/** Everything a field knows while it decides what to show and where a pick goes. */
export interface FieldState {
    props: BindingInputProps;
    mode: BindingInputMode;
    storesPicks: boolean;
    slot: Slot;
    sample: Sample;
    view: SlotView;
    text: BindingTextState;
    picker: VariablePickerValue;
    editable: boolean;
    openFormula: () => void;
    /** The author is editing the text: keep the editor, even once the value reads as a chip. */
    keepEditor: () => void;
    /** A value arrived whole: show it as its chip. */
    showChip: () => void;
    id: (suffix: string) => string | undefined;
}

/**
 * Typed words, or nothing, in a field that stores picks: the pick into an
 * empty field, a composed text around the words of a text field. False hands
 * the path back to the plain insert, which never wipes typed words either.
 */
function placeIntoTyped(path: string, field: FieldState): boolean {
    const { text, slot, sample, props } = field;
    const parts = textToParts(text.shown.text);
    if (!parts || parts.some((p) => p.type !== 'text')) return false;
    if (text.shown.text.trim() !== '') {
        // Typed words stay: the value goes in at the caret. A text field
        // composes; any other (no schema, a number, a date) keeps the
        // template it always got, as a pick would replace the words.
        if (slot.as !== 'text') return false;
        const part = partFromPath(path, slot, sample);
        if (part) text.insertPart(part);
        return !!part;
    }
    const pick = pickFromPath(path, slot, sample);
    if (!pick) return false;
    field.showChip();
    props.onChange(pick);
    return true;
}

/** Where a picked path goes: what the field holds decides (see the header). */
export function placePick(path: string, field: FieldState): void {
    const { view, mode, storesPicks, slot, sample, text, props } = field;
    const { shown } = text;
    if (view.kind === 'pick') {
        // A pick into a field that holds one value replaces it. A text field
        // that held a pick takes the path the way it always took one.
        const next = mode === 'binding' ? pickFromPath(path, slot, sample) : null;
        field.showChip();
        props.onChange(next ?? insertPath('', null, path, { mode }).value);
        return;
    }
    if (shown.compose) {
        const part = partFromPath(path, slot, sample);
        if (part) text.insertPart(part);
        return;
    }
    if (view.kind === 'formula') field.openFormula();
    const typed = mode === 'binding' && storesPicks && !shown.formula && !shown.pick;
    if (typed && placeIntoTyped(path, field)) return;
    text.insert(path);
}

