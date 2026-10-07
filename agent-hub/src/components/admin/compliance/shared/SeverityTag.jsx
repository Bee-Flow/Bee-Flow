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
 * Two vocabularies, because the same four levels mean different things: a
 * CHECK's severity is what to do about it ("Should fix", "Consider"), an
 * INCIDENT's is how bad it is ("High", "Medium"); a medium incident that
 * reads "CONSIDER" is wrong. `vocabulary="incident"` reads the existing
 * `compliance.inc_sev_*` words.
 *
 * `tone="neutral"` drops the severity colour for secondary text: on a row
 * whose stripe or clock already carries the colour (an amber row with a red
 * word on it says two things at once), the word only needs to be read.
 *
 * Props
 *   severity    'critical' | 'high' | 'medium' | 'low' — anything else renders nothing
 *   vocabulary  'check' (default) | 'incident'
 *   tone        undefined (the severity's ink) | 'neutral'
 */
const LABEL = Object.freeze({
    critical: Object.freeze({ key: 'compliance.sev_critical', en: 'Must fix' }),
    high: Object.freeze({ key: 'compliance.sev_high', en: 'Should fix' }),
    medium: Object.freeze({ key: 'compliance.sev_medium', en: 'Consider' }),
    low: Object.freeze({ key: 'compliance.sev_low', en: 'Low priority' }),
});

const INCIDENT_LABEL = Object.freeze({
    critical: Object.freeze({ key: 'compliance.inc_sev_critical', en: 'Critical' }),
    high: Object.freeze({ key: 'compliance.inc_sev_high', en: 'High' }),
    medium: Object.freeze({ key: 'compliance.inc_sev_medium', en: 'Medium' }),
    low: Object.freeze({ key: 'compliance.inc_sev_low', en: 'Low' }),
});

export default function SeverityTag({ severity, vocabulary = 'check', tone = undefined, className = '', testId = 'severity-tag' }) {
    const { t } = useTranslation();
    const entry = (vocabulary === 'incident' ? INCIDENT_LABEL : LABEL)[severity];
    if (!entry) return null;
    const neutral = tone === 'neutral';
    const ink = neutral ? 'neutral' : toneOfSeverity(severity);
    return (
        <span
            data-testid={testId}
            data-severity={severity}
            data-tone={ink}
            data-vocabulary={vocabulary === 'incident' ? 'incident' : 'check'}
            className={`text-[10px] font-semibold uppercase tracking-[.04em] whitespace-nowrap ${neutral ? 'text-[var(--text-secondary)]' : ''} ${className}`}
            style={neutral ? undefined : { color: TONES[ink].ink }}
        >
            {t(entry.key, entry.en)}
        </span>
    );
}
