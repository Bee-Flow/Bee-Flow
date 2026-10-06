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
    structuredOrigin,
    structuredTextToValue,
    takesBarePaths,
    textToBinding,
    unwrapRefs,
    type BindingInputMode,
    type EditableText,
} from './bindingText';
import { shapePick, type PickShaping } from './pickShaping';
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
    /** The value is structured data (a map of bindings, an object), edited as its JSON. */
    structured: boolean;
    /** The JSON text of a structured value is not valid yet, so the last edit is not saved. */
    jsonPending: boolean;
    /** Let go of the structure on purpose: the field is emptied and takes plain text again. */
    clearStructured: () => void;
}

export type { PickShaping } from './pickShaping';

export function useBindingText(
    value: unknown,
    mode: BindingInputMode,
    onChange: (next: unknown) => void,
    shaping: PickShaping | null = null,
): BindingTextState {
    const [shown, setShown] = useState<EditableText>(() => bindingToText(value, mode));
    const [seen, setSeen] = useState<unknown>(value);
    const [sent, setSent] = useState<unknown>(UNSENT);
    // Counts the texts a value from elsewhere put in the field: a caret belongs to one of them.
    const [version, setVersion] = useState(0);
    const selection = useRef<Selection | null>(null);
    const [caret, setCaret] = useState<CaretRequest | null>(null);
    // A structured value (bindingText structuredOrigin) is edited as JSON and
    // saved back as that structure; text that is not JSON yet is not saved.
    const [structured, setStructured] = useState<unknown>(() => structuredOrigin(value, mode));
    const [jsonPending, setJsonPending] = useState(false);

    // Reset during render, so the old text is never on screen for a frame.
    if (!deepEqual(seen, value)) {
        setSeen(value);
        if (sent === UNSENT || !deepEqual(sent, value)) {
            setShown(bindingToText(value, mode));
            setVersion((n) => n + 1);
            setStructured(structuredOrigin(value, mode));
            setJsonPending(false);
        }
    }

    const send = (out: unknown) => {
        setSent(out);
        onChange(out);
    };
    const emit = (typed: EditableText) => {
        // A pasted {{path}} in a path or a formula shows as the bare path it is stored as.
        const edited = takesBarePaths(mode, typed.formula) ? { ...typed, text: unwrapRefs(typed.text) } : typed;
        // An adjustment belongs to one picked value: text typed around it drops it.
        const next = edited.adjust && (edited.formula || !canAdjust(edited.text)) ? { ...edited, adjust: null } : edited;
        setShown(next);
        if (structured != null && !next.formula) {
            const parsed = structuredTextToValue(next.text, structured);
            setJsonPending(parsed == null);
            if (parsed != null) send(parsed);
            return;
        }
        send(textToBinding(next.text, mode, next.formula, next));
    };
    const clearStructured = () => {
        setStructured(null);
        setJsonPending(false);
        const empty: EditableText = { text: '', formula: false };
        setShown(empty);
        send(textToBinding(empty.text, mode, false, empty));
    };
    const insert = (picked: string) => {
        let path = picked;
        // Into an EMPTY one-value slot, a list, a table or a record goes in
        // shaped (joined, a column, the first, a summary) — never as the raw
        // list a tool parameter cannot take. Typed text is never replaced.
        // A value from a list inside a list keeps its path (pickShaping.ts).
        if (shaping && mode === 'binding' && !shown.formula && !shown.pick && !shown.text.trim()) {
            const shaped = shapePick(path, shaping);
            if (shaped.binding) {
                setShown(bindingToText(shaped.binding, mode));
                setSent(shaped.binding);
                onChange(shaped.binding);
                return;
            }
            path = shaped.path;
        }
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
    return { shown, emit, insert, latestInsert, onSelection, caret, structured: structured != null, jsonPending, clearStructured };
}
