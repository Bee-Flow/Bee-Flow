import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { TONES, toneOfScore } from '../../../shared/statusTone';

/**
 * ScoreRing — the 0–100 conic score ring of the Compliance Center (redesign,
 * Sep 2026; artboard 1a framework cards at 52px, 1h phone rows at 36px, 1g
 * placeholder rings before the first run).
 *
 * The ring is a `conic-gradient` on a round div with a smaller disc on top —
 * no SVG, no stroke maths, and above all NO COLOUR OF ITS OWN: the arc reads
 * `TONES[tone].raw` (the `--success/--warning/--error` token), the rest of
 * the ring is `--bg-tertiary`, the disc is `--bg-card`. The previous SVG ring
 * carried three literal green/amber/red hexes and was the reason the
 * compliance tree got its own no-hex scan.
 *
 * Two design sizes are exact (artboard measurements literal): 52px → 40px
 * disc, 15px bold number; 36px → 27px disc, 11px number. Any other size
 * scales the 52px proportions.
 *
 * A score that is UNKNOWN (null, undefined, not a number) renders the
 * placeholder ring, not "0": a zero would claim the org failed every check
 * when it has simply never run one (behavioural rule: unknown counts render
 * nothing, never 0). `placeholder` forces that state for the 1g cards even
 * when a stale number is around.
 *
 * Props
 *   score        0–100 (clamped, rounded); non-numeric → placeholder
 *   size         outer diameter in px (52 desktop card · 36 phone row)
 *   tone         'success' | 'warning' | 'error' | 'neutral' — defaults to
 *                toneOfScore(score) so the arc and the headline agree
 *   placeholder  render the dashed "—" ring regardless of score (1g)
 *   label        names WHAT is scored in the accessible name ("GDPR: 79 of
 *                100") — three rings on one card row need telling apart
 *   className / testId  pass-through on the outer element
 */
export default function ScoreRing({
    score, size = 52, tone, placeholder = false, label, className = '', testId = 'score-ring',
}) {
    const { t } = useTranslation();
    const n = Number(score);
    const isPlaceholder = placeholder || score === null || score === undefined || score === '' || !Number.isFinite(n);
    const s = isPlaceholder ? null : Math.max(0, Math.min(100, Math.round(n)));

    const numeric = isPlaceholder ? null : t('compliance.score_aria', '{score} of 100', { score: s });
    const state = isPlaceholder ? t('compliance.score_aria_pending', 'No score yet') : numeric;
    const ariaLabel = label ? `${label}: ${state}` : state;

    if (isPlaceholder) {
        return (
            <div
                role="img"
                aria-label={ariaLabel}
                data-testid={testId}
                data-placeholder="true"
                className={`grid place-items-center shrink-0 rounded-full font-semibold text-[12px] text-[var(--text-tertiary)] box-border ${className}`}
                style={{ width: size, height: size, border: '2px dashed var(--border-default)' }}
            >
                —
            </div>
        );
    }

    // 52 → 12px ring (40px disc), 36 → 9px ring (27px disc); other sizes
    // follow the 52px proportions. Same for the number: 15px at 52, 11px at 36.
    const ring = size >= 48 ? Math.round(size * 12 / 52) : 9;
    const fontSize = size >= 48 ? Math.round(size * 15 / 52) : 11;
    const inner = size - ring;
    const resolvedTone = TONES[tone] ? tone : toneOfScore(s);
    const arc = TONES[resolvedTone].raw;

    return (
        <div
            role="img"
            aria-label={ariaLabel}
            data-testid={testId}
            data-tone={resolvedTone}
            data-score={s}
            className={`grid place-items-center shrink-0 rounded-full ${className}`}
            style={{
                width: size,
                height: size,
                background: `conic-gradient(${arc} 0 ${s}%, var(--bg-tertiary) ${s}% 100%)`,
            }}
        >
            <div
                className="grid place-items-center rounded-full bg-[var(--bg-card)] text-[var(--text-primary)] font-bold leading-none"
                style={{ width: inner, height: inner, fontSize }}
                aria-hidden="true"
            >
                {s}
            </div>
        </div>
    );
}
