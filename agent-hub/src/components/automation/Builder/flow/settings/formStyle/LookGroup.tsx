import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { ColorRow, OptionRow, ROW_LABEL, swatchVars } from './controls';
import { COLOR_PRESETS, THEME_PRESETS, activePresetId, withStyleValue, withThemeValue, type Style, type Theme } from './stylePresets';
import type { StyleChange } from './formStyleTypes';

/**
 * Look: the presets, the theme's three colours (main, button, page), the
 * card and text colours of the form itself, and light / dark.
 */
export default function LookGroup({ theme, style, onChange }: { theme: Theme; style: Style | undefined; onChange: StyleChange }) {
    const { t } = useTranslation();
    const preset = activePresetId(theme);
    const setTheme = (key: string, value: unknown) => onChange({ theme: withThemeValue(theme, key, value) });
    const setStyle = (key: string, value: unknown) => onChange({ style: withStyleValue(style, key, value) });
    const mainLabel = t('forms.style.primary', 'Main colour');
    return (
        <>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('forms.style.presets', 'Presets')}>
                {THEME_PRESETS.map(p => (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => onChange({ theme: { ...p.theme } })}
                        aria-pressed={preset === p.id}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition ${preset === p.id
                            ? 'border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent)]/10'
                            : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        <span className="h-3 w-3 rounded-full shrink-0 [background:var(--bf-swatch)]" style={swatchVars(p.theme.primary)} />
                        {t(`forms.style.preset_${p.id}`, p.label)}
                    </button>
                ))}
            </div>

            <div className="flex items-center gap-2">
                <span className={ROW_LABEL}>{mainLabel}</span>
                <div className="flex flex-wrap items-center gap-1">
                    {COLOR_PRESETS.map(hex => (
                        <button
                            key={hex}
                            type="button"
                            aria-label={t('forms.style.swatch', '{name}: {hex}', { name: mainLabel, hex })}
                            aria-pressed={theme.primary === hex}
                            onClick={() => setTheme('primary', hex)}
                            className={`h-4 w-4 rounded-full transition hover:scale-110 [background:var(--bf-swatch)] ${theme.primary === hex ? 'ring-2 ring-offset-1 ring-[var(--text-primary)]' : ''}`}
                            style={swatchVars(hex)}
                        />
                    ))}
                    <input
                        type="color"
                        aria-label={t('forms.style.primary_custom', 'Custom main colour')}
                        value={(typeof theme.primary === 'string' ? theme.primary : '#0F766E').toLowerCase()}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTheme('primary', e.target.value)}
                        className="h-5 w-7 rounded cursor-pointer border-0 bg-transparent p-0"
                    />
                </div>
            </div>
            <ColorRow label={t('forms.style.accent', 'Button colour')} value={theme.accent} fallback={String(theme.primary || '#0F766E')} onChange={v => setTheme('accent', v)} />
            <ColorRow label={t('forms.style.canvas', 'Page background')} value={theme.canvas} fallback="#f8fafc" onChange={v => setTheme('canvas', v)} />
            <ColorRow label={t('forms.style.card_color', 'Card colour')} value={style?.cardColor} fallback="#ffffff" onChange={v => setStyle('cardColor', v)} />
            <ColorRow label={t('forms.style.text_color', 'Text colour')} value={style?.textColor} fallback="#111827" onChange={v => setStyle('textColor', v)} />
            <OptionRow
                label={t('forms.style.appearance', 'Appearance')}
                value={theme.appearance}
                onPick={v => setTheme('appearance', v)}
                options={[
                    { value: 'light', label: t('forms.style.appearance_light', 'Light') },
                    { value: 'dark', label: t('forms.style.appearance_dark', 'Dark') },
                    { value: 'auto', label: t('forms.style.appearance_auto', 'Match visitor') },
                ]}
            />
        </>
    );
}
