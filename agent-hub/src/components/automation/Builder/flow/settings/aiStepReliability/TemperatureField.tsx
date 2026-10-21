import { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { FormRow, denseInputClass, inputClass } from '../formPrimitives';
import { AI_STEP_DEFAULT_TEMPERATURE, AI_STEP_TEMPERATURE_MAX, AI_STEP_TEMPERATURE_MIN } from './reliabilityModel';

const CREATIVE = 0.7;
type Preset = 'exact' | 'balanced' | 'creative' | 'custom';

function presetOf(value: number | null): Preset {
    if (value === null || value === AI_STEP_DEFAULT_TEMPERATURE) return 'balanced';
    if (value === 0) return 'exact';
    if (value === CREATIVE) return 'creative';
    return 'custom';
}

/**
 * "How varied the answers are": the model's temperature in three plain steps
 * and a custom number. The default (Balanced) is written as no value at all.
 */
export function TemperatureField({ value, onChange }: { value: number | null; onChange: (next: number | null) => void }) {
    const { t } = useTranslation();
    // Once Custom is chosen it stays, so typing 0 or 0.7 does not swap the number box for a preset under the caret.
    const [customChosen, setCustomChosen] = useState(false);
    const preset: Preset = customChosen ? 'custom' : presetOf(value);

    const pick = (next: Preset) => {
        setCustomChosen(next === 'custom');
        if (next === 'exact') onChange(0);
        else if (next === 'balanced') onChange(null);
        else if (next === 'creative') onChange(CREATIVE);
    };

    return (
        <FormRow
            label={t('ai_step_checks.temperature_label', 'How varied the answers are')}
            hint={t('ai_step_checks.temperature_hint', 'Lower gives the same answer twice for the same input, which is what you want for sorting, extracting and checking. Higher gives more varied wording, which suits writing. Balanced is the default.')}
        >
            <div className="space-y-1.5">
                <select value={preset} onChange={(e) => pick(e.target.value as Preset)} className={inputClass()}>
                    <option value="exact">{t('ai_step_checks.temperature_exact', 'Exact (0)')}</option>
                    <option value="balanced">{t('ai_step_checks.temperature_balanced', 'Balanced (0.2, default)')}</option>
                    <option value="creative">{t('ai_step_checks.temperature_creative', 'Creative (0.7)')}</option>
                    <option value="custom">{t('ai_step_checks.temperature_custom', 'Custom…')}</option>
                </select>
                {preset === 'custom' && (
                    <input
                        type="number"
                        min={AI_STEP_TEMPERATURE_MIN}
                        max={AI_STEP_TEMPERATURE_MAX}
                        step={0.1}
                        value={value ?? ''}
                        placeholder={String(AI_STEP_DEFAULT_TEMPERATURE)}
                        aria-label={t('ai_step_checks.temperature_number', 'Temperature, from 0 to 2')}
                        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
                        className={denseInputClass('w-28')}
                    />
                )}
            </div>
        </FormRow>
    );
}
