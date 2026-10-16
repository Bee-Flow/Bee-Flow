import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import { registerInspector } from '../registry';
import type { CommonNodeProps } from '../appDefinition';
import type { NodePanelProps } from './NodePanelProps.types';
import { TextField , usePatch } from './kit';

/** Content panel for input_file. Props mirror componentSpecs.js (authoritative). */
interface InputFileInspectorProps extends CommonNodeProps {
    name?: string;
    label?: string;
    accept?: string | null;
    multiple?: boolean;
    required?: boolean;
}

export default function InputFileInspector({ node, definition, onCommit, disabled = false }: NodePanelProps<InputFileInspectorProps>) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);
    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.field_name', 'Field name')} value={props.name} onChange={(v) => patch({ name: v })} hint={t('studio_apps_panels.common.field_name_hint', 'The key this value submits as.')} disabled={disabled} />
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <TextField
                label={t('studio_apps_panels.input_file.accept', 'Accept')}
                value={props.accept}
                onChange={(v) => patch({ accept: v || null })}
                placeholder={t('studio_apps_panels.input_file.accept_placeholder', 'image/*, .pdf')}
                hint={t('studio_apps_panels.input_file.accept_hint', 'Comma-separated MIME types / extensions.')}
                disabled={disabled}
            />
            <Toggle label={t('studio_apps_panels.input_file.multiple', 'Allow multiple files')} checked={!!props.multiple} onChange={(v) => patch({ multiple: v })} disabled={disabled} size="sm" />
            <Toggle label={t('studio_apps_panels.common.required', 'Required')} checked={!!props.required} onChange={(v) => patch({ required: v })} disabled={disabled} size="sm" />
        </div>
    );
}

registerInspector('input_file', InputFileInspector);
