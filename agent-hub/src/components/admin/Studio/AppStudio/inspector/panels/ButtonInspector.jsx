import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { registerInspector } from '../registry';
import { TextField, IconField, SelectField, usePatch } from './kit';

// Mirror of the button `variant` enum (componentSpecs.js, authoritative —
// order matters: 'primary' is first and stays the default). The look pass
// appended outline/soft; six variants no longer fit a segmented row in the
// 320px inspector, so this is a select now.
export default function ButtonInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const VARIANTS = [
        { value: 'primary', label: t('studio_apps_panels.button.variant_primary', 'Primary') },
        { value: 'secondary', label: t('studio_apps_panels.button.variant_secondary', 'Secondary') },
        { value: 'ghost', label: t('studio_apps_panels.button.variant_ghost', 'Ghost') },
        { value: 'danger', label: t('studio_apps_panels.button.variant_danger', 'Danger') },
        { value: 'outline', label: t('studio_apps_panels.button.variant_outline', 'Outline') },
        { value: 'soft', label: t('studio_apps_panels.button.variant_soft', 'Soft') },
    ];
    const ROLES = [
        { value: 'button', label: t('studio_apps_panels.button.role_button', 'Button') },
        { value: 'submit', label: t('studio_apps_panels.button.role_submit', 'Submit') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <SelectField
                label={t('studio_apps_panels.button.variant', 'Variant')}
                value={props.variant ?? 'primary'}
                onChange={(v) => patch({ variant: v })}
                options={VARIANTS}
                disabled={disabled}
                ariaLabel={t('studio_apps_panels.button.variant_aria', 'Button variant')}
            />
            <IconField
                label={t('studio_apps_panels.common.icon', 'Icon')}
                value={props.iconLeft}
                onChange={(v) => patch({ iconLeft: v })}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_panels.button.role', 'Role')}>
                <SegmentedControl
                    value={props.role ?? 'button'}
                    onChange={(v) => patch({ role: v })}
                    options={ROLES}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.button.role_aria', 'Button role')}
                />
            </FormField>
            {props.role === 'submit' && (
                <p className="text-xs text-[var(--text-muted)] -mt-2">
                    {t('studio_apps_panels.button.submit_hint', 'Submits the enclosing form instead of running its own action.')}
                </p>
            )}
        </div>
    );
}

registerInspector('button', ButtonInspector);
