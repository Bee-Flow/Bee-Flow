import { Gauge } from 'lucide-react';
import React, { useId, useState } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import {
    AdvancedThresholdSlider, PII_SENSITIVITY_PRESETS, presetFor,
} from '../../../../../privacy/PiiSensitivityPicker';
import ThresholdWarning from './ThresholdWarning';

/**
 * "How strict": the three sensitivity levels as one segmented control.
 *
 * The same presets, values and copy as the shared PiiSensitivityPicker (which
 * the personal privacy page keeps using); only the chrome is the shield's:
 * short segment names with the trade-off written once under the scale, and
 * each level's full description as its tooltip.
 *
 * The segments are native radio inputs, visually hidden inside their labels,
 * so the browser gives the group its arrow keys and one tab stop. A stored
 * value that matches no level checks no segment; the "Custom · N%" badge and
 * the open slider are then the only honest read-out.
 */

interface StrictnessCardProps {
    value: number | undefined;
    onChange: (v: number) => void;
    readOnly: boolean;
    t: TranslateFn;
}

/** Short segment names; the full ones stay the radios' accessible names. */
const SHORT: Record<string, [string, string]> = {
    strict: ['shield_look.strict_low', 'Low'],
    balanced: ['privacy.sensitivity_balanced', 'Balanced'],
    high: ['shield_look.strict_high', 'High'],
};

function Segments({ activeId, readOnly, onPick, t }: {
    activeId: string | null;
    readOnly: boolean;
    onPick: (value: number) => void;
    t: TranslateFn;
}) {
    const name = useId();
    return (
        <div
            role="radiogroup"
            aria-label={t('privacy.sensitivity_title', 'How strict should we be?')}
            className="grid grid-cols-3 gap-1 p-[3px] rounded-[10px] bg-[var(--bg-tertiary)]"
        >
            {PII_SENSITIVITY_PRESETS.map((p) => {
                const on = p.id === activeId;
                const desc = t(`privacy.sensitivity_${p.id}_desc`, p.desc);
                return (
                    <label
                        key={p.id}
                        title={desc}
                        className={'relative flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0 min-w-0 px-2.5 py-[7px] rounded-[8px] text-[13px] text-center transition-colors '
                            + 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent-primary)] '
                            + (on
                                ? 'bg-[var(--bg-card)] shadow-[var(--shadow-sm)] font-semibold text-[var(--text-primary)] '
                                : 'font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] ')
                            + (readOnly ? 'cursor-default opacity-60' : 'cursor-pointer')}
                    >
                        <input
                            type="radio"
                            className="sr-only"
                            name={name}
                            value={p.id}
                            checked={on}
                            disabled={readOnly}
                            onChange={() => onPick(p.value)}
                            aria-label={t(`privacy.sensitivity_${p.id}`, p.label)}
                            title={desc}
                        />
                        {/* Never cut a level's name: "recommended" drops under it instead. */}
                        <span className="whitespace-nowrap">{t(...SHORT[p.id])}</span>
                        {p.badge && (
                            <span className="text-[10px] font-semibold lowercase text-[var(--success-ink)] whitespace-nowrap">
                                {t('privacy.sensitivity_recommended', p.badge)}
                            </span>
                        )}
                    </label>
                );
            })}
        </div>
    );
}

export default function StrictnessCard({ value, onChange, readOnly, t }: StrictnessCardProps) {
    const v = typeof value === 'number' ? value : 0.7;
    const active = presetFor(v);
    // Open from the start when the stored value is custom: hiding the only
    // control that explains the state would be worse than the raw slider.
    const [advanced, setAdvanced] = useState(active === null);

    const pick = (next: number) => {
        onChange(next);
        // A level answers the question the slider exists for, so it folds away.
        setAdvanced(false);
    };

    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] px-4 py-3.5 flex flex-col gap-2.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
                <Gauge className="w-[15px] h-[15px] shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <h4 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('shield_look.strict_title', 'How strict')}
                </h4>
                {active === null && (
                    <span className="text-[11px] font-semibold tabular-nums px-1.5 py-px rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        {t('privacy.sensitivity_custom', 'Custom')} · {Math.round(v * 100)}%
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setAdvanced(s => !s)}
                    aria-expanded={advanced}
                    className="ml-auto text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline"
                >
                    {advanced
                        ? t('privacy.sensitivity_advanced_hide', 'Hide the advanced setting')
                        : t('shield_look.strict_advanced_show', 'Advanced: exact percentage')}
                </button>
            </div>

            <Segments activeId={active?.id ?? null} readOnly={readOnly} onPick={pick} t={t} />

            <div className="flex justify-between gap-3 text-[11px] text-[var(--text-tertiary)]">
                <span>{t('shield_look.strict_scale_low', '← misses more, fewer interruptions')}</span>
                <span className="text-right">{t('shield_look.strict_scale_high', 'hides more, also ordinary words →')}</span>
            </div>

            {advanced && <AdvancedThresholdSlider value={v} onChange={onChange} disabled={readOnly} tr={t} inline />}
            <ThresholdWarning value={v} t={t} />
        </div>
    );
}
