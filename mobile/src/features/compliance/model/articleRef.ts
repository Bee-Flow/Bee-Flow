/**
 * A legal reference the way a lawyer reads it: port of the pure functions of
 * agent-hub/src/components/admin/compliance/shared/ArticleRef.jsx (pinned by
 * articleRef.test.ts: REGULATION_LABEL textually, formatRef on the web's own
 * fixtures).
 *
 *   { GDPR, '12' }          → "GDPR Art. 12"      (NL: "AVG Art. 12")
 *   { ISO27001, 'A.5.20' }  → "ISO A.5.20"        (self-labelling, left alone)
 *   { NIS2, 'Art. 21(2)' }  → "NIS2 Art. 21(2)"
 *   { CUSTOM, 'Q-3' }       → "Q-3"
 */

import type { TranslateFn } from '@/core/i18n';

interface RegLabel {
    readonly key: string;
    readonly en: string;
}

export const REGULATION_LABEL: Readonly<Record<string, RegLabel>> = Object.freeze({
    GDPR: Object.freeze({ key: 'compliance.reg_gdpr', en: 'GDPR' }),
    AIA: Object.freeze({ key: 'compliance.reg_aia', en: 'AI Act' }),
    ISO27001: Object.freeze({ key: 'compliance.reg_iso27001', en: 'ISO' }),
    NIS2: Object.freeze({ key: 'compliance.reg_nis2', en: 'NIS2' }),
    CRA: Object.freeze({ key: 'compliance.reg_cra', en: 'CRA' }),
    DATA_ACT: Object.freeze({ key: 'compliance.reg_data_act', en: 'Data Act' }),
    PLD: Object.freeze({ key: 'compliance.reg_pld', en: 'PLD' }),
    EAA: Object.freeze({ key: 'compliance.reg_eaa', en: 'EAA' }),
    DORA: Object.freeze({ key: 'compliance.reg_dora', en: 'DORA' }),
    MACHINERY: Object.freeze({ key: 'compliance.reg_machinery', en: 'Machinery' }),
    CUSTOM: Object.freeze({ key: 'compliance.reg_custom', en: '' }),
});

/** Framework ids double as regulation codes in a few places. */
const ALIAS: Readonly<Record<string, string>> = Object.freeze({ ISO: 'ISO27001', AI_ACT: 'AIA', PRODUCT_LIABILITY: 'PLD' });

/** The translated short name of a regulation code; '' for CUSTOM or unknown. */
export function regulationLabel(regulation: unknown, t: TranslateFn): string {
    const code = String(regulation ?? '').toUpperCase();
    const entry = REGULATION_LABEL[ALIAS[code] ?? code];
    if (!entry || !entry.en) return '';
    return t(entry.key, entry.en);
}

const SELF_LABELLING = /^(A\.|cl\b|Art\b|Article\b|Annex\b|Bijlage\b|Recital\b|Overweging\b)/i;

/** "Art. 12" for a bare number, the ref itself when it is already labelled. */
export function formatRef(ref: unknown): string {
    const s = String(ref ?? '').trim();
    if (!s) return '';
    if (SELF_LABELLING.test(s)) return s;
    if (/^\d/.test(s)) return `Art. ${s}`;
    return s;
}

/** One reference as text: "GDPR Art. 12". */
export function formatArticleRef(regulation: unknown, ref: unknown, t: TranslateFn): string {
    return [regulationLabel(regulation, t), formatRef(ref)].filter(Boolean).join(' ');
}

export interface ArticleRefValue {
    readonly regulation?: unknown;
    readonly ref?: unknown;
}

/** The first `max` references joined with " · ", then "+k" for the rest. */
export function refsLine(refs: readonly ArticleRefValue[] | null | undefined, max = 2, t: TranslateFn): string {
    const all = (refs ?? []).map((r) => formatArticleRef(r?.regulation, r?.ref, t)).filter(Boolean);
    const shown = all.slice(0, Math.max(0, max));
    const rest = all.length - shown.length;
    return rest > 0 ? [...shown, t('compliance.ref_more', '+{n}', { n: rest })].join(' · ') : shown.join(' · ');
}
