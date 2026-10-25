import React from 'react';
import ColorPicker from '../../../../shared/ColorPicker';
import { SECTION_IDS } from '../useLookForm';
import type { LookForm, LookSectionProps } from '../useLookForm';
import { useTranslation } from '../../../../../hooks/useTranslation';

// Accent presets — deliberately avoid purple/violet (banned brand-wide).
export const ACCENT_PRESETS: string[] = [
    '#9ca3af', // neutral gray (default)
    '#3b82f6', // blue
    '#06b6d4', // cyan
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
];

export default function AccentSection({ form, setForm, saving }: LookSectionProps) {
    const { t } = useTranslation();
    return (
        <section
            id={SECTION_IDS.accent}
            aria-labelledby={`${SECTION_IDS.accent}-heading`}
        >
            <h3
                id={`${SECTION_IDS.accent}-heading`}
                className="text-base font-semibold mb-1 text-[var(--text-primary)]"
            >
                {t('appearance.accent_accent_colour', 'Accent colour')}
            </h3>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('appearance.accent_used_for_primary_buttons_selected', 'Used for primary buttons, selected items, focus rings, and active states.')}
            </p>
            <ColorPicker
                value={form.accent}
                onChange={(hex: string) =>
 setForm((f: LookForm | null) => ({ ...(f as LookForm), accent: hex }))}
                presets={ACCENT_PRESETS}
                disabled={saving}
                ariaLabel="Accent colour"
            />
        </section>
    );
}
