/**
 * The value field every step editor is built from — the phone's TemplateField,
 * PathField and ValueBuilder in one (agent-hub `Builder/mapping/`). Data sits in
 * the text as a pill named the way a person reads it ("gmail search ▸ Total"),
 * as on the web, while the value keeps `{{path}}` (PillTextInput); "Insert data"
 * opens the variable picker and drops the pick at the caret. What the text
 * MEANS — which binding kind, or a plain template string, or a bare path — is
 * bindingText.ts, pure and tested; the text's state is useBindingText.ts.
 *
 * A single picked value can be adjusted ("as a written date", "just the first
 * one") in the row under it, and says so on its pill. A binding field also has
 * a Formula mode, for the values the pill editor cannot show (a comparison, a
 * function): the text is then the expression. In the Simple view that switch
 * is only offered to a field that already holds a formula, as on the web.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { transformLabel } from '@/features/flow-editor/bindings';
import { Button, Segmented } from '@/shared/ui';


import { useVariablePicker } from '../variables';
import { AdjustRow } from './AdjustRow';
import { canAdjust, fromFormula, toFormula, type BindingInputMode, type EditableText } from './bindingText';
import { FieldRow } from './FieldRow';
import { JsonPickRow } from './JsonPickRow';
import { PillTextInput } from './PillTextInput';
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

/** Which controls a field shows around its text. */
function chromeOf(mode: BindingInputMode, textOnly: boolean, simple: boolean, shown: EditableText) {
    const evaluated = mode === 'binding' && !textOnly;
    const adjustable = evaluated && !shown.formula && canAdjust(shown.text);
    return {
        // In Simple view a person who never met a formula is not offered one — unless
        // the field already holds one, which would otherwise have no way back (the web's rule).
        formulaSwitch: evaluated && (!simple || shown.formula),
        adjustable,
        note: adjustable && shown.adjust ? transformLabel(shown.adjust.transform) : null,
    };
}

export function BindingInput(props: BindingInputProps) {
    const { value, onChange, label, hint, prompt, required, error, multiline, disabled, testID } = props;
    const mode = props.mode ?? 'binding';
    const t = useTranslation();
    const picker = useVariablePicker();
    const { shown, emit, insert, latestInsert, onSelection, caret } = useBindingText(value, mode, onChange);
    const name = label ?? t('routines.builder.value_word', 'Value');
    const onFocus = useActiveField(picker, name, latestInsert);

    const expression = shown.formula || mode === 'path' || mode === 'expression';
    const openPicker = () =>
        picker.open({ list: props.list, title: t('routines.builder.pick_data_for', 'Pick data for {field}', { field: name }), onPick: insert });
    const editable = !disabled;
    const { formulaSwitch, adjustable, note } = chromeOf(mode, Boolean(props.textOnly), picker.simple, shown);
    const id = (suffix: string) => (testID ? `${testID}-${suffix}` : undefined);

    return (
        <FieldRow
            label={label}
            hint={hint}
            required={required}
            error={error}
            accessory={formulaSwitch ? <FormulaSwitch shown={shown} emit={emit} /> : null}
            testID={testID}
        >
            {shown.pick && !shown.formula ? (
                <JsonPickRow
                    pick={shown.pick}
                    labels={picker.stepLabelById}
                    types={picker.stepTypeById}
                    onRemove={editable ? () => emit({ text: '', formula: false }) : undefined}
                    testID={id('pick')}
                />
            ) : (
                <PillTextInput
                    text={shown.text}
                    expression={expression}
                    labels={picker.stepLabelById}
                    types={picker.stepTypeById}
                    caret={caret}
                    note={note}
                    onChangeText={(text) => emit({ ...shown, text })}
                    onFocus={onFocus}
                    onSelectionChange={onSelection}
                    placeholder={prompt}
                    multiline={multiline}
                    editable={editable}
                    {...keyboardFor(expression, props.literal)}
                    accessibilityLabel={name}
                    testID={id('input')}
                />
            )}
            {adjustable ? <AdjustRow adjust={shown.adjust ?? null} onChange={(adjust) => emit({ ...shown, adjust })} disabled={!editable} /> : null}
            {picker.enabled && editable ? <InsertData onPress={openPicker} testID={id('insert')} /> : null}
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    modes: { marginLeft: 'auto' } satisfies ViewStyle,
    actions: { flexDirection: 'row', justifyContent: 'flex-start', marginTop: -theme.spacing.xs } satisfies ViewStyle,
});
