import { Gauge, SignalHigh, SignalLow, SignalMedium } from 'lucide-react';
import React, { useState } from 'react';

import ChoiceCards from '../shared/ChoiceCards';

/**
 * Three-level sensitivity picker over the raw PII confidence threshold.
 *
 * The stored value stays a float (`piiDetectionConfidenceThreshold`, the
 * guard's slider anchor math is untouched) — this component only translates
 * it for humans. "Confidence Threshold 50%" tells an end user nothing; worse,
 * the direction is inverted (a LOWER number detects MORE), which is exactly
 * the kind of dial people turn the wrong way. So: three named levels, the
 * calibrated default in the middle, and the raw slider tucked behind an
 * "advanced" fold for the admins who know why they want 0.65.
 *
 * Preset values are deliberate, not decorative:
 *   - 0.70 is the calibration anchor — every per-category floor in the guard
 *     (pii.py _PER_CATEGORY_THRESHOLD) is tuned AT this slider position, and
 *     every published quality number is measured here. That is what
 *     "recommended" means: the tested configuration.
 *   - 0.45 shifts every floor down 0.25 — the "rather a false alarm than a
 *     leak" stance.
 *   - 0.85 shifts every floor up 0.15 — fewer interruptions, accepts misses.
 *
 * Shared between the admin OrgShieldEditor and the personal
 * ConsumerPrivacySection so both stay visually and semantically aligned.
 */

// Display order: low → high, left to right — the direction people read a
// scale. (Note the underlying threshold runs the OPPOSITE way: low
// sensitivity = high threshold. That inversion is exactly why the raw slider
// confused people, and why these cards exist.)
export const PII_SENSITIVITY_PRESETS = [
    // Icons form a rising scale left to right, so the picture agrees with the
    // reading order and with the labels. Three unrelated pictograms (a target,
    // a scale, a magnifier) implied three different KINDS of thing rather than
    // three points on one axis.
    {
        id: 'strict',
        value: 0.85,
        Icon: SignalLow,
        label: 'Low sensitivity',
        desc: 'Only hides what we are very sure about. Fewer interruptions, but some personal data can slip through.',
    },
    {
        id: 'balanced',
        value: 0.70,
        Icon: SignalMedium,
        label: 'Balanced',
        badge: 'Recommended',
        desc: 'The tested setting. Every kind of data is tuned and measured at this level. Start here.',
    },
    {
        id: 'high',
        value: 0.45,
        Icon: SignalHigh,
        label: 'High sensitivity',
        desc: 'Hides as much as possible. Now and then it also hides ordinary text — a word that looks like a name, a number that looks like an ID.',
    },
];

// Wide enough to absorb float noise and the 0.05 slider steps around a
// preset; narrow enough that a deliberate custom value shows as custom.
const SNAP = 0.024;

export function presetFor(value) {
    const v = typeof value === 'number' ? value : 0.7;
    return PII_SENSITIVITY_PRESETS.find(p => Math.abs(p.value - v) < SNAP) || null;
}

/**
 * @param {'inset'|'card'} [variant] Chrome only. 'inset' is the original
 *   sunken panel, used inside the personal privacy section and signup. 'card'
 *   is the standalone card the Privacy Shield's detection pane lays out in a
 *   two-up grid: its own surface, a heading, and the advanced toggle pulled up
 *   onto the heading row. Same control, same semantics, same copy — a second
 *   sensitivity picker would have been one design language too many.
 */
export function PiiSensitivityPicker({ value, onChange, disabled = false, t, variant = 'inset' }) {
    const tr = t || ((_key, fallback) => fallback);
    const v = typeof value === 'number' ? value : 0.7;
    const active = presetFor(v);
    // The advanced fold starts open when the stored value is custom —
    // hiding the only control that explains the state would be worse than
    // the raw slider ever was.
    const [showAdvanced, setShowAdvanced] = useState(active === null);
    const card = variant === 'card';

    // i18n keyed by preset id, so the display ORDER of the canonical array can
    // change without silently mislabeling a level.
    const presets = PII_SENSITIVITY_PRESETS.map(p => ({
        ...p,
        label: tr(`privacy.sensitivity_${p.id}`, p.label),
        desc: tr(`privacy.sensitivity_${p.id}_desc`, p.desc),
        badge: p.badge ? tr('privacy.sensitivity_recommended', p.badge) : undefined,
    }));

    return (
        <div
            className={card ? 'p-3.5 rounded-xl' : 'p-4 rounded-xl border'}
            style={card
                ? { background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }
                : { background: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}
        >
            <div className="flex items-center gap-2 mb-2 flex-wrap">
                {card && (
                    <Gauge className="w-[15px] h-[15px] shrink-0" aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
                )}
                <label
                    className={card ? 'text-[13px] font-semibold' : 'text-xs font-medium text-muted'}
                    style={card ? { color: 'var(--text-primary)' } : undefined}
                >
                    {tr('privacy.sensitivity_title', 'How strict should we be?')}
                </label>
                {active === null && (
                    <span className="text-xs font-mono px-2 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--accent-primary)' }}>
                        {tr('privacy.sensitivity_custom', 'Custom')} · {Math.round(v * 100)}%
                    </span>
                )}
                {/* In card mode the advanced toggle rides the heading row, so
                    the card keeps a flat three-row rhythm in a grid beside its
                    neighbour instead of growing a fourth line below the fold. */}
                {card && (
                    <button
                        type="button"
                        onClick={() => setShowAdvanced(s => !s)}
                        aria-expanded={showAdvanced}
                        className="ml-auto text-[11px] hover:underline"
                        style={{ color: 'var(--text-tertiary)' }}
                    >
                        {showAdvanced
                            ? tr('privacy.sensitivity_advanced_hide', 'Hide the advanced setting')
                            : tr('privacy.sensitivity_advanced_show', 'Advanced: set an exact percentage')}
                    </button>
                )}
            </div>
            {/* A radio group, not three buttons: these are mutually exclusive
                and their selected state used to be carried by colour alone. */}
            <ChoiceCards
                value={active?.id ?? null}
                onChange={(id) => {
                    const opt = presets.find(p => p.id === id);
                    if (!opt) return;
                    onChange(opt.value);
                    // Choosing a level answers the question the advanced fold
                    // exists for — auto-hide it, so the raw slider only lingers
                    // while a value is genuinely custom or explicitly requested.
                    setShowAdvanced(false);
                }}
                disabled={disabled}
                columns={3}
                ariaLabel={tr('privacy.sensitivity_title', 'How strict should we be?')}
                options={presets.map(p => ({
                    value: p.id,
                    label: p.label,
                    description: p.desc,
                    Icon: p.Icon,
                    badge: p.badge,
                }))}
            />

            {!card && (
                <button
                    type="button"
                    onClick={() => setShowAdvanced(s => !s)}
                    aria-expanded={showAdvanced}
                    className="text-[10px] mt-3 underline decoration-dotted"
                    style={{ color: 'var(--text-muted)' }}
                >
                    {showAdvanced
                        ? tr('privacy.sensitivity_advanced_hide', 'Hide the advanced setting')
                        : tr('privacy.sensitivity_advanced_show', 'Advanced: set an exact percentage')}
                </button>
            )}
            {showAdvanced && (
                <AdvancedThresholdSlider value={v} onChange={onChange} disabled={disabled} tr={tr} inline={card} />
            )}
        </div>
    );
}

/**
 * The raw threshold, with its DIRECTION in words.
 *
 * The scale runs backwards — a lower threshold finds more — and this is the
 * one control on the screen that exposes that. The percentage therefore never
 * appears without the words: the ends of the track say "finds more" and "finds
 * less", and the number trails behind them rather than leading. An admin who
 * wants to be strict and reads only a number types 90 and switches detection
 * off in practice; an admin who reads "finds less" at that end does not.
 *
 * `inline` puts the labels either side of the track (the card layout, where
 * vertical space is tight) rather than beneath it.
 *
 * Exported for the Privacy Shield's "How strict" card, which puts the same
 * slider under its own segmented control instead of these cards.
 */
export function AdvancedThresholdSlider({ value, onChange, disabled, tr, inline = false }) {
    const pct = Math.round(value * 100);
    const slider = (
        <input
            type="range" min="0.1" max="1.0" step="0.05"
            disabled={disabled}
            value={value}
            onChange={e => onChange(parseFloat(e.target.value))}
            aria-label={tr('privacy.sensitivity_slider_label', 'Detection sensitivity')}
            // Without this a screen reader reads "70" — the number whose
            // direction is the entire problem.
            aria-valuetext={tr('privacy.sensitivity_valuetext', '{pct}% — lower finds more', { pct })}
            className={`${inline ? 'flex-1 min-w-[120px]' : 'w-full'} accent-[var(--accent-primary)]`}
        />
    );

    const more = tr('privacy.sensitivity_finds_more', 'finds more');
    const less = tr('privacy.sensitivity_finds_less', 'finds less');

    if (inline) {
        return (
            <div className="flex items-center gap-2.5 mt-1 flex-wrap">
                <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{more}</span>
                {slider}
                <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{less}</span>
                <span className="text-[11px] whitespace-nowrap tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{pct}%</span>
            </div>
        );
    }

    return (
        <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted">
                    {tr('privacy.sensitivity_advanced_note', 'Every kind of data has its own tuned level; this moves them all together. Lower = find more.')}
                </span>
                <span className="text-xs font-mono px-2 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--accent-primary)' }}>
                    {pct}%
                </span>
            </div>
            {slider}
            <div className="flex justify-between text-[10px] mt-1">
                <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{more}</span>
                <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{less}</span>
            </div>
        </div>
    );
}

export default PiiSensitivityPicker;
