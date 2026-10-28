import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { registerInspector } from '../registry';
import type { PanelProps } from '../appDefinition';
import { TOAST_TONES } from '../styleKnobMeta';
import { TextField, TextAreaField , usePatch } from './kit';

interface CalloutInspectorProps {
    title?: string | null;
    text?: string | null;
    tone?: string;
}

function CalloutInspector({ node, definition, onCommit, disabled = false }: PanelProps<CalloutInspectorProps>) {
    const props = node.props || {};
    const { t } = useTranslation();
    const TONE_LABELS: Record<string, string | undefined> = {
        info: t('studio_apps_panels.callout.tone_info', 'Info'),
        success: t('studio_apps_panels.callout.tone_success', 'Success'),
        warning: t('studio_apps_panels.callout.tone_warning', 'Warning'),
        danger: t('studio_apps_panels.callout.tone_danger', 'Danger'),
    };
    const TONES = TOAST_TONES.map((tone) => ({ value: tone, label: TONE_LABELS[tone] ?? tone.charAt(0).toUpperCase() + tone.slice(1) }));
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label={t('studio_apps_panels.common.title', 'Title')}
                value={props.title}
                onChange={(v) => patch({ title: v || null })}
                placeholder={t('studio_apps_panels.common.optional_title', 'Optional title')}
                disabled={disabled}
            />
            <TextAreaField label={t('studio_apps_panels.common.text', 'Text')} value={props.text} onChange={(v) => patch({ text: v })} rows={3} disabled={disabled} />
            <FormField label={t('studio_apps_panels.callout.tone', 'Tone')}>
                <SegmentedControl
                    value={props.tone ?? 'info'}
                    onChange={(v) => patch({ tone: v })}
                    options={TONES}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.callout.tone_aria', 'Callout tone')}
                />
            </FormField>
        </div>
    );
}

registerInspector('callout', CalloutInspector);
