import React from 'react';
import { ArrowUpRight, CalendarCheck, CalendarClock, PenLine, ScanSearch } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES, toneOfScore, headlineKeyOfScore, HEADLINE_FALLBACK } from '../../../../shared/statusTone';
import ScoreRing from '../../shared/ScoreRing';
import MiniBars from '../../shared/MiniBars';
import { formatCalDate } from '../../shared/calendarMath';

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
 *   nextMilestone { date, label } | null  — the AI Act's right footer slot
 *   placeholder   true on the not-set-up path: dashed border, no numbers, `placeholderNote`
 *   unit          'checks' | 'controls' — the breakdown noun
 */
export default function FrameworkScoreCard({
    frameworkId, name, icon: Icon, score = null, verification = null, soa = null, history = [],
    inForceSince = null, law = null, nextMilestone = null, placeholder = false, placeholderNote = null,
    unit = 'checks', onOpen, className = '', testId = 'fw-score-card',
}) {
    const { t, resolvedLocale, locale } = useTranslation();
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
    const nextDate = nextMilestone?.date ? formatCalDate(nextMilestone.date, { locale: lang, year: 'auto' }) : null;

    return (
        <div
            role={placeholder ? undefined : 'button'}
            tabIndex={placeholder ? undefined : 0}
            onClick={open}
            onKeyDown={placeholder ? undefined : onKey}
            aria-label={placeholder ? undefined : name}
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
                            {breakdownVars(score) ? (
                                <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)] tabular-nums" data-testid={`${testId}-breakdown`}>
                                    {unit === 'controls'
                                        ? t('compliance.ovw_breakdown_controls', '{total} controls · {pass} passing · {warn} attention · {fail} failing · {na} n/a', breakdownVars(score))
                                        : t('compliance.ovw_breakdown', '{total} checks · {pass} passing · {warn} attention · {fail} failing · {na} n/a', breakdownVars(score))}
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
                {!placeholder && (
                    <ArrowUpRight size={14} className="shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]" aria-hidden />
                )}
            </div>

            {/* verification chips + trend */}
            {!placeholder && (
                <div className="flex flex-wrap items-center gap-1.5" data-testid={`${testId}-chips`}>
                    {auto && auto.total > 0 ? (
                        <CountChip kind="automated" testId={`${testId}-chip-auto`}>
                            {t('compliance.ovw_auto_ok', 'automated: {ok}/{n} passing', { ok: auto.pass, n: auto.total })}
                        </CountChip>
                    ) : null}
                    {soa ? (
                        soa.total != null && soa.approved != null ? (
                            <CountChip kind="attestation" testId={`${testId}-chip-soa`}>
                                {t('compliance.ovw_soa_approved', 'SoA {approved}/{total} approved', { approved: soa.approved, total: soa.total })}
                            </CountChip>
                        ) : null
                    ) : attested && attested.total > 0 ? (
                        <CountChip kind="attestation" testId={`${testId}-chip-attested`}>
                            {t('compliance.ovw_attested_ok', 'self-attested: {ok}/{n} passing', { ok: attested.pass, n: attested.total })}
                        </CountChip>
                    ) : null}
                </div>
            )}
            {!placeholder && (
                <MiniBars history={history} frameworkId={frameworkId} tone={tone} testId={`${testId}-bars`} />
            )}

            {/* footer */}
            {!placeholder && (inForce || law || nextDate) ? (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-default)] pt-2.5 text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-footer`}>
                    {(inForce || law) ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                            <CalendarCheck size={11} aria-hidden />
                            <span className="truncate">
                                {inForce
                                    ? (law ? t('compliance.ovw_in_force', 'In force since {date} · {law}', { date: inForce, law })
                                        : t('compliance.ovw_in_force_nolaw', 'In force since {date}', { date: inForce }))
                                    : law}
                            </span>
                        </span>
                    ) : <span />}
                    {nextDate ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium" style={{ color: TONES.warning.ink }} data-testid={`${testId}-next`}>
                            <CalendarClock size={11} aria-hidden />
                            <span className="truncate">{t('compliance.ovw_next_milestone', 'next: {date} · {title}', { date: nextDate, title: nextMilestone.label || '' })}</span>
                        </span>
                    ) : null}
                </div>
            ) : null}
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

/** VerificationChip styling with a count as its label (solid = automated, dashed = attested). */
export function CountChip({ kind, children, testId }) {
    const dashed = kind === 'attestation';
    const Glyph = dashed ? PenLine : ScanSearch;
    return (
        <span
            data-testid={testId}
            data-verification={kind}
            className="inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[10px] font-medium text-[var(--text-secondary)] tabular-nums"
            style={{ border: dashed ? '1px dashed var(--text-tertiary)' : '1px solid var(--border-default)' }}
        >
            <Glyph size={10} aria-hidden />
            {children}
        </span>
    );
}
