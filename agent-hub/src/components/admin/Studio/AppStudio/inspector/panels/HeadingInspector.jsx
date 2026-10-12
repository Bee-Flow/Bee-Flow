import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { registerInspector } from '../registry';
import { TextField, SelectField, usePatch } from './kit';

const LEVELS = [
    { value: 1, label: 'H1' },
    { value: 2, label: 'H2' },
    { value: 3, label: 'H3' },
];

export default function HeadingInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    // Mirror of the heading `accent` enum (componentSpecs.js, authoritative —
    // first value is the default and renders exactly what heading always
    // rendered). `level` says how big, `accent` says how loud.
    const ACCENTS = [
        { value: 'none', label: t('studio_apps_panels.heading.accent_none', 'None') },
        { value: 'bar', label: t('studio_apps_panels.heading.accent_bar', 'Bar') },
        { value: 'tinted', label: t('studio_apps_panels.common.look_tinted', 'Tinted') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.text', 'Text')} value={props.text} onChange={(v) => patch({ text: v })} disabled={disabled} />
            <FormField label={t('studio_apps_panels.heading.level', 'Level')}>
                <SegmentedControl
                    value={props.level ?? 2}
                    onChange={(v) => patch({ level: v })}
                    options={LEVELS}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.heading.level_aria', 'Heading level')}
                />
            </FormField>
            <SelectField
                label={t('studio_apps_panels.heading.accent', 'Accent')}
                value={props.accent ?? 'none'}
                onChange={(v) => patch({ accent: v })}
                options={ACCENTS}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('heading', HeadingInspector);
