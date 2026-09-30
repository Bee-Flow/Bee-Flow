/**
 * The state behind a BindingInput: the text in the field, what it last sent, and
 * the caret — so the echo of the field's own edit never resets the caret, and
 * a value changed elsewhere (undo, the AI builder) replaces the text — and
 * forgets the caret, which belonged to the old text. Positions are in the
 * STORED text (`{{path}}`), which the pill field maps for us.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import { deepEqual } from '@/features/flow-editor/formState';

import {
    bindingToText,
    canAdjust,
    insertPath,
    takesBarePaths,
    textToBinding,
    unwrapRefs,
    type BindingInputMode,
    type EditableText,
} from './bindingText';
import type { TextRange } from './pillText';
import type { CaretRequest } from './PillTextInput';

const UNSENT = Symbol('unsent');

/** A caret, and the version of the text it was reported in. */
interface Selection {
    range: TextRange;
    version: number;
}

export interface BindingTextState {
    shown: EditableText;
    /** Show and send a new text. */
    emit: (next: EditableText) => void;
    /** A picked path at the caret. */
    insert: (path: string) => void;
    /** The latest `insert`, for a handle held across renders (the Input tab's tap). */
    latestInsert: RefObject<(path: string) => void>;
    /** The selection in the stored text, as the field reports it. */
    onSelection: (range: TextRange) => void;
    /** Where the field should put its caret after an insert. */
    caret: CaretRequest | null;
}

export function useBindingText(value: unknown, mode: BindingInputMode, onChange: (next: unknown) => void): BindingTextState {
    const [shown, setShown] = useState<EditableText>(() => bindingToText(value, mode));
    const [seen, setSeen] = useState<unknown>(value);
    const [sent, setSent] = useState<unknown>(UNSENT);
    // Counts the texts a value from elsewhere put in the field: a caret belongs to one of them.
    const [version, setVersion] = useState(0);
    const selection = useRef<Selection | null>(null);
    const [caret, setCaret] = useState<CaretRequest | null>(null);

    // Reset during render, so the old text is never on screen for a frame.
    if (!deepEqual(seen, value)) {
        setSeen(value);
        if (sent === UNSENT || !deepEqual(sent, value)) {
            setShown(bindingToText(value, mode));
            setVersion((n) => n + 1);
        }
    }

    const emit = (typed: EditableText) => {
        // A pasted {{path}} in a path or a formula shows as the bare path it is stored as.
        const edited = takesBarePaths(mode, typed.formula) ? { ...typed, text: unwrapRefs(typed.text) } : typed;
        // An adjustment belongs to one picked value: text typed around it drops it.
        const next = edited.adjust && (edited.formula || !canAdjust(edited.text)) ? { ...edited, adjust: null } : edited;
        setShown(next);
        const out = textToBinding(next.text, mode, next.formula, next);
        setSent(out);
        onChange(out);
    };
    const insert = (path: string) => {
        // A pick into a field that holds a JSON pick replaces it: the field has no text to insert into.
        const base: EditableText = shown.pick ? { text: '', formula: false } : shown;
        const at = selection.current?.version === version ? selection.current.range : null;
        const edit = insertPath(base.text, shown.pick ? null : at, path, { mode, formula: base.formula });
        selection.current = { range: { start: edit.caret, end: edit.caret }, version };
        emit({ ...base, text: edit.value });
        setCaret({ at: edit.caret });
    };
    const latestInsert = useRef(insert);
    useEffect(() => {
        latestInsert.current = insert;
    });
    const onSelection = (range: TextRange) => {
        selection.current = { range, version };
    };
    return { shown, emit, insert, latestInsert, onSelection, caret };
}
