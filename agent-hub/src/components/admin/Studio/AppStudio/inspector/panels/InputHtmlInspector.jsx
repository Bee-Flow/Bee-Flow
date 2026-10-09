import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import { PrefillField } from './inputPanels';
import { registerInspector } from '../registry';
import { NumberField, TextAreaField, TextField, usePatch } from './kit';

/**
 * Content panel for input_html. Props mirror componentSpecs.js (authoritative).
 *
 * The hints below carry the one distinction an author has to get right: this
 * editor submits HTML and belongs with `send_email` bodyFormat "html", while
 * its sibling `input_richtext` submits markdown and belongs with everything
 * that is stored and read back inside the app.
 */
export default function InputHtmlInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);
    return (
        <div className="flex flex-col gap-4">
            <TextField
                label={t('studio_apps_panels.common.field_name', 'Field name')}
                value={props.name}
                onChange={(v) => patch({ name: v })}
                hint={t('studio_apps_panels.input_html.field_name_hint', 'The key this value submits as. It submits HTML — pair it with send_email bodyFormat “html”.')}
                disabled={disabled}
            />
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <TextField
                label={t('studio_apps_panels.common.placeholder', 'Placeholder')}
                value={props.placeholder}
                onChange={(v) => patch({ placeholder: v || null })}
                placeholder={t('studio_apps_panels.input_html.placeholder_example', 'Write your message…')}
                disabled={disabled}
            />
            <TextAreaField
                label={t('studio_apps_panels.input_html.default_content', 'Default content')}
                value={props.defaultValue}
                onChange={(v) => patch({ defaultValue: v || null })}
                placeholder={t('studio_apps_panels.input_html.default_content_placeholder', 'Optional starting HTML')}
                rows={3}
                disabled={disabled}
            />
            <NumberField
                label={t('studio_apps_panels.input_html.min_rows', 'Minimum height (rows)')}
                value={props.minRows}
                onChange={(v) => patch({ minRows: v })}
                hint={t('studio_apps_panels.input_html.min_rows_hint', '3–30. A mail body written in four lines is the usual complaint.')}
                disabled={disabled}
            />
            <PrefillField node={node} definition={definition} patch={patch} disabled={disabled} />
            <Toggle label={t('studio_apps_panels.common.required', 'Required')} checked={!!props.required} onChange={(v) => patch({ required: v })} disabled={disabled} size="sm" />
            <Toggle
                label={t('studio_apps_panels.input_html.allow_images', 'Allow images')}
                checked={!!props.allowImages}
                onChange={(v) => patch({ allowImages: v })}
                disabled={disabled}
                size="sm"
                hint={t('studio_apps_panels.input_html.allow_images_hint', 'An inserted image is stored inside the value as a data URI, so leave this off unless the form needs one (a signature logo).')}
            />
        </div>
    );
}

registerInspector('input_html', InputHtmlInspector);
