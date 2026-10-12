import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';
import ExpressionInput from '../logic/ExpressionInput';
import { registerInspector } from '../registry';
import { TextField , usePatch } from './kit';

export default function FormInspector({ node, definition, onCommit, disabled = false }) {
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
