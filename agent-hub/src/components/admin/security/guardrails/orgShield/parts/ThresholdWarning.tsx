import { Info } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { presetFor } from '../../../../../privacy/PiiSensitivityPicker';

/**
 * The warning for an off-scale CUSTOM sensitivity.
 *
 * Only a custom value earns one. An older rule fired at >= 0.85 and < 0.45,
 * which are exactly the Low and High levels, so both offered choices scolded
 * the admin the moment they were picked. A named level is a decision; its
 * trade-off is already written under the scale.
 */
export default function ThresholdWarning({ value, t }: { value: number; t: TranslateFn }) {
    if (presetFor(value)) return null;
    const high = value >= 0.85;
    const low = value < 0.45;
    if (!high && !low) return null;

    return (
        <p
            className={'flex items-start gap-1.5 m-0 px-2.5 py-2 rounded-lg border text-[11px] leading-relaxed '
                + (high
                    ? 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border-[color-mix(in_srgb,var(--warning)_30%,transparent)] text-[var(--warning-ink)]'
                    : 'bg-[color-mix(in_srgb,var(--info)_10%,transparent)] border-[color-mix(in_srgb,var(--info)_30%,transparent)] text-[var(--info-ink)]')}
        >
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
            <span>
                {high
                    ? t('admin.shield_pii_confidence_too_high_custom',
                        'At this setting almost nothing is hidden. Short messages usually score between 60% and 85%, so names, company names and addresses will get through.')
                    : t('admin.shield_pii_confidence_too_low_custom',
                        'This is below the High sensitivity level, so expect more ordinary words to be hidden as well.')}
            </span>
        </p>
    );
}
