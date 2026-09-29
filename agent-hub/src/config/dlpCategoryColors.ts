// Paint for the DLP review UI's category badges/highlights (dlpReview/).
//
// The product requirement is explicit: never show a raw confidence number —
// category + color, with intensity standing in for certainty. This mirrors
// PiiSensitivityPicker's existing "Low/Balanced/High" precedent for the same
// reason (a percentage is meaningless to an end user and its direction is
// counter-intuitive). The band itself is computed server-side
// (server/core/dlp/confidenceBand.js, anchored to the org's own detection
// threshold) — this module only turns that band into paint and a short label,
// it never recomputes or re-derives it from a raw score.

import { colorTokenForCategory } from './piiCategories';

export type PiiConfidenceBand = 'high' | 'medium' | 'low' | null;
export type PiiFindingSource = 'pii' | 'custom' | 'manual';

/**
 * Background alpha by band. 'medium'/'low' recede so a shakier auto-hit
 * doesn't visually compete with a certain one; 'high' AND the two
 * deterministic sources (a user's own manual mark, an org's exact custom
 * term — neither carries a probabilistic score, so band is null for both)
 * get the same full intensity, because both are certain by construction.
 */
function alphaForBand(band: PiiConfidenceBand): string {
    if (band === 'medium') return '15%';
    if (band === 'low') return '9%';
    return '22%'; // 'high' or null (manual / custom)
}

/** Inline style for a highlighted span or a category badge. */
export function categoryStyle(categoryId: string, band: PiiConfidenceBand): { background: string; borderColor: string; color: string } {
    const token = colorTokenForCategory(categoryId);
    const varRef = `var(--${token})`;
    return {
        background: `color-mix(in srgb, ${varRef} ${alphaForBand(band)}, transparent)`,
        borderColor: varRef,
        color: varRef,
    };
}

type TFn = (key: string, fallback?: string) => string;

/** Short, non-numeric certainty label — "High confidence", never "87%". */
export function confidenceLabel(source: PiiFindingSource, band: PiiConfidenceBand, t: TFn): string {
    if (source === 'manual') return t('dlp.confidence_manual', 'Marked by you');
    if (source === 'custom') return t('dlp.confidence_custom', 'Custom rule');
    if (band === 'high') return t('dlp.confidence_high', 'High confidence');
    if (band === 'medium') return t('dlp.confidence_medium', 'Possible match');
    if (band === 'low') return t('dlp.confidence_low', 'Low confidence');
    return t('dlp.confidence_high', 'High confidence');
}
