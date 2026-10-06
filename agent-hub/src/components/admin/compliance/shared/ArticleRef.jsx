import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * ArticleRef — the legal reference beside a check or finding
 * (Compliance Center redesign, Sep 2026; artboards 1a attention list "AVG
 * Art. 12", 1b table "Art. 28 · telt ook voor ISO A.5.20").
 *
 * A check carries `frameworks: [{ regulation, ref }]` (contract §1.2); the
 * home framework first, then every other framework the same evidence counts
 * for. This atom prints them the way a lawyer reads them:
 *
 *   { GDPR, '12' }          → "GDPR Art. 12"      (NL: "AVG Art. 12")
 *   { AIA, '50(2)' }        → "AI Act Art. 50(2)"
 *   { ISO27001, 'A.5.20' }  → "ISO A.5.20"        (an Annex A control is self-labelling)
 *   { NIS2, 'Art. 21(2)' }  → "NIS2 Art. 21(2)"   (already prefixed → left alone)
 *   { CUSTOM, 'Q-3' }       → "Q-3"               (an own framework has no short name)
 *
 * Several refs join with " · ". The regulation's short name is a translation
 * (`compliance.reg_<code>`) because the GDPR is the AVG in Dutch; the
 * "Art." abbreviation is the same in every language this product ships.
 *
 * Typography: the product's sans in tabular figures, not monospace (a mono
 * list of five references was the widest thing on a meta line and pushed
 * into the action button). Each reference is its own nowrap span and the
 * line may wrap only BETWEEN references, never inside "Art. 21(2)(d)"; the
 * dot sticks to the reference before it. `max` shows the first n and "+k":
 * the full list is then the title and what a screen reader hears.
 *
 * Props
 *   refs      [{ regulation, ref }] — or pass `children` for a ready string
 *             (a string with " · " in it is split the same way)
 *   max       show at most this many references, then "+k"
 *   mono      opt back into the monospace face (an id column)
 *   className / testId  pass-through on the outer span
 */
export const REGULATION_LABEL = Object.freeze({
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

// Framework ids double as regulation codes in a few places (score JSONB,
// section ids); accept them so a caller need not translate first.
const ALIAS = Object.freeze({ ISO: 'ISO27001', AI_ACT: 'AIA', PRODUCT_LIABILITY: 'PLD' });

/** The translated short name of a regulation code; '' for CUSTOM or unknown. */
export function regulationLabel(regulation, t) {
    const code = String(regulation ?? '').toUpperCase();
    const entry = REGULATION_LABEL[ALIAS[code] ?? code];
    if (!entry) return '';
    return t(entry.key, entry.en);
}

// A ref that already names itself: an Annex A control ("A.5.20"), a clause
// ("cl 6.1"), an "Art."/"Article"/"Annex"/"Bijlage" prefix, a recital.
const SELF_LABELLING = /^(A\.|cl\b|Art\b|Article\b|Annex\b|Bijlage\b|Recital\b|Overweging\b)/i;

/** "Art. 12" for a bare number, the ref itself when it is already labelled. */
export function formatRef(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return '';
    if (SELF_LABELLING.test(s)) return s;
    if (/^\d/.test(s)) return `Art. ${s}`;
    return s;
}

/** One reference as text: "GDPR Art. 12" — for aria labels and search. */
export function formatArticleRef(regulation, ref, t) {
    return [regulationLabel(regulation, t), formatRef(ref)].filter(Boolean).join(' ');
}

const SEPARATOR = '\u00a0· ';

function refList(refs, children, t) {
    if (children !== undefined && children !== null) {
        if (typeof children === 'string' || typeof children === 'number') {
            return String(children).split(/\s+·\s+/).map(x => x.trim()).filter(Boolean);
        }
        return [children];
    }
    return Array.isArray(refs) ? refs.map(r => formatArticleRef(r?.regulation, r?.ref, t)).filter(Boolean) : [];
}

function Refs({ list }) {
    return list.map((text, i) => (
        <React.Fragment key={i}>
            {i > 0 ? SEPARATOR : null}
            <span className="whitespace-nowrap">{text}</span>
        </React.Fragment>
    ));
}

export default function ArticleRef({ refs, children, max = undefined, mono = false, className = '', testId = 'article-ref' }) {
    const { t } = useTranslation();
    const list = refList(refs, children, t);
    if (list.length === 0) return null;
    const limit = Number.isInteger(max) && max > 0 ? max : list.length;
    const shown = list.slice(0, limit);
    const more = list.length - shown.length;
    const allText = list.every(x => typeof x === 'string') ? list.join(' · ') : undefined;
    const face = mono ? 'font-mono' : 'tabular-nums';
    return (
        <span
            data-testid={testId}
            title={more > 0 ? allText : undefined}
            className={`text-[11px] text-[var(--text-secondary)] ${face} ${className}`.trim()}
        >
            {more > 0 ? (
                <>
                    <span aria-hidden="true">
                        <Refs list={shown} />
                        {SEPARATOR}
                        <span className="whitespace-nowrap" data-testid={`${testId}-more`}>{t('compliance.ref_more', '+{n}', { n: more })}</span>
                    </span>
                    <span className="sr-only">{allText}</span>
                </>
            ) : (
                <Refs list={shown} />
            )}
        </span>
    );
}
