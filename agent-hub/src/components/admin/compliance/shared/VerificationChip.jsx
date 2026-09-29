import React from 'react';
import { PenLine, ScanSearch } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * VerificationChip — HOW a check result was established (Compliance Center
 * redesign, Sep 2026; artboards 1a card chips, 1b table column and legend).
 *
 * The honest split the whole hub is built on: a result the tool measured
 * itself and a result an administrator declared must never look alike, or a
 * green score promises more than the software has seen. So the difference
 * is in the BORDER, not only the glyph:
 *
 *   automated    solid 1px `--border-default` + ScanSearch   "automatisch vastgesteld"
 *   attestation  1px DASHED `--text-tertiary` + PenLine      "zelf verklaard"
 *   hybrid       solid border + both glyphs                  "vastgesteld + verklaard"
 *
 * Labels reuse the existing `compliance.verification_*` keys; the `_hint`
 * twin becomes the `title` so a hover explains what the word means.
 *
 * Props
 *   verification  'automated' | 'attestation' | 'hybrid' — anything else renders nothing
 *   minimal       glyph + label only, 10px, no border (the attention list's
 *                 meta line: "· ✎ zelf verklaard")
 */
const KIND = Object.freeze({
    automated: {
        glyphs: [ScanSearch],
        labelKey: 'compliance.verification_automated', labelEn: 'Verified automatically',
        hintKey: 'compliance.verification_automated_hint', hintEn: 'This result is evaluated from live system state and telemetry.',
        border: '1px solid var(--border-default)',
    },
    attestation: {
        glyphs: [PenLine],
        labelKey: 'compliance.verification_attestation', labelEn: 'Self-attested',
        hintKey: 'compliance.verification_attestation_hint', hintEn: 'This result reflects what an administrator declared — the tool cannot verify it independently.',
        border: '1px dashed var(--text-tertiary)',
    },
    hybrid: {
        glyphs: [ScanSearch, PenLine],
        labelKey: 'compliance.verification_hybrid', labelEn: 'Verified + attested',
        hintKey: 'compliance.verification_hybrid_hint', hintEn: 'Automated evidence combined with an administrator attestation.',
        border: '1px solid var(--border-default)',
    },
});

export const VERIFICATION_KINDS = Object.freeze(Object.keys(KIND));

export default function VerificationChip({ verification, minimal = false, className = '', testId = 'verification-chip' }) {
    const { t } = useTranslation();
    const kind = KIND[verification];
    if (!kind) return null;
    const label = t(kind.labelKey, kind.labelEn);
    const hint = t(kind.hintKey, kind.hintEn);
    const glyphSize = minimal ? 10 : 11;

    return (
        <span
            title={hint}
            data-testid={testId}
            data-verification={verification}
            className={`inline-flex items-center whitespace-nowrap text-[var(--text-secondary)] ${minimal ? 'gap-[3px] text-[10px]' : 'gap-1 text-[11px]'} ${className}`}
            style={minimal ? undefined : { padding: '1px 7px', borderRadius: 999, border: kind.border }}
        >
            {kind.glyphs.map((Glyph, i) => (
                <Glyph key={i} style={{ width: glyphSize, height: glyphSize }} aria-hidden="true" />
            ))}
            {label}
        </span>
    );
}
