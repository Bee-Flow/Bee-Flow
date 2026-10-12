import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import { PrefillField } from './inputPanels';
import { registerInspector } from '../registry';
import { TextField, TextAreaField , usePatch } from './kit';

/** Content panel for input_richtext. Props mirror componentSpecs.js (authoritative). */
export default function InputRichtextInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);
    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.field_name', 'Field name')} value={props.name} onChange={(v) => patch({ name: v })} hint={t('studio_apps_panels.input_richtext.field_name_hint', 'The key this value submits as (markdown).')} disabled={disabled} />
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <TextAreaField
                label={t('studio_apps_panels.input_html.default_content', 'Default content')}
                value={props.defaultValue}
                onChange={(v) => patch({ defaultValue: v || null })}
                placeholder={t('studio_apps_panels.input_richtext.default_content_placeholder', 'Optional starting markdown')}
                rows={3}
                disabled={disabled}
            />
            <PrefillField node={node} definition={definition} patch={patch} disabled={disabled} />
            <Toggle label={t('studio_apps_panels.common.required', 'Required')} checked={!!props.required} onChange={(v) => patch({ required: v })} disabled={disabled} size="sm" />
        </div>
    );
}

registerInspector('input_richtext', InputRichtextInspector);
