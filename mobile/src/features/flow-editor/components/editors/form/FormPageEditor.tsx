/**
 * The editor for ONE hosted form page — the web's FormBuilderFields, shared by
 * the form trigger (page one) and every `form_page` step (later pages, and
 * the closing page): all three declare the same `form` object, so an author
 * who has laid out page one already knows how to lay out page two.
 *
 *   variant 'input'  — a page with questions and a submit button;
 *   variant 'ending' — a closing page: text, and files to hand over.
 *
 * Exported from the flow editor so the Forms builder edits the same page with
 * the same control.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { CatalogPickSource } from '@/features/flow-editor/api';
import { THEME_PRESETS, type FormDeclaration, type FormField, type FormTheme } from '@/features/flow-editor/model';
import { Text } from '@/shared/ui';

import { addDisplayField, addQuestion, fieldsOf, isDisplayField, moveField, removeField, updateField } from './formModel';
import { QuestionCard } from './QuestionCard';
import { TextSlot } from './TextSlot';
import { ThemeEditor } from './ThemeEditor';
import { AddButton } from '../shared/AddButton';
import { Note } from '../shared/Note';

export interface FormPageEditorProps {
    form: FormDeclaration;
    onChange: (next: FormDeclaration) => void;
    /** 'trigger.output' or 'steps.<id>.output': where later steps read the answers. */
    bindingBase: string;
    variant?: 'input' | 'ending';
    /** Template slots: only where the server has a run to fill them in against (not page one). */
    allowVariables?: boolean;
    pickSources?: readonly CatalogPickSource[];
    /** Carry a question's rename through the automation; absent where the automation is out of sight. */
    rename?: ((from: string, to: string) => number | undefined) | null;
    disabled?: boolean;
}

/** The seed words of a new question or file — the author's own form's text, as the web seeds it. */
const NEW_QUESTION = 'New question';
const NEW_DOWNLOAD = 'Download';
const NEW_NOTEBOOK = 'Open in Notebooks';

export function FormPageEditor(props: FormPageEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { form, onChange, variant = 'input', allowVariables = false, disabled = false } = props;
    const ending = variant === 'ending';
    const fields = fieldsOf(form);
    const patch = (changes: Partial<FormDeclaration>) => onChange({ ...form, ...changes });
    const setFields = (next: FormField[]) => patch({ fields: next });
    const theme: FormTheme = form.theme || (THEME_PRESETS[0] as (typeof THEME_PRESETS)[number]).theme;
    const varsHint = allowVariables ? t('mobile.flow.form.vars_hint', 'Tap Insert data to drop in something from an earlier step.') : '';
    const slot = (key: 'title' | 'description' | 'submitLabel' | 'successMessage', label: string, hint: string | null, multiline = false) => (
        <TextSlot
            label={label}
            hint={hint || null}
            value={form[key]}
            onChange={(v) => patch({ [key]: v })}
            allowVariables={allowVariables}
            multiline={multiline}
            disabled={disabled}
            testID={`form-${key}`}
        />
    );
    const card = (field: FormField, index: number) => (
        <QuestionCard
            key={index}
            field={field}
            index={index}
            count={fields.length}
            siblings={fields}
            bindingBase={props.bindingBase}
            allowVariables={allowVariables}
            pickSources={props.pickSources ?? []}
            rename={props.rename}
            onChange={(changes) => setFields(updateField(fields, index, changes))}
            onRemove={() => setFields(removeField(fields, index))}
            onMove={(dir) => setFields(moveField(fields, index, dir))}
            disabled={disabled}
        />
    );
    return (
        <View style={styles.page}>
            {slot('title', ending ? t('mobile.flow.form.heading', 'Heading') : t('mobile.flow.form.title', 'Form title'), varsHint)}
            {ending
                ? slot('description', t('mobile.flow.form.message', 'Message'), t('mobile.flow.form.message_hint', 'Tell the visitor what happened.'), true)
                : slot('description', t('mobile.flow.form.intro', 'Intro text'), t('mobile.flow.form.intro_hint', 'Shown under the title. Optional.'), true)}
            <Text variant="label" tone="tertiary">
                {ending ? t('automations.form_builder_fields.downloads', 'Downloads') : t('forms.page.tab_questions', 'Questions')}
            </Text>
            {ending ? (
                <>
                    {fields.some(isDisplayField) ? null : (
                        <Note>{t('automations.form_builder_fields.nothing_to_hand_over_offer_a', 'Nothing to hand over — offer a file the automation made, to save or to open in Notebooks.')}</Note>
                    )}
                    {fields.map((f, i) => (isDisplayField(f) ? card(f, i) : null))}
                    <AddButton label={t('automations.form_builder_fields.add_a_download', 'Add a download')} onPress={() => setFields(addDisplayField(fields, 'download', NEW_DOWNLOAD))} disabled={disabled} />
                    <AddButton
                        label={t('automations.form_builder_fields.add_an_open_in_notebooks', 'Add an Open in Notebooks')}
                        onPress={() => setFields(addDisplayField(fields, 'notebook', NEW_NOTEBOOK))}
                        disabled={disabled}
                    />
                </>
            ) : (
                <>
                    {fields.length ? null : <Note>{t('automations.form_builder_fields.no_questions_yet_nobody_can_submit', 'No questions yet — nobody can submit this form.')}</Note>}
                    {fields.map(card)}
                    <AddButton label={t('automations.form_builder_fields.add_a_question', 'Add a question')} onPress={() => setFields(addQuestion(fields, NEW_QUESTION))} disabled={disabled} />
                    {slot('submitLabel', t('automations.form_builder_fields.button_text', 'Button text'), null)}
                    {slot('successMessage', t('automations.form_builder_fields.thank_you_message', 'Thank-you message'), t('mobile.flow.form.thank_you_hint', 'Replaces the form after a successful submission.'), true)}
                </>
            )}
            <ThemeEditor
                theme={theme}
                inherits={!form.theme}
                canInherit={props.bindingBase !== 'trigger.output'}
                onChange={(next) => patch({ theme: next })}
                disabled={disabled}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    page: { gap: theme.spacing.lg } satisfies ViewStyle,
});
