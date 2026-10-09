import { Check } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { COLOR_ROLES, HEX_RE } from './styleKnobMeta';
import ColorPicker from '../../../../shared/ColorPicker';
import SegmentedControl from '../../../../shared/SegmentedControl';
import { ROLE_COLORS } from '../runtime/styleResolver';
import { APP_COLOR_PRESETS } from '../runtime/themeVars';

/**
 * TokenColorField — editor for the `colorOrRole` style knob.
 *
 * Value model (mirrors server/appStudio/componentSpecs.js, authoritative):
 *   null        → inherit the theme (no explicit color)
 *   'primary'…  → one of the six COLOR_ROLES
 *   '#rrggbb'   → a custom hex literal
 *
 * The mode tabs are local UI state seeded from the value: switching to
 * "Theme" commits null immediately (that IS the value), while "Role" and
 * "Custom" only commit once a swatch/color is actually picked.
 */

function modeForValue(value) {
    if (value == null) return 'theme';
    if (COLOR_ROLES.includes(value)) return 'role';
    return 'custom';
}

/** Display color for a role swatch. `primary` follows the app theme. */
function roleSwatchColor(role, themePrimary) {
    if (role === 'primary') return themePrimary || APP_COLOR_PRESETS[0];
    if (role === 'neutral') return 'var(--text-secondary)';
    return ROLE_COLORS[role];
}

const modeOptions = (t) => [
    { value: 'theme', label: t('studio_apps_insp.color.mode_theme', 'Theme') },
    { value: 'role', label: t('studio_apps_insp.color.mode_role', 'Role') },
    { value: 'custom', label: t('studio_apps_insp.color.mode_custom', 'Custom') },
];

const roleLabel = (t, role) => ({
    primary: t('studio_apps_insp.color.role_primary', 'primary'),
    neutral: t('studio_apps_insp.color.role_neutral', 'neutral'),
    success: t('studio_apps_insp.color.role_success', 'success'),
    warning: t('studio_apps_insp.color.role_warning', 'warning'),
    danger: t('studio_apps_insp.color.role_danger', 'danger'),
    info: t('studio_apps_insp.color.role_info', 'info'),
}[role] || role);

export default function TokenColorField({ value = null, onChange, themePrimary = null, disabled = false }) {
    const { t } = useTranslation();
    const [mode, setMode] = useState(() => modeForValue(value));

    // Follow external value changes (e.g. selecting a different node).
    useEffect(() => {
        setMode(modeForValue(value));
    }, [value]);

    const pickMode = (next) => {
        setMode(next);
        // Theme = "inherit" is itself the value; Role/Custom wait for a pick.
        if (next === 'theme' && value !== null) onChange(null);
    };

    return (
        <div>
            <SegmentedControl
                value={mode}
                onChange={pickMode}
                options={modeOptions(t)}
                size="sm"
                fullWidth
                disabled={disabled}
                ariaLabel={t('studio_apps_insp.color.source_aria', 'Color source')}
            />
            <div className="mt-2">
                {mode === 'theme' && (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                        <span
                            aria-hidden="true"
                            className="inline-block w-5 h-5 rounded-full border border-[var(--border-default)]"
                            style={{ background: themePrimary || APP_COLOR_PRESETS[0] }}
                        />
                        {t('studio_apps_insp.color.inherits_theme', 'Inherits the app theme')}
                    </div>
                )}
                {mode === 'role' && (
                    <div role="radiogroup" aria-label={t('studio_apps_insp.color.role_aria', 'Color role')} className="flex items-center gap-2 flex-wrap">
                        {COLOR_ROLES.map((role) => {
                            const active = value === role;
                            return (
                                <button
                                    key={role}
                                    type="button"
                                    role="radio"
                                    aria-checked={active}
                                    aria-label={roleLabel(t, role)}
                                    title={roleLabel(t, role)}
                                    disabled={disabled}
                                    onClick={() => onChange(role)}
                                    className="relative w-7 h-7 rounded-full transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
                                    style={{
                                        background: roleSwatchColor(role, themePrimary),
                                        border: active ? '2px solid var(--text-primary)' : '2px solid transparent',
                                        transform: active ? 'scale(1.08)' : 'scale(1)',
                                    }}
                                >
                                    {active && <Check className="absolute inset-0 m-auto w-3.5 h-3.5 text-white drop-shadow" />}
                                </button>
                            );
                        })}
                    </div>
                )}
                {mode === 'custom' && (
                    <ColorPicker
                        value={typeof value === 'string' && HEX_RE.test(value) ? value : ''}
                        onChange={onChange}
                        presets={APP_COLOR_PRESETS}
                        allowCustom
                        disabled={disabled}
                        swatchSize={24}
                        ariaLabel={t('studio_apps_insp.color.custom_aria', 'Custom color')}
                    />
                )}
            </div>
        </div>
    );
}
