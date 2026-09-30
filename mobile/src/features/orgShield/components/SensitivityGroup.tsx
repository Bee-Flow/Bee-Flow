/**
 * How hard to look: the web's three named levels over the raw confidence
 * threshold (PiiSensitivityPicker.jsx), plus "Custom" for the admin who knows
 * why they want 0.65: the raw stepper shows only then, or when the stored
 * value matches no level. A LOWER threshold finds MORE — the inversion the
 * named levels exist to hide.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, OptionRow, Stepper } from '@/shared/ui';

import { SENSITIVITY_PRESETS, presetFor } from '../model/piiCatalog';

/** The server's floor (routes/orgPrivacyShield.js THRESHOLD_TEXT): 0.1 to 1. */
const MIN = 0.1;

export function SensitivityGroup({ value, onChange }: { value: number; onChange: (next: number) => void }) {
    const t = useTranslation();
    const [picked, setPicked] = useState(false);
    const preset = presetFor(value);
    const custom = picked || !preset;
    const descriptions: Record<string, string> = {
        strict: t('mobile.orgShield.sensitivity_strict_desc', 'Only hides what we are very sure about. Fewer interruptions, but some personal data can slip through.'),
        balanced: t('mobile.orgShield.sensitivity_balanced_desc', 'The tested setting. Every kind of data is tuned and measured at this level. Start here.'),
        high: t('mobile.orgShield.sensitivity_high_desc', 'Hides as much as possible. Now and then it also hides ordinary text.'),
    };
    const footer = !preset && value >= 0.85
        ? t('admin.shield_pii_confidence_too_high_custom', 'At this setting almost nothing is hidden. Short messages usually score between 60% and 85%, so names, company names and addresses will get through.')
        : !preset && value < 0.45
            ? t('admin.shield_pii_confidence_too_low_custom', 'This is below the High sensitivity level, so expect more ordinary words to be hidden as well.')
            : undefined;
    return (
        <Group title={t('mobile.orgShield.sensitivity_title', 'How strict')} footer={footer}>
            {SENSITIVITY_PRESETS.map((p) => (
                <OptionRow
                    key={p.id}
                    label={t(p.key, p.fallback)}
                    description={descriptions[p.id]}
                    selected={!custom && preset?.id === p.id}
                    onPress={() => {
                        setPicked(false);
                        onChange(p.value);
                    }}
                    testID={`sensitivity-${p.id}`}
                />
            ))}
            <OptionRow
                label={t('privacy.sensitivity_custom', 'Custom')}
                description={t('mobile.orgShield.sensitivity_custom_desc', 'Set the confidence threshold yourself.')}
                selected={custom}
                onPress={() => setPicked(true)}
                testID="sensitivity-custom"
            />
            {custom ? (
                <Stepper
                    label={t('mobile.orgShield.threshold', 'Confidence threshold')}
                    value={value}
                    onChange={(next) => onChange(Math.round(next * 100) / 100)}
                    min={MIN}
                    max={1}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    testID="threshold"
                />
            ) : null}
        </Group>
    );
}
