/**
 * The value field every step editor is built from — the phone's TemplateField,
 * PathField and value slot in one (agent-hub `Builder/mapping/`,
 * `Builder/valueSlot/`). Data sits in the text as a pill named the way a
 * person reads it ("gmail search ▸ Total"), as on the web, while the value
 * keeps `{{path}}` (PillTextInput); "Insert data" opens the variable picker
 * and drops the pick at the caret. What the text MEANS — which binding kind,
 * or a plain template string, or a bare path — is bindingText.ts, pure and
 * tested; the text's state is useBindingText.ts.
 *
 * The v2 mapping (features/flow-editor/valueSlot, the shared core's model):
 *
 *   - a pick, whoever stored it (the web, the AI builder), is a chip with its
 *     name and an example, the sentence that says what the field gets, and a
 *     sheet that changes it ("All, one per line", "Only the first", …);
 *   - a composed text is edited as text with a pill per value, and written
 *     back as the compose it is — never as a `{{ }}` template;
 *   - where the field stores picks (`storesPicks`: a tool input, a set field),
 *     a legacy ref or one-call formula shows as the pick the core lifts it to,
 *     and is rewritten only when the author changes it; a formula the core
 *     cannot lift is a grey "Formula" chip that opens the formula editor; a
 *     value picked into an empty field (or into typed text in a text field)
 *     is stored as a pick (or a composed text) with the core's default use.
 *
 * Elsewhere (a condition's operands, which the editor lowers into one
 * expression) the field keeps writing the legacy kinds, and a Formula mode
 * edits the values the pill editor cannot show. In the Simple view that
 * switch is only offered to a field that already holds a formula, as on the web.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import {
    PickedValue,
    ValueChip,
    formulaSummary,
    makePick,
    slotFor,
    slotView,
    type Sample,
    type SlotView,
} from '@/features/flow-editor/valueSlot';
import type { PickIntent, Slot } from '@/shared/mapping';
import { Button, Segmented } from '@/shared/ui';

import { useVariablePicker } from '../variables';
import { fromFormula, toFormula, type BindingInputMode, type EditableText } from './bindingText';
import { ComposeValues, composeChips } from './ComposeValues';
import { FieldRow } from './FieldRow';
import { JsonPickRow } from './JsonPickRow';
import { PillTextInput } from './PillTextInput';
import { placePick, type FieldState } from './placePick';
import { useActiveField } from './useActiveField';
import { useBindingText } from './useBindingText';

export interface BindingInputProps {
    value: unknown;
    onChange: (next: unknown) => void;
    /** 'binding' (a `{kind, …}` binding, the default), 'template' (a string), 'path' (a bare path) or 'expression' (a formula as text). */
    mode?: BindingInputMode;
    label?: string;
    hint?: string | null;
    /** The empty field's example. */
    prompt?: string;
    required?: boolean;
    error?: string | null;
    multiline?: boolean;
    /** A path field that wants a list: the picker offers lists only. */
    list?: boolean;
    /** No Formula switch (a slot the runtime reads as text, never evaluates). */
    textOnly?: boolean;
    /**
     * Text a machine reads, so the keyboard must not "help": no capital at the
     * start of a sentence or line (a JSON key `{"name"` became `{"Name"`), no
     * autocorrect. `url` also brings the address keyboard.
     */
    literal?: 'url' | 'code';
    /**
     * The value is a binding the runtime resolves itself (a tool input, a set
     * field), so a pick may be stored there: a picked value becomes one, and
     * a legacy reference shows as the pick it lifts to. Off for a binding the
     * editor lowers into an expression (a condition's operands).
     */
    storesPicks?: boolean;
    /** The field's JSON schema: what it wants of a picked value (the core's slot). */
    schema?: unknown;
    disabled?: boolean;
    testID?: string;
}

/** Text ⇄ Formula. Back to Text only when the formula is something the pill editor can show. */
function FormulaSwitch({ shown, emit }: { shown: EditableText; emit: (next: EditableText) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const flat = shown.formula ? fromFormula(shown.text) : shown;
    return (
        <View style={styles.modes}>
            <Segmented
                value={shown.formula ? 'formula' : 'text'}
                onChange={(next) => emit(next === 'formula' ? toFormula(shown.text, shown) : (flat ?? shown))}
                accessibilityLabel={t('routines.builder.mode_group', 'Value mode')}
                options={[
                    { value: 'text', label: t('routines.builder.mode_text_word', 'Text'), disabled: !flat },
                    { value: 'formula', label: t('routines.builder.mode_formula_word', 'Formula') },
                ]}
            />
        </View>
    );
}

function InsertData({ onPress, testID }: { onPress: () => void; testID?: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.actions}>
            <Button
                size="sm"
                variant="ghost"
                iconName="Plus"
                label={t('routines.builder.insert_data_word', 'Insert data')}
                accessibilityHint={t('routines.builder.insert_from_step', 'Insert data from a previous step')}
                onPress={onPress}
                testID={testID}
            />
        </View>
    );
}

/** How the keyboard treats the text: words get sentence help, paths and machine-read text none. */
function keyboardFor(expression: boolean, literal: BindingInputProps['literal']) {
    const plain = !expression && !literal;
    return {
        autoCapitalize: plain ? ('sentences' as const) : ('none' as const),
        autoCorrect: plain,
        spellCheck: literal ? false : undefined,
        keyboardType: literal === 'url' ? ('url' as const) : undefined,
    };
}

/**
 * Is the Text ⇄ Formula switch offered? In Simple view a person who never met
 * a formula is not offered one — unless the field already holds one, which
 * would otherwise have no way back (the web's rule). A composed text has no
 * formula spelling, and a chip has its own sheet.
 */
function offersFormulaSwitch(props: BindingInputProps, simple: boolean, shown: EditableText, editing: boolean): boolean {
    const evaluated = (props.mode ?? 'binding') === 'binding' && !props.textOnly;
    return evaluated && editing && !shown.compose && (!simple || shown.formula);
}

const isObject = (v: unknown): v is object => !!v && typeof v === 'object';

const idOf = (testID: string | undefined) => (suffix: string) => (testID ? `${testID}-${suffix}` : undefined);

/**
 * What the options of a stored pick are offered for: the field's slot, or —
 * where the field does not say (no schema) — what the pick itself was stored
 * as, so a text pick the web or the AI builder wrote keeps its text choices.
 */
function slotOfPick(slot: Slot, pick: PickIntent): Slot {
    if (slot.as !== 'native' || pick.as === 'native') return slot;
    return { as: pick.as, multiLine: pick.join !== 'comma' };
}

/** What an empty field of this mode stores. */
const emptyValue = (mode: BindingInputMode): unknown => (mode === 'binding' ? { kind: 'literal', value: '' } : '');

/** The field's text: typed words with pills, a formula, or a composed text. */
function TextBody({ field, onFocus }: { field: FieldState; onFocus: () => void }) {
    const t = useTranslation();
    const { props, mode, text, picker, sample, editable, id } = field;
    const { shown, emit, onSelection, caret } = text;
    const expression = shown.formula || mode === 'path' || mode === 'expression';
    return (
        <>
            <PillTextInput
                text={shown.text}
                expression={expression}
                labels={picker.stepLabelById}
                types={picker.stepTypeById}
                caret={caret}
                chipsOf={shown.compose ? composeChips(t, shown.compose, picker, sample) : null}
                onChangeText={(next) => {
                    field.keepEditor();
                    emit({ ...shown, text: next });
                }}
                onFocus={onFocus}
                onSelectionChange={onSelection}
                placeholder={props.prompt}
                multiline={props.multiline}
                editable={editable}
                {...keyboardFor(expression, props.literal)}
                accessibilityLabel={props.label ?? t('routines.builder.value_word', 'Value')}
                testID={id('input')}
            />
            {shown.compose ? <ComposeValues field={field} /> : null}
        </>
    );
}

/** A value a chip stands for: a pick (with its sentence and sheet), or a formula the core cannot lift. */
function ChipBody({ field, view, onFormulaOpen, onRepick }: { field: FieldState; view: SlotView; onFormulaOpen: () => void; onRepick: () => void }) {
    const t = useTranslation();
    const { props, mode, slot, sample, picker, editable, id } = field;
    const remove = editable ? () => props.onChange(emptyValue(mode)) : undefined;
    if (view.kind === 'formula') {
        return (
            <ValueChip
                label=""
                state="formula"
                summary={formulaSummary(t, view.binding, picker.stepLabelById)}
                onOpen={onFormulaOpen}
                onRemove={remove}
                disabled={!editable}
                testID={id('formula')}
            />
        );
    }
    if (view.kind !== 'pick') return null;
    return (
        <PickedValue
            pick={view.pick}
            slot={slotOfPick(slot, view.pick)}
            sample={sample}
            groups={picker.groups}
            stepLabelById={picker.stepLabelById}
            onChange={(intent) => props.onChange(makePick(view.pick.from, intent))}
            onRemove={remove}
            onRepick={picker.enabled && editable ? onRepick : undefined}
            // A legacy binding shown as its pick still has its formula.
            onFormula={view.lifted && !props.textOnly ? field.openFormula : undefined}
            disabled={!editable}
            testID={id('pick')}
        />
    );
}

/**
 * Is a chip on screen, or the text editor? The editor, unless a chip stands
 * for the value. Once the author types here, it stays: a reference or formula
 * typed out in full does not turn into a chip under their fingers. A stored
 * pick has no text to edit (its text is empty), so it is always its chip —
 * also when it comes back while the editor was open (an undo, a change from
 * elsewhere), or the first keystroke would write over it.
 */
function useEditor(view: SlotView) {
    const [editing, setEditing] = useState(false);
    const storedPick = view.kind === 'pick' && !view.lifted;
    if (editing && storedPick) setEditing(false);
    return {
        chip: storedPick || ((view.kind === 'pick' || view.kind === 'formula') && !editing),
        open: () => setEditing(true),
        close: () => setEditing(false),
    };
}

export function BindingInput(props: BindingInputProps) {
    const mode = props.mode ?? 'binding';
    const t = useTranslation();
    const picker = useVariablePicker();
    const sample: Sample = isObject(picker.sampleRoot) ? picker.sampleRoot : null;
    const text = useBindingText(props.value, mode, props.onChange);
    const { shown, emit } = text;
    const name = props.label ?? t('routines.builder.value_word', 'Value');
    const storesPicks = props.storesPicks === true;
    const view = slotView(props.value, { mode, storesPicks, sample });
    const editor = useEditor(view);
    const field: FieldState = {
        props, mode, storesPicks, sample, view, text, picker,
        slot: slotFor({ schema: props.schema, mode, multiline: props.multiline }),
        editable: !props.disabled,
        id: idOf(props.testID),
        openFormula: () => {
            editor.open();
            if (!shown.formula && !shown.pick) emit(toFormula(shown.text, shown));
        },
        keepEditor: editor.open,
        showChip: editor.close,
    };
    const place = (path: string) => placePick(path, field);
    const latestPlace = useRef(place);
    useEffect(() => {
        latestPlace.current = place;
    });
    const onFocus = useActiveField(picker, name, latestPlace);
    const switchMode = (next: EditableText) => {
        field.keepEditor();
        emit(next);
    };
    const openPicker = () =>
        picker.open({ list: props.list, title: t('routines.builder.pick_data_for', 'Pick data for {field}', { field: name }), onPick: place });

    const { chip } = editor;
    let body: React.ReactNode;
    if (chip) body = <ChipBody field={field} view={view} onFormulaOpen={editor.open} onRepick={openPicker} />;
    else if (shown.pick && !shown.formula) {
        body = (
            <JsonPickRow
                pick={shown.pick}
                labels={picker.stepLabelById}
                types={picker.stepTypeById}
                onRemove={field.editable ? () => emit({ text: '', formula: false }) : undefined}
                testID={field.id('pick')}
            />
        );
    } else body = <TextBody field={field} onFocus={onFocus} />;

    return (
        <FieldRow
            label={props.label}
            hint={props.hint}
            required={props.required}
            error={props.error}
            accessory={offersFormulaSwitch(props, picker.simple, shown, !chip) ? <FormulaSwitch shown={shown} emit={switchMode} /> : null}
            testID={props.testID}
        >
            {body}
            {picker.enabled && field.editable ? <InsertData onPress={openPicker} testID={field.id('insert')} /> : null}
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    modes: { marginLeft: 'auto' } satisfies ViewStyle,
    actions: { flexDirection: 'row', justifyContent: 'flex-start', marginTop: -theme.spacing.xs } satisfies ViewStyle,
});
