import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { registerInspector } from '../registry';
import { TextField , usePatch } from './kit';

/** Content panel for modal. Props mirror componentSpecs.js (authoritative). */
export default function ModalInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const SIZES = [
        { value: 'sm', label: t('studio_apps_panels.modal.size_sm', 'Small') },
        { value: 'md', label: t('studio_apps_panels.modal.size_md', 'Medium') },
        { value: 'lg', label: t('studio_apps_panels.modal.size_lg', 'Large') },
    ];
    const patch = usePatch(node, definition, onCommit);
    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.title', 'Title')} value={props.title} onChange={(v) => patch({ title: v || null })} placeholder={t('studio_apps_panels.modal.title_placeholder', 'Optional dialog title')} disabled={disabled} />
            <FormField label={t('studio_apps_panels.modal.size', 'Size')}>
                <SegmentedControl value={props.size ?? 'md'} onChange={(v) => patch({ size: v })} options={SIZES} size="sm" fullWidth disabled={disabled} ariaLabel={t('studio_apps_panels.modal.size_aria', 'Modal size')} />
            </FormField>
            <TextField
                label={t('studio_apps_panels.modal.trigger_label', 'Trigger label')}
                value={props.triggerLabel}
                onChange={(v) => patch({ triggerLabel: v || null })}
                placeholder={t('studio_apps_panels.modal.trigger_placeholder', 'e.g. Open details')}
                hint={t('studio_apps_panels.modal.trigger_hint', 'A built-in button that opens this dialog. Leave empty to open it only from an action.')}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('modal', ModalInspector);
