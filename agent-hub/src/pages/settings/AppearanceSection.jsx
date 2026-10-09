import React, { useState } from 'react';
import { Sun, Moon, Sparkles, Eye, Lock, FileText, Gem, BookOpen } from 'lucide-react';
import { useTheme, THEME_PRESETS } from '../../components/appearance/ThemeContext';
import PresetCard from '../../components/appearance/studio/shared/PresetCard';
import WallpaperPresets from '../../components/appearance/WallpaperPresets';
import { toast } from '../../components/shared/Toast';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * AppearanceSection — user-facing theme overrides. End users pick a theme
 * preset (plus the wallpaper mood under glass themes); accent colour and
 * typography stay admin-controlled so the org's brand remains coherent.
 *
 *   - Hides everything when the admin disabled `allowUserOverride`.
 *   - "Reset to organisation default" sits at the top so it's the first thing
 *     a member spots when they want out of their personalisation.
 *   - Save is implicit per-control — no batch save — so end users don't have
 *     to think about a save bar like admins do.
 */

const USER_PRESETS = [
    { id: 'light',          Icon: Sun,        hintKey: 'settings.appearance.hint_light', hint: 'Clean, bright surfaces.' },
    { id: 'paper',          Icon: FileText,   hintKey: 'settings.appearance.hint_paper', hint: 'Warm editorial light.' },
    { id: 'sepia',          Icon: BookOpen,   hintKey: 'settings.appearance.hint_sepia', hint: 'Warm tan paper, focus reading.' },
    { id: 'glass',          Icon: Sparkles,   hintKey: 'settings.appearance.hint_glass', hint: 'Translucent Liquid Glass panels.' },
    { id: 'glass-dark',     Icon: Sparkles,   hintKey: 'settings.appearance.hint_glass_dark', hint: 'Dark Liquid Glass.' },
    { id: 'dark',           Icon: Moon,       hintKey: 'settings.appearance.hint_dark', hint: 'Low-glare dark surfaces.' },
    { id: 'obsidian',       Icon: Gem,        hintKey: 'settings.appearance.hint_obsidian', hint: 'Monochrome carbon dark.' },
    { id: 'high-contrast',  Icon: Eye,        hintKey: 'settings.appearance.hint_high_contrast', hint: 'WCAG AAA contrast — accessibility.' },
];

export default function AppearanceSection() {
    const { t } = useTranslation();
    const theme = useTheme();
    const [busy, setBusy] = useState(false);

    if (theme.allowUserOverride === false) {
        return (
            <div className="max-w-3xl mx-auto px-6 py-6">
                <header className="mb-6">
                    <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('settings.appearance.title', 'Appearance')}
                    </h2>
                </header>
                <div
                    className="px-4 py-3 rounded-xl flex items-start gap-3"
                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                >
                    <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                    <p className="text-sm">
                        {t('settings.appearance.locked_prefix', 'Your organisation has locked the appearance to')} <strong>{labelForPreset(theme.preset)}</strong>{t('settings.appearance.locked_suffix', '. Contact an administrator if you need to change it.')}
                    </p>
                </div>
            </div>
        );
    }

    const isGlassPreset = theme.preset === 'glass' || theme.preset === 'glass-dark';

    const apply = async (patch, message) => {
        setBusy(true);
        try {
            await theme.setUserOverride(patch);
            if (message) toast.success(message);
        } catch (e) {
            toast.error(e?.message || 'Could not save');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
                <header>
                    <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('settings.appearance.title', 'Appearance')}
                    </h2>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                        {t('settings.appearance.subtitle', 'Customise how Bee Flow looks on this device. Only you see your choice.')}
                    </p>
                </header>

                <section>
                    <SectionLabel>{t('settings.appearance.theme', 'Theme')}</SectionLabel>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {USER_PRESETS.map(({ id, Icon, hintKey, hint }) => {
                            const meta = THEME_PRESETS.find((p) => p.id === id);
                            return (
                                <PresetCard
                                    key={id}
                                    id={id}
                                    label={meta?.label || id}
                                    Icon={Icon}
                                    hint={t(hintKey, hint)}
                                    selected={theme.preset === id}
                                    disabled={busy}
                                    onSelect={(next) => apply({ preset: next }, `Switched to ${meta?.label || next}`)}
                                />
                            );
                        })}
                    </div>
                </section>

                {isGlassPreset && (
                    <section>
                        <SectionLabel>{t('settings.appearance.mood', 'Mood')}</SectionLabel>
                        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                            {t('settings.appearance.mood_hint', 'The colour palette behind glass surfaces.')}
                        </p>
                        <WallpaperPresets
                            value={theme.wallpaperPreset || 'mono'}
                            onChange={(id) => apply({ wallpaperPreset: id }, id)}
                            disabled={busy}
                        />
                    </section>
                )}
            </div>
        </div>
    );
}

function labelForPreset(id) {
    return THEME_PRESETS.find((p) => p.id === id)?.label || id;
}

function SectionLabel({ children }) {
    return (
        <h3
            className="text-xs font-semibold uppercase tracking-wider mb-3"
            style={{ color: 'var(--text-muted)' }}
        >
            {children}
        </h3>
    );
}
