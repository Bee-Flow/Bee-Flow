/**
 * The rest of the Look editor, in the web's order after the accent:
 * typography (TypographySection.jsx), corner roundness (RadiusSection.jsx:
 * 0.5–1.5 in 0.05 steps, a Stepper for the slider) and member access
 * (AccessSection.jsx).
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Group, Stepper, ToggleRow } from '@/shared/ui';

import { ChoiceGroup } from './ChoiceGroup';
import { FONT_IDS, formatRadius, RADIUS_RANGE, type FontId, type OrgTheme } from '../model/theme';

function fontLabels(t: TranslateFn): Record<FontId, string> {
    return {
        system: t('mobile.org.font_system', 'System default'),
        inter: 'Inter',
        plex: 'IBM Plex Sans',
        geist: 'Geist',
    };
}

export function ThemeDetailsGroups({
    theme,
    onChange,
    disabled,
}: {
    theme: OrgTheme;
    onChange: <K extends keyof OrgTheme>(key: K, value: OrgTheme[K]) => void;
    disabled: boolean;
}) {
    const t = useTranslation();
    const fonts = fontLabels(t);
    return (
        <>
            <ChoiceGroup
                title={t('mobile.org.theme_typography', 'Typography')}
                footer={t(
                    'mobile.org.theme_typography_note',
                    "Applied app-wide. The first option uses the operating system's native UI font.",
                )}
                choices={FONT_IDS.map((id) => ({ value: id, label: fonts[id] }))}
                value={theme.font}
                onChange={(font) => onChange('font', font)}
                disabled={disabled}
            />
            <Group
                title={t('mobile.org.theme_radius', 'Corner roundness')}
                footer={t('mobile.org.theme_radius_note', 'A multiplier applied to every rounded corner in the app.')}
            >
                <Stepper
                    testID="theme-radius"
                    label={t('mobile.org.theme_radius', 'Corner roundness')}
                    value={theme.radiusScale}
                    min={RADIUS_RANGE.min}
                    max={RADIUS_RANGE.max}
                    step={RADIUS_RANGE.step}
                    format={formatRadius}
                    disabled={disabled}
                    onChange={(v) => onChange('radiusScale', v)}
                />
            </Group>
            <Group
                title={t('mobile.org.theme_access', 'Member access')}
                footer={t(
                    'mobile.org.theme_access_note',
                    'Control whether individual members can override this theme on their own device.',
                )}
            >
                <ToggleRow
                    testID="theme-allow-override"
                    label={t('mobile.org.theme_allow_override', 'Allow members to pick their own theme')}
                    description={
                        theme.allowUserOverride
                            ? t(
                                  'mobile.org.theme_allow_on',
                                  'Members see a theme switcher in the sidebar and a section in their settings.',
                              )
                            : t(
                                  'mobile.org.theme_allow_off',
                                  'Members see this organisation theme regardless of any local preference.',
                              )
                    }
                    value={theme.allowUserOverride}
                    disabled={disabled}
                    onValueChange={(v) => onChange('allowUserOverride', v)}
                />
            </Group>
        </>
    );
}
