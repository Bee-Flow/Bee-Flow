import React from 'react';
import Slider from '@/components/shared/Slider';
import RadiusChip from '../../shared/RadiusChip';
import { SECTION_IDS } from '../useLookForm';
import type { LookForm, LookSectionProps } from '../useLookForm';
import { useTranslation } from '@/hooks/useTranslation';

export default function RadiusSection({ form, setForm, saving }: LookSectionProps) {
    const { t } = useTranslation();
    return (
        <section
            id={SECTION_IDS.radius}
            aria-labelledby={`${SECTION_IDS.radius}-heading`}
        >
            <h3
                id={`${SECTION_IDS.radius}-heading`}
                className="text-base font-semibold mb-1 text-[var(--text-primary)]"
            >
                {t('appearance.radius_corner_roundness', 'Corner roundness')}
            </h3>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('appearance.radius_a_multiplier_applied_to_every_rounded', 'A multiplier applied to every rounded corner in the app.')}
            </p>
            <Slider
                value={form.radiusScale}
                onChange={(v: number) => setForm((f: LookForm | null) => ({ ...(f as LookForm), radiusScale: v }))}
                min={0.5}
                max={1.5}
                step={0.05}
                valueFormatter={(v: number) =>
 `${v.toFixed(2)}×`}
                disabled={saving}
                trailing={
                    <div className="flex items-center gap-1.5" aria-hidden="true">
                        <RadiusChip scale={form.radiusScale} base={6} size={22} />
                        <RadiusChip scale={form.radiusScale} base={10} size={26} />
                        <RadiusChip scale={form.radiusScale} base={14} size={30} />
                    </div>
                }
            />
        </section>
    );
}
