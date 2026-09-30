/**
 * One question of a form page — the web's FieldCard (FormBuilderFields.jsx):
 * the label and the answer type, whether it is required, the choices of a
 * dropdown, a file question's accepted types and size, what a download
 * offers, the app a "Pick from an app" searches, and — in Advanced — the
 * placeholder and the binding name. The name is never touched by the label:
 * it was minted once, when the question was created.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import type { CatalogPickSource } from '@/features/flow-editor/api';
import { NumberField, SelectField, StringListField, ToggleField } from '@/features/flow-editor/components/fields';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';
import type { FormField } from '@/features/flow-editor/model';
import { Button, TextField } from '@/shared/ui';

import { AppPickEditor } from './AppPickEditor';
import { BindingName } from './BindingName';
import { FIELD_TYPES, isDisplayField, optionLines } from './formModel';
import { TextSlot } from './TextSlot';
import { say } from '../declarative/runtime';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';

export interface QuestionCardProps {
    field: FormField;
    index: number;
    count: number;
    siblings: readonly FormField[];
    bindingBase: string;
    allowVariables: boolean;
    pickSources: readonly CatalogPickSource[];
    rename?: ((from: string, to: string) => number | undefined) | null;
    onChange: (patch: Partial<FormField>) => void;
    onRemove: () => void;
    onMove: (dir: -1 | 1) => void;
    disabled?: boolean;
}

/** Shown as its pill reads: "‹Previous step ▸ File id›". */
const FILE_ID_EXAMPLE = '{{steps.doc_1.output.fileId}}';
const ACCEPT_EXAMPLE = 'application/pdf,image/*';

function Advanced(props: QuestionCardProps) {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    const { field, index } = props;
    return (
        <>
            <Button
                size="sm"
                variant="ghost"
                label={open ? t('mobile.flow.form.hide_advanced', 'Hide advanced') : t('mobile.flow.form.advanced', 'Advanced')}
                onPress={() => setOpen((v) => !v)}
            />
            {open ? (
                <>
                    <TextSlot
                        label={t('mobile.flow.form.placeholder', 'Placeholder')}
                        value={field.placeholder}
                        onChange={(placeholder) => props.onChange({ placeholder })}
                        allowVariables={props.allowVariables}
                        disabled={props.disabled}
                        testID={`question-${index + 1}-placeholder`}
                    />
                    <BindingName
                        field={field}
                        siblings={props.siblings}
                        bindingBase={props.bindingBase}
                        rename={props.rename}
                        onChange={props.onChange}
                        disabled={props.disabled}
                    />
                </>
            ) : null}
        </>
    );
}

function TypeSpecific(props: QuestionCardProps) {
    const t = useTranslation();
    const { field, index, onChange } = props;
    if (isDisplayField(field)) {
        return (
            <>
                <TextSlot
                    label={t('mobile.flow.form.file_to_offer', 'File to offer')}
                    value={field.fileId}
                    onChange={(fileId) => onChange({ fileId })}
                    allowVariables={props.allowVariables}
                    placeholder={readableExample(FILE_ID_EXAMPLE)}
                    disabled={props.disabled}
                />
                <Note>
                    {t(
                        'mobile.flow.form.file_to_offer_hint',
                        'Point this at the Make a document step: tap Insert data and pick its File id. The link is built when the page is shown and only works for this visitor.',
                    )}
                </Note>
            </>
        );
    }
    if (field.type === 'select') {
        return (
            <StringListField
                label={t('mobile.flow.form.choices', 'Choices')}
                value={optionLines(field.options)}
                onChange={(options) => onChange({ options })}
                disabled={props.disabled}
                testID={`question-${index + 1}-choices`}
            />
        );
    }
    if (field.type === 'app_pick') {
        return <AppPickEditor field={field} index={index} sources={props.pickSources} onChange={onChange} disabled={props.disabled} />;
    }
    if (field.type !== 'file') return null;
    return (
        <>
            <TextField
                label={t('mobile.flow.form.accepted_types', 'Accepted types')}
                value={typeof field.accept === 'string' ? field.accept : ''}
                onChangeText={(accept) => onChange({ accept })}
                placeholder={ACCEPT_EXAMPLE}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.disabled}
            />
            <NumberField
                label={t('mobile.flow.form.max_mb', 'Max MB')}
                value={field.maxSizeMb ?? 10}
                min={1}
                max={25}
                integer
                onChange={(n) => onChange({ maxSizeMb: Number(n) || 10 })}
                disabled={props.disabled}
            />
        </>
    );
}

export function QuestionCard(props: QuestionCardProps) {
    const t = useTranslation();
    const { field, index, count, onChange, disabled = false } = props;
    const display = isDisplayField(field);
    return (
        <RowCard
            title={field.label || field.name}
            onMoveUp={index > 0 ? () => props.onMove(-1) : null}
            onMoveDown={index < count - 1 ? () => props.onMove(1) : null}
            onRemove={props.onRemove}
            removeLabel={t('mobile.flow.form.remove_question', 'Remove {name}', { name: field.label || field.name })}
            disabled={disabled}
            testID={`question-${index + 1}`}
        >
            <TextSlot
                label={t('mobile.flow.form.question_label', 'Question {n}', { n: index + 1 })}
                value={field.label}
                onChange={(label) => onChange({ label })}
                allowVariables={props.allowVariables}
                placeholder={t('mobile.flow.form.question_placeholder', 'What do you want to ask?')}
                disabled={disabled}
                testID={`question-${index + 1}-label`}
            />
            <SelectField
                label={t('mobile.flow.form.answer_type', 'Answer type')}
                value={field.type || 'text'}
                options={FIELD_TYPES.map((o) => ({ value: o.value, label: say(t, o.label) }))}
                onChange={(type) => onChange({ type })}
                disabled={disabled}
                testID={`question-${index + 1}-type`}
            />
            {!display ? (
                <ToggleField value={!!field.required} onChange={(required) => onChange({ required })} label={t('mobile.flow.form.required', 'Required')} disabled={disabled} />
            ) : null}
            <TypeSpecific {...props} />
            {!display ? <Advanced {...props} /> : null}
        </RowCard>
    );
}
