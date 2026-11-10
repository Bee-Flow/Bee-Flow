import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import ExpressionInput from '../logic/ExpressionInput';
import { registerInspector } from '../registry';
import type { PanelProps } from '../appDefinition';
import { TextField , usePatch } from './kit';

interface FormInspectorProps {
    submitLabel?: string | null;
    showReset?: boolean;
    name?: string | null;
    resetKey?: string | null;
    validateOn?: 'submit' | 'blur' | 'change';
}

function FormInspector({ node, definition, onCommit, disabled = false }: PanelProps<FormInspectorProps>) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label={t('studio_apps_panels.form.submit_label', 'Submit label')}
                value={props.submitLabel}
                onChange={(v) => patch({ submitLabel: v })}
                placeholder={t('studio_apps_panels.form.submit_placeholder', 'Submit')}
                disabled={disabled}
            />
            <Toggle
                label={t('studio_apps_panels.form.show_reset', 'Show reset')}
                description={t('studio_apps_panels.form.show_reset_desc', 'Adds a button that clears the form.')}
                checked={!!props.showReset}
                onChange={(v) => patch({ showReset: v })}
                disabled={disabled}
                size="sm"
            />
            <TextField
                label={t('studio_apps_panels.form.form_name', 'Form name')}
                value={props.name}
                onChange={(v) => patch({ name: v || null })}
                hint={t('studio_apps_panels.form.form_name_hint', 'Used to reference this form from actions.')}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_validate.form.validate_on', 'Show field errors')} hint={t('studio_apps_validate.form.validate_on_hint', 'When a field is checked: only on submit (default), when it loses focus, or on every edit.')}>
                <select
                    value={props.validateOn || 'submit'}
                    onChange={(e) => patch({ validateOn: e.target.value === 'submit' ? undefined : e.target.value as 'blur' | 'change' })}
                    disabled={disabled}
                    aria-label={t('studio_apps_validate.form.validate_on', 'Show field errors')}
                    className="w-full px-2 py-1.5 text-sm rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]"
                >
                    <option value="submit">{t('studio_apps_validate.form.on_submit', 'On submit')}</option>
                    <option value="blur">{t('studio_apps_validate.form.on_blur', 'When leaving a field')}</option>
                    <option value="change">{t('studio_apps_validate.form.on_change', 'While typing')}</option>
                </select>
            </FormField>
            <FormField label={t('studio_apps_panels.form.reset_key', 'Start over when this changes')} hint={t('studio_apps_panels.form.reset_key_hint', 'A formula — usually the selected record\'s id. Fields return to their defaults and re-read their values, so a form that edits one record never keeps the previous record\'s values.')}>
                <ExpressionInput
                    variant="inline"
                    value={props.resetKey || ''}
                    onChange={(v) => patch({ resetKey: v || null })}
                    definition={definition}
                    node={node}
                    ariaLabel={t('studio_apps_panels.form.reset_key', 'Start over when this changes')}
                    placeholder={t('studio_apps_panels.form.reset_key_placeholder', 'e.g. vars.selected.id')}
                    disabled={disabled}
                />
            </FormField>
        </div>
    );
}

registerInspector('form', FormInspector);
