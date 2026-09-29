import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { TONES, toneOfSeverity } from '../../../shared/statusTone';

/**
 * SeverityTag — the small uppercase weight word on an OPEN check row
 * (Compliance Center redesign, Sep 2026; artboard 1b: "HOOG" in error ink
 * beside a failing title, "GEMIDDELD" in warning ink).
 *
 * Design rule 5: severity is the weight a check carries in the score, not
 * its result, so it appears only as a WORD and only on rows that are fail or
 * warn — a passing critical check has nothing to shout about. The caller
 * decides when to render it; this atom only knows how. Ink from
 * `toneOfSeverity` (critical|high → error, medium → warning, low → neutral
 * tertiary); labels reuse the existing `compliance.sev_*` keys.
 *
 * Props
 *   severity  'critical' | 'high' | 'medium' | 'low' — anything else renders nothing
 */
const LABEL = Object.freeze({
    critical: Object.freeze({ key: 'compliance.sev_critical', en: 'Must fix' }),
    high: Object.freeze({ key: 'compliance.sev_high', en: 'Should fix' }),
    medium: Object.freeze({ key: 'compliance.sev_medium', en: 'Consider' }),
    low: Object.freeze({ key: 'compliance.sev_low', en: 'Low priority' }),
});

export default function SeverityTag({ severity, className = '', testId = 'severity-tag' }) {
    const { t } = useTranslation();
    const entry = LABEL[severity];
    if (!entry) return null;
    const tone = toneOfSeverity(severity);
    return (
        <span
            data-testid={testId}
            data-severity={severity}
            data-tone={tone}
            className={`text-[10px] font-semibold uppercase tracking-[.04em] whitespace-nowrap ${className}`}
            style={{ color: TONES[tone].ink }}
        >
            {t(entry.key, entry.en)}
        </span>
    );
}
