import { ArrowUpRight, CalendarClock, PenLine, ScanSearch } from 'lucide-react';
import React, { useId } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES, toneOfScore, headlineKeyOfScore, HEADLINE_FALLBACK } from '../../../../shared/statusTone';
import { formatCalDate } from '../../shared/calendarMath';
import MiniBars from '../../shared/MiniBars';
import ScoreRing from '../../shared/ScoreRing';

/**
 * FrameworkScoreCard — one framework's score on the Overview (artboard 1a,
 * PLAN-FRONTEND C6). The whole card is a button → `onOpen()` (the hub's
 * `navigate(section)`).
 *
 * Props
 *   frameworkId   'gdpr' | 'aia' | 'iso27001' — selects the MiniBars series
 *   name          display name (already translated)
 *   icon          lucide component (14px)
 *   score         { score, total, pass, warn, fail, na } | null  (null → placeholder ring)
 *   verification  { automated:{total,pass}, attestation:{total,pass}, hybrid:{total,pass} } | null
 *   soa           { approved, total } | null  — ISO shows this instead of the attested chip
 *   history       GET /score-history rows (MiniBars)
 *   inForceSince  'YYYY-MM-DD' | null, law: 'UAVG' | 'ISO/IEC 27001:2022' | null
 *                 → the card's title and accessible description (also in the
 *                 framework header chip and Timeline › Sources): background,
 *                 not something to act on
 *   nextMilestone { date, label } | null  — the one footer line, it is actionable
 *   placeholder   true on the not-set-up path: dashed border, no numbers, `placeholderNote`
 *   unit          'checks' | 'controls' — the breakdown noun (aria-label/title of the breakdown)
 *
 * Four layers, not six: the head (ring, name, headline, one breakdown line
 * with only the non-zero buckets, problems first), one plain verification
 * line, the trend and — only when there is one — the next milestone.
 */
export default function FrameworkScoreCard({
    frameworkId, name, icon: Icon, score = null, verification = null, soa = null, history = [],
    inForceSince = null, law = null, nextMilestone = null, placeholder = false, placeholderNote = null,
    unit = 'checks', onOpen, className = '', testId = 'fw-score-card',
}) {
    const { t, resolvedLocale, locale } = useTranslation();
    const descId = useId();
    const lang = resolvedLocale || locale || 'en';
    const value = placeholder ? null : (score?.score ?? null);
    const tone = toneOfScore(value);
    const headlineKey = headlineKeyOfScore(value);

    const open = () => { if (!placeholder) onOpen?.(); };
    const onKey = (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    };

    const auto = verification ? {
        total: (verification.automated?.total || 0) + (verification.hybrid?.total || 0),
        pass: (verification.automated?.pass || 0) + (verification.hybrid?.pass || 0),
    } : null;
    const attested = verification?.attestation ? { total: verification.attestation.total || 0, pass: verification.attestation.pass || 0 } : null;

    const inForce = inForceSince ? formatCalDate(inForceSince, { locale: lang, year: 'always' }) : null;
    const inForceText = inForce
        ? (law ? t('compliance.fw_card_in_force', 'In force since {date} · {law}', { date: inForce, law })
            : t('compliance.ovw_in_force_nolaw', 'In force since {date}', { date: inForce }))
        : (law || null);
    const nextDate = nextMilestone?.date ? formatCalDate(nextMilestone.date, { locale: lang, year: 'auto' }) : null;
    const described = !placeholder && !!inForceText;
    const breakdown = breakdownVars(score);
    const breakdownFull = breakdown
        ? (unit === 'controls'
            ? t('compliance.ovw_breakdown_controls', '{total} controls · {pass} passing · {warn} attention · {fail} failing · {na} n/a', breakdown)
            : t('compliance.ovw_breakdown', '{total} checks · {pass} passing · {warn} attention · {fail} failing · {na} n/a', breakdown))
        : null;

    return (
        <div
            role={placeholder ? undefined : 'button'}
            tabIndex={placeholder ? undefined : 0}
            onClick={open}
            onKeyDown={placeholder ? undefined : onKey}
            aria-label={placeholder ? undefined : name}
            aria-describedby={described ? descId : undefined}
            title={described ? inForceText : undefined}
            data-testid={testId}
            data-framework={frameworkId}
            data-tone={tone}
            data-placeholder={placeholder ? 'true' : undefined}
            className={`group relative flex flex-col gap-3 rounded-xl bg-[var(--bg-card)] px-4 py-3.5 text-left ${placeholder ? 'border-2 border-dashed border-[var(--border-default)]' : 'border border-[var(--border-default)] cursor-pointer hover:bg-[var(--bg-secondary)]'} ${className}`}
            style={placeholder ? undefined : { boxShadow: 'var(--shadow-sm)' }}
        >
            {/* head */}
            <div className="flex items-start gap-3">
                <ScoreRing score={value} size={52} placeholder={placeholder} label={name} testId={`${testId}-ring`} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                        {Icon ? <Icon size={14} style={{ color: 'var(--kind-compliance)' }} aria-hidden /> : null}
                        <span className="truncate">{name}</span>
                    </div>
                    {placeholder ? (
                        <div className="mt-0.5 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-note`}>{placeholderNote}</div>
                    ) : (
                        <>
                            <div className="mt-0.5 text-xs font-medium" style={{ color: TONES[tone].ink }} data-testid={`${testId}-headline`}>
                                {t(headlineKey, HEADLINE_FALLBACK[headlineKey])}
                            </div>
                            {breakdown ? (
                                <div
                                    className="mt-0.5 text-[11px] text-[var(--text-tertiary)] tabular-nums"
                                    data-testid={`${testId}-breakdown`}
                                    title={breakdownFull}
                                >
                                    <span aria-hidden="true">{shortBreakdown(breakdown, t)}</span>
                                    <span className="sr-only">{breakdownFull}</span>
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
                {!placeholder && (
                    <ArrowUpRight size={14} className="shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]" aria-hidden />
                )}
            </div>

            {/* verification: one plain line, the glyphs say which is which */}
            {!placeholder && (
                <VerificationLine auto={auto} attested={attested} soa={soa} t={t} testId={testId} />
            )}
            {!placeholder && (
                <MiniBars history={history} frameworkId={frameworkId} tone={tone} testId={`${testId}-bars`} />
            )}

            {/* footer: only what you can act on */}
            {!placeholder && nextDate ? (
                <div className="flex min-w-0 items-center gap-1.5 border-t border-[var(--border-default)] pt-2.5 text-[11px] font-medium" style={{ color: TONES.warning.ink }} data-testid={`${testId}-next`} title={nextMilestone.label || undefined}>
                    <CalendarClock size={11} aria-hidden className="shrink-0" />
                    <span className="truncate">{t('compliance.ovw_next_milestone', 'next: {date} · {title}', { date: nextDate, title: nextMilestone.label || '' })}</span>
                </div>
            ) : null}
            {described ? <span id={descId} className="sr-only" data-testid={`${testId}-in-force`}>{inForceText}</span> : null}
        </div>
    );
}

const BUCKETS = Object.freeze([
    Object.freeze({ field: 'fail', key: 'compliance.ovw_bucket_fail', en: '{n} failing' }),
    Object.freeze({ field: 'warn', key: 'compliance.ovw_bucket_warn', en: '{n} attention' }),
    Object.freeze({ field: 'pass', key: 'compliance.ovw_bucket_pass', en: '{n} passing' }),
]);

/**
 * "1 failing · 1 attention · 27 passing": only the buckets that hold
 * something, problems first. The total and n/a stay in the title and in what
 * a screen reader hears; a card that only has n/a results says so.
 */
function shortBreakdown(vars, t) {
    const parts = BUCKETS.filter(b => vars[b.field] > 0).map(b => t(b.key, b.en, { n: vars[b.field] }));
    if (parts.length === 0 && vars.na > 0) parts.push(t('compliance.ovw_bucket_na', '{n} n/a', { n: vars.na }));
    return parts.join(' · ');
}

/** "21/22 automated · 6/7 self-attested" (or "SoA 32/93 approved"), glyphs instead of pill borders. */
function VerificationLine({ auto, attested, soa, t, testId }) {
    const parts = [];
    if (auto && auto.total > 0) {
        parts.push({
            id: 'auto', Glyph: ScanSearch,
            text: t('compliance.ovw_verif_auto', '{ok}/{n} automated', { ok: auto.pass, n: auto.total }),
            full: t('compliance.ovw_auto_ok', 'automated: {ok}/{n} passing', { ok: auto.pass, n: auto.total }),
        });
    }
    if (soa) {
        if (soa.total != null && soa.approved != null) {
            const text = t('compliance.ovw_soa_approved', 'SoA {approved}/{total} approved', { approved: soa.approved, total: soa.total });
            parts.push({ id: 'soa', Glyph: PenLine, text, full: text });
        }
    } else if (attested && attested.total > 0) {
        parts.push({
            id: 'attested', Glyph: PenLine,
            text: t('compliance.ovw_verif_attested', '{ok}/{n} self-attested', { ok: attested.pass, n: attested.total }),
            full: t('compliance.ovw_attested_ok', 'self-attested: {ok}/{n} passing', { ok: attested.pass, n: attested.total }),
        });
    }
    if (!parts.length) return null;
    return (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-tertiary)] tabular-nums" data-testid={`${testId}-verification`}>
            {parts.map((part, i) => (
                <React.Fragment key={part.id}>
                    {i > 0 ? <span aria-hidden="true">·</span> : null}
                    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={part.full} data-testid={`${testId}-verif-${part.id}`} data-verification={part.id === 'auto' ? 'automated' : 'attestation'}>
                        <part.Glyph size={11} aria-hidden="true" />
                        <span aria-hidden="true">{part.text}</span>
                        <span className="sr-only">{part.full}</span>
                    </span>
                </React.Fragment>
            ))}
        </div>
    );
}

/**
 * The four buckets, or null when the response did not carry them.
 *
 * `?? 0` used to fill the gaps, which printed "0 failing · 0 n/a" for a payload
 * that simply never said — the one thing an unknown count may not do. A
 * breakdown we cannot state in full is not stated at all.
 *
 * KNOWN GAP (artboard 1a, ISO card): the design's fifth slot is "nog niet
 * gecheckt" — Annex A controls with no live result — and the ISO card has no
 * "failing" slot at all. Neither number exists in the payload: computeScore
 * counts RESULTS, so a control that never ran is simply absent. Filling that
 * slot needs a controls-vs-results count from /overview; until it exists this
 * card says n/a rather than inventing a pending number.
 */
function breakdownVars(score) {
    if (!score) return null;
    const { pass, warn, fail, na } = score;
    if ([pass, warn, fail, na].some(n => typeof n !== 'number')) return null;
    return { total: typeof score.total === 'number' ? score.total : pass + warn + fail + na, pass, warn, fail, na };
}
