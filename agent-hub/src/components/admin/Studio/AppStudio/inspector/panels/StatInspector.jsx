import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { registerInspector } from '../registry';
import BindingField from './BindingField';
import { TextField, IconField, SelectField, usePatch } from './kit';

// Mirror of the stat `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what stat always rendered).
export default function StatInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const LOOKS = [
        { value: 'plain', label: t('studio_apps_panels.container.look_plain', 'Plain') },
        { value: 'tile', label: t('studio_apps_panels.stat.look_tile', 'Tile') },
        { value: 'tinted', label: t('studio_apps_panels.common.look_tinted', 'Tinted') },
        { value: 'accent', label: t('studio_apps_panels.card.look_accent', 'Accent') },
        { value: 'gradient', label: t('studio_apps_panels.card.look_gradient', 'Gradient') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <BindingField
                label={t('studio_apps_panels.common.data', 'Data')}
                value={props.value}
                onChange={(v) => patch({ value: v })}
                definition={definition}
                componentType="stat"
                singleValue
                hint={t('studio_apps_panels.stat.data_hint', 'Where the number on this tile comes from.')}
                placeholder="0"
                disabled={disabled}
            />
            <TextField
                label={t('studio_apps_panels.stat.caption', 'Caption')}
                value={props.caption}
                onChange={(v) => patch({ caption: v || null })}
                placeholder={t('studio_apps_panels.stat.caption_placeholder', 'Optional caption')}
                disabled={disabled}
            />
            <IconField label={t('studio_apps_panels.common.icon', 'Icon')} value={props.icon} onChange={(v) => patch({ icon: v })} disabled={disabled} />
            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'plain'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('stat', StatInspector);
