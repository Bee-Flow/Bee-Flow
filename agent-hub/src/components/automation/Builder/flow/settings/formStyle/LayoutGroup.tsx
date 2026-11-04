import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { FORM_ALIGNS, FORM_FONTS, FORM_WIDTHS } from '@/components/forms/formStyleVars';
import { OptionRow } from './controls';
import { optionsOf } from './styleOptions';
import { withStyleValue, withThemeValue, type Style, type Theme } from './stylePresets';
import type { StyleChange } from './formStyleTypes';

/** Layout: how wide, how aligned, how round, how roomy, how big the text, which family. */
export default function LayoutGroup({ theme, style, onChange }: { theme: Theme; style: Style | undefined; onChange: StyleChange }) {
    const { t } = useTranslation();
    const setTheme = (key: string, value: unknown) => onChange({ theme: withThemeValue(theme, key, value) });
    const setStyle = (key: string, value: unknown) => onChange({ style: withStyleValue(style, key, value) });
    return (
        <>
            <OptionRow label={t('forms.style.width', 'Width')} value={style?.width} onPick={v => setStyle('width', v)} withDefault options={optionsOf(t, 'width', FORM_WIDTHS)} />
            <OptionRow label={t('forms.style.align', 'Title alignment')} value={style?.align} onPick={v => setStyle('align', v)} withDefault options={optionsOf(t, 'align', FORM_ALIGNS)} />
            <OptionRow label={t('forms.style.radius', 'Corners')} value={theme.radius} onPick={v => setTheme('radius', v)} options={optionsOf(t, 'radius', ['none', 'sm', 'md', 'lg', 'xl'])} />
            <OptionRow label={t('forms.style.density', 'Spacing')} value={theme.density} onPick={v => setTheme('density', v)} options={optionsOf(t, 'density', ['compact', 'comfortable', 'spacious'])} />
            <OptionRow label={t('forms.style.text_size', 'Text size')} value={theme.fontScale} onPick={v => setTheme('fontScale', v)} options={optionsOf(t, 'text', ['sm', 'md', 'lg'])} />
            <OptionRow label={t('forms.style.font', 'Font')} value={style?.font} onPick={v => setStyle('font', v)} withDefault options={optionsOf(t, 'font', FORM_FONTS)} />
        </>
    );
}
