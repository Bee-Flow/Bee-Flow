import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { registerInspector } from '../registry';
import { TextField, TextAreaField, SelectField, usePatch } from './kit';

// Mirror of the card `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what card always rendered).
export default function CardInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const LOOKS = [
        { value: 'default', label: t('studio_apps_panels.common.look_default', 'Default') },
        { value: 'flat', label: t('studio_apps_panels.card.look_flat', 'Flat') },
        { value: 'raised', label: t('studio_apps_panels.card.look_raised', 'Raised') },
        { value: 'tinted', label: t('studio_apps_panels.common.look_tinted', 'Tinted') },
        { value: 'accent', label: t('studio_apps_panels.card.look_accent', 'Accent') },
        { value: 'gradient', label: t('studio_apps_panels.card.look_gradient', 'Gradient') },
        { value: 'solid', label: t('studio_apps_panels.card.look_solid', 'Solid') },
    ];
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
            <TextAreaField
                label={t('studio_apps_panels.common.description', 'Description')}
                value={props.description}
                onChange={(v) => patch({ description: v || null })}
                placeholder={t('studio_apps_panels.common.optional_description', 'Optional description')}
                rows={2}
                disabled={disabled}
            />
            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'default'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('card', CardInspector);
