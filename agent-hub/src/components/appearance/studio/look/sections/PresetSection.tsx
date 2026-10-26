import { Sun, Moon, Sparkles, Eye, Palette, FileText, Gem, BookOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import { THEME_PRESETS } from '@/components/appearance/ThemeContext';
import type { ThemeOption } from '@/components/appearance/ThemeContext.types';

import PresetCard from '../../shared/PresetCard';
import { SECTION_IDS } from '../useLookForm';
import type { LookForm, LookSectionProps } from '../useLookForm';
import { useTranslation } from '@/hooks/useTranslation';

const PRESET_ICONS: Record<string, LucideIcon> = {
    light: Sun,
    dark: Moon,
    glass: Sparkles,
    'glass-dark': Sparkles,
    paper: FileText,
    obsidian: Gem,
    sepia: BookOpen,
    'high-contrast': Eye,
    custom: Palette,
};

const PRESET_HINTS: Record<string, string> = {
    light: 'Clean, bright surfaces. Good for daytime use.',
    dark: 'Low-glare dark surfaces. Easier on the eyes at night.',
    glass: 'Translucent iOS-style Liquid Glass panels with frosted blur.',
    'glass-dark': 'Dark Liquid Glass — glowing colour over a deep night backdrop.',
    paper: 'Warm editorial light. Off-white pages, espresso text.',
    obsidian: 'Monochrome carbon dark. Hairline borders, warm-pearl accents.',
    sepia: 'Warm tan paper with deep-brown ink. Best for long reading sessions.',
    'high-contrast': 'WCAG AAA contrast pairs. Best for accessibility.',
    custom: 'Start from the active preset; tweak accent, radius and font.',
};

export default function PresetSection({ form, setForm, saving }: LookSectionProps) {
    const { t } = useTranslation();
    return (
        <section
            id={SECTION_IDS.preset}
            aria-labelledby={`${SECTION_IDS.preset}-heading`}
        >
            <SectionHeading id={`${SECTION_IDS.preset}-heading`}>{t('appearance.preset_preset', 'Preset')}</SectionHeading>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('appearance.preset_pick_the_base_look_everything_below', 'Pick the base look. Everything below adjusts within it.')}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {THEME_PRESETS.map((p: ThemeOption) => (
                    <PresetCard
                        key={p.id}
                        id={p.id}
                        label={p.label}
                        Icon={PRESET_ICONS[p.id] || Palette}
                        hint={PRESET_HINTS[p.id]}
                        selected={form.preset === p.id}
                        disabled={saving}
                        onSelect={(id: string) => setForm((f: LookForm | null) => ({ ...(f as LookForm), preset: id }))}
                    />
                ))}
            </div>
        </section>
    );
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
    return (
        <h3
            id={id}
            className="text-base font-semibold mb-1 text-[var(--text-primary)]"
        >
            {children}
        </h3>
    );
}
