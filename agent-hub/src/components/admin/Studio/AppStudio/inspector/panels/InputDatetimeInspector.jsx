import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import Toggle from '../../../../../shared/Toggle';
import { registerInspector } from '../registry';
import { TextField , usePatch } from './kit';

/** Content panel for input_datetime. Props mirror componentSpecs.js (authoritative). */
export default function InputDatetimeInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const DEFAULTS = [
        { value: 'none', label: t('studio_apps_panels.input_datetime.default_none', 'None') },
        { value: 'now', label: t('studio_apps_panels.input_datetime.default_now', 'Now') },
        { value: 'today', label: t('studio_apps_panels.input_datetime.default_today', 'Today') },
    ];
    const patch = usePatch(node, definition, onCommit);
    const dv = props.defaultValue ?? null;
    const mode = dv === 'now' ? 'now' : dv === 'today' ? 'today' : 'none';
    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.field_name', 'Field name')} value={props.name} onChange={(v) => patch({ name: v })} hint={t('studio_apps_panels.common.field_name_hint', 'The key this value submits as.')} disabled={disabled} />
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <Toggle label={t('studio_apps_panels.input_datetime.include_time', 'Include time')} checked={props.withTime !== false} onChange={(v) => patch({ withTime: v })} disabled={disabled} size="sm" />
            <FormField label={t('studio_apps_panels.input_datetime.default', 'Default')}>
                <SegmentedControl
                    value={mode}
                    onChange={(m) => patch({ defaultValue: m === 'none' ? null : m })}
                    options={DEFAULTS}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.input_datetime.default_aria', 'Default datetime')}
                />
            </FormField>
            <Toggle label={t('studio_apps_panels.common.required', 'Required')} checked={!!props.required} onChange={(v) => patch({ required: v })} disabled={disabled} size="sm" />
        </div>
    );
}

registerInspector('input_datetime', InputDatetimeInspector);
