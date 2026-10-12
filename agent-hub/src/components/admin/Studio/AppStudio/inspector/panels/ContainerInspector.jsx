import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { registerInspector } from '../registry';
import { SelectField, usePatch } from './kit';

// Mirror of the container `look` enum (componentSpecs.js, authoritative —
// first value is the default: the invisible, layout-only container it has
// always been).
/**
 * Content panel for `container`. Bespoke rather than SpecPanel on purpose:
 * container was prop-less until the look pass, and a bespoke panel carries
 * the one knob with a hint the generic catalog select cannot give — the
 * runtime registry's defaultProps now mirror `look`, so the SpecPanel
 * fallback would also work, but this registration wins in the registry.
 */
export default function ContainerInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const LOOKS = [
        { value: 'plain', label: t('studio_apps_panels.container.look_plain', 'Plain') },
        { value: 'panel', label: t('studio_apps_panels.container.look_panel', 'Panel') },
        { value: 'tinted', label: t('studio_apps_panels.common.look_tinted', 'Tinted') },
        { value: 'outlined', label: t('studio_apps_panels.container.look_outlined', 'Outlined') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'plain'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                hint={t('studio_apps_panels.container.look_hint', 'Plain is invisible — the others give the grouping a face without a card.')}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('container', ContainerInspector);
