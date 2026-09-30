/**
 * The base look (PresetSection.jsx): every preset the web offers, in its
 * order, with its one-line hint.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';

import { ChoiceGroup } from './ChoiceGroup';
import { THEME_PRESET_IDS, type ThemePresetId } from '../model/theme';

function presetCopy(t: TranslateFn): Record<ThemePresetId, { label: string; hint: string }> {
    return {
        light: { label: t('mobile.org.preset_light', 'Light'), hint: t('mobile.org.preset_light_hint', 'Clean, bright surfaces. Good for daytime use.') },
        paper: { label: t('mobile.org.preset_paper', 'Paper'), hint: t('mobile.org.preset_paper_hint', 'Warm editorial light. Off-white pages, espresso text.') },
        sepia: { label: t('mobile.org.preset_sepia', 'Sepia'), hint: t('mobile.org.preset_sepia_hint', 'Warm tan paper with deep-brown ink. Best for long reading sessions.') },
        glass: { label: t('mobile.org.preset_glass', 'Glass'), hint: t('mobile.org.preset_glass_hint', 'Translucent iOS-style Liquid Glass panels with frosted blur.') },
        'glass-dark': { label: t('mobile.org.preset_glass_dark', 'Glass Dark'), hint: t('mobile.org.preset_glass_dark_hint', 'Dark Liquid Glass — glowing colour over a deep night backdrop.') },
        dark: { label: t('mobile.org.preset_dark', 'Dark'), hint: t('mobile.org.preset_dark_hint', 'Low-glare dark surfaces. Easier on the eyes at night.') },
        obsidian: { label: t('mobile.org.preset_obsidian', 'Obsidian'), hint: t('mobile.org.preset_obsidian_hint', 'Monochrome carbon dark. Hairline borders, warm-pearl accents.') },
        'high-contrast': { label: t('mobile.org.preset_high_contrast', 'High Contrast'), hint: t('mobile.org.preset_high_contrast_hint', 'WCAG AAA contrast pairs. Best for accessibility.') },
        custom: { label: t('mobile.org.preset_custom', 'Custom'), hint: t('mobile.org.preset_custom_hint', 'Start from the active preset; tweak accent, radius and font.') },
    };
}

export function ThemePresetGroup({
    value,
    onChange,
    disabled,
}: {
    value: ThemePresetId;
    onChange: (next: ThemePresetId) => void;
    disabled: boolean;
}) {
    const t = useTranslation();
    const copy = presetCopy(t);
    return (
        <ChoiceGroup
            title={t('mobile.org.theme_preset', 'Preset')}
            footer={t('mobile.org.theme_preset_note', 'Pick the base look. Everything below adjusts within it.')}
            choices={THEME_PRESET_IDS.map((id) => ({ value: id, label: copy[id].label, description: copy[id].hint }))}
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    );
}
