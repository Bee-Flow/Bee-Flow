/**
 * "Pick from an app" — which app, how many, and whether the record's CONTENT
 * travels into the run or only a reference — the web's AppPickEditor
 * (FormBuilderFields.jsx). Never a particular record: the person filling the
 * form in answers from THEIR OWN account, which is why an app the author has
 * not connected is still offered, with a note rather than a lock.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { CatalogPickSource } from '@/features/flow-editor/api';
import { NumberField, SelectField, ToggleField } from '@/features/flow-editor/components/fields';
import type { FormField } from '@/features/flow-editor/model';

import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

export interface AppPickEditorProps {
    field: FormField;
    index: number;
    sources: readonly CatalogPickSource[];
    onChange: (patch: Partial<FormField>) => void;
    disabled?: boolean;
}

export function AppPickEditor({ field, index, sources, onChange, disabled = false }: AppPickEditorProps) {
    const t = useTranslation();
    const source = typeof field.source === 'string' ? field.source : '';
    const chosen = sources.find((s) => s.id === source) ?? null;
    const unknown = !!source && sources.length > 0 && !chosen;
    const withText = field.withText !== false;
    const options = [
        { value: '', label: t('mobile.flow.form.choose_app', 'Choose an app…') },
        ...sources.map((s) => ({
            value: s.id,
            label: s.available ? s.label : t('mobile.flow.form.app_not_connected', '{app} — not connected for you', { app: s.label }),
        })),
    ];
    return (
        <>
            <SelectField
                label={t('mobile.flow.form.app_to_pick', 'App to pick from')}
                value={source}
                options={options}
                onChange={(next) => onChange({ source: next })}
                disabled={disabled}
                testID={`question-${index + 1}-app`}
            />
            {unknown ? (
                <Warn>
                    {t('mobile.flow.form.app_unknown', '“{source}” is not an app this workspace can pick from. Choose another one, or connect it first.', { source })}
                </Warn>
            ) : null}
            {chosen ? (
                <Note>
                    {chosen.available
                        ? t('mobile.flow.form.app_searches_own', 'Whoever fills this form in searches their OWN {app}.', { app: chosen.app || chosen.label })
                        : t(
                              'mobile.flow.form.app_searches_own_unconnected',
                              'Whoever fills this form in searches their OWN {app} — you have not connected it yourself, so you will not be able to try the search here.',
                              { app: chosen.app || chosen.label },
                          )}
                </Note>
            ) : null}
            <ToggleField
                value={!!field.multiple}
                onChange={(on) => onChange(on ? { multiple: true } : { multiple: false, maxItems: undefined })}
                label={t('mobile.flow.form.allow_many', 'Allow more than one')}
                disabled={disabled}
            />
            {field.multiple ? (
                <NumberField
                    label={t('mobile.flow.form.max_records', 'Max')}
                    value={field.maxItems ?? 5}
                    min={1}
                    max={10}
                    integer
                    onChange={(n) => onChange({ maxItems: Number(n) || 5 })}
                    disabled={disabled}
                />
            ) : null}
            <ToggleField
                value={withText}
                onChange={(on) => onChange({ withText: on })}
                label={t('mobile.flow.form.bring_content', 'Bring the content into the automation')}
                description={
                    withText
                        ? t(
                              'mobile.flow.form.bring_content_on',
                              'The record is read when the form is submitted, so a later step can use {name}.text — the transcript, the email body, the note.',
                              { name: field.name },
                          )
                        : t('mobile.flow.form.bring_content_off', 'Only a reference travels: the title and the id. Nothing is read from the app.')
                }
                disabled={disabled}
            />
        </>
    );
}
