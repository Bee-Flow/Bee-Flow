/**
 * A text field where a reference to another step is a PILL inside the text,
 * always — the web's RefTokenInput (agent-hub `Builder/mapping/RefTokenInput.jsx`)
 * on a phone. The field used to show `{{steps.act_4d4307a.output.total}}` and
 * name it in a pill under the field; now the text shows "gmail search ▸ Total"
 * in the step family's colour, exactly where the value goes.
 *
 * A TextInput takes styled spans as its children, so the field holds the
 * DISPLAY text (pillText.ts) and every edit is mapped back onto the stored RAW
 * text, which is never rewritten. One backspace takes a whole reference out.
 *
 * A reference typed by hand (a `{{…}}`, a bare path in a formula) stays text
 * while it is being typed — turning it into a pill mid-word would move the
 * caret out from under the author — and becomes a pill once the caret leaves
 * it or the field loses focus, as on the web.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    Text as RNText,
    type NativeSyntheticEvent,
    type TextInput,
    type TextInputSelectionChangeEventData,
    type TextStyle,
} from 'react-native';

import { useTheme, type Theme } from '@/core/theme/ThemeProvider';
import { classifyRef, type StepLabelMap } from '@/features/flow-editor/bindings';
import { familyColor, familyTint, typeGroupOf } from '@/features/flow-editor/model/familyStyle';
import { TextField, type TextFieldProps } from '@/shared/ui';

import { chipsIn, type TextChip } from './bindingText';
import { applyDisplayEdit, pillText, rangeToRaw, toDisplay, type PillText, type TextRange } from './pillText';

/** Step id → step type, so a pill wears its step's family colour. */
export type StepTypeMap = Pick<Map<string, string>, 'get'> | null | undefined;

/** Put the caret at this RAW position; a new object each time asks again. */
export interface CaretRequest {
    at: number;
}

export interface PillTextInputProps extends Omit<TextFieldProps, 'value' | 'onChangeText' | 'onSelectionChange' | 'children'> {
    /** The stored text, data written as `{{path}}` (or a bare path in a formula). */
    text: string;
    /** A formula or a path: references are bare paths, not `{{…}}`. */
    expression: boolean;
    labels: StepLabelMap;
    types?: StepTypeMap;
    onChangeText: (raw: string) => void;
    /** The selection, in the stored text's positions. */
    onSelectionChange?: (raw: TextRange) => void;
    caret?: CaretRequest | null;
    /** Said on the pill after its name: the value's adjustment. */
    note?: string | null;
}

/** What was just typed, in the raw text it belongs to. */
interface Typed {
    raw: string;
    range: TextRange;
}

/** How references are found and named in this field. */
interface ViewOptions {
    expression: boolean;
    labels: StepLabelMap;
    note: string;
}

function viewOf(raw: string, { expression, labels, note }: ViewOptions, held: TextRange | null): PillText {
    const chips = chipsIn(raw, expression, labels);
    const shown = held ? chips.filter((c) => c.end <= held.start || c.start >= held.end) : chips;
    return pillText(raw, shown, note);
}

/** The family a reference's pill is painted in (the web's pillTint). */
function familyOf(chip: TextChip, types: StepTypeMap): string | null {
    const ref = classifyRef(chip.path);
    if (ref?.source === 'trigger') return 'trigger';
    if (ref?.source === 'loop' || chip.path.startsWith('item') || chip.path === '_index') return 'loop';
    if (ref?.source === 'steps') return typeGroupOf(types?.get?.(ref.stepId as string) ?? null);
    return null;
}

export function pillStyle(theme: Theme, chip: TextChip, types: StepTypeMap): TextStyle {
    // A reference to a deleted step is muted rather than red: usually a step
    // just removed, and it must stay visible so it can be found and fixed.
    if (chip.missing) return { ...theme.fonts.medium, backgroundColor: theme.colors.bgTertiary, color: theme.colors.textTertiary };
    const family = familyOf(chip, types);
    const ink = family ? familyColor(theme, family) : theme.colors.textSecondary;
    return { ...theme.fonts.medium, backgroundColor: family ? familyTint(theme, family, 14) : theme.colors.bgTertiary, color: ink };
}

export function PillTextInput({ text, expression, labels, types, onChangeText, onSelectionChange, caret, note, onBlur, ...rest }: PillTextInputProps) {
    const theme = useTheme();
    const input = useRef<TextInput>(null);
    // The display selection as the native field last reported it.
    const selection = useRef<TextRange | null>(null);
    // Handlers read the ref: a selection event can land before the re-render.
    const typedRef = useRef<Typed | null>(null);
    const [typed, setTypedState] = useState<Typed | null>(null);
    const [place, setPlace] = useState<CaretRequest | null>(null);

    const held = typed && typed.raw === text ? typed.range : null;
    const options: ViewOptions = { expression, labels, note: note ?? '' };
    const view = viewOf(text, options, held);
    const latest = useRef(view);
    useLayoutEffect(() => {
        latest.current = view;
    });

    const setTyped = (next: Typed | null) => {
        typedRef.current = next;
        setTypedState(next);
    };
    const moveCaret = (next: PillText, rawAt: number) => {
        const at = toDisplay(next, rawAt);
        latest.current = next;
        selection.current = { start: at, end: at };
        setPlace({ at });
    };

    useEffect(() => {
        if (place) input.current?.setSelection?.(place.at, place.at);
    }, [place]);
    // A pick from the variable sheet: the caret goes after the new pill. The
    // text changed under it, so nothing typed is held back any more (`held`).
    useEffect(() => {
        if (!caret) return;
        const at = toDisplay(latest.current, caret.at);
        selection.current = { start: at, end: at };
        input.current?.setSelection?.(at, at);
    }, [caret]);

    /** What was being typed becomes pills; with a caret, it is kept in place. */
    const release = (rawAt: number | null) => {
        const now = latest.current;
        setTyped(null);
        const next = viewOf(now.raw, options, null);
        if (rawAt !== null && next.display !== now.display) moveCaret(next, rawAt);
    };

    const handleText = (next: string) => {
        const edit = applyDisplayEdit(latest.current, next, selection.current);
        const nextTyped = edit.typed ? { raw: edit.raw, range: edit.typed } : null;
        const after = viewOf(edit.raw, options, nextTyped?.range ?? null);
        setTyped(nextTyped);
        onChangeText(edit.raw);
        onSelectionChange?.({ start: edit.caret, end: edit.caret });
        // A pill went (or formed): the field's text is not what the keyboard
        // left, so the caret is put where the edit ended.
        if (after.display !== next) moveCaret(after, edit.caret);
        else {
            latest.current = after;
            const at = toDisplay(after, edit.caret);
            selection.current = { start: at, end: at };
        }
    };

    const handleSelection = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const range = e.nativeEvent.selection;
        selection.current = range;
        const raw = rangeToRaw(latest.current, range);
        onSelectionChange?.(raw);
        const current = typedRef.current;
        // The caret left what was being typed: that reference is a pill now.
        if (current && (raw.start !== raw.end || raw.end !== current.range.end)) release(raw.end);
    };

    return (
        <TextField
            ref={input}
            {...rest}
            onChangeText={handleText}
            onSelectionChange={handleSelection}
            onBlur={(e) => {
                if (typedRef.current) release(null);
                onBlur?.(e);
            }}
        >
            {view.segments.length ? (
                // One Text around the runs, as TextInput itself wraps several children.
                <RNText>
                    {view.segments.map((seg) =>
                        seg.kind === 'text' ? (
                            seg.text
                        ) : (
                            <RNText key={`pill-${seg.rawStart}`} style={pillStyle(theme, seg.chip, types)} testID="binding-pill">
                                {seg.label}
                            </RNText>
                        ),
                    )}
                </RNText>
            ) : null}
        </TextField>
    );
}
