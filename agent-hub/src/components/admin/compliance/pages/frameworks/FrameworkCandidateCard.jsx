import { ArrowUpRight, Lock, Plus, Sparkles } from 'lucide-react';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { frameworkIcon } from './frameworkIcons';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { daysUntil, formatCalDate, parseDay, SOON_DAYS } from '../../shared/calendarMath';

/**
 * FrameworkCandidateCard — one growing-set framework on the Frameworks page
 * (artboard frame 1e). Every framework carries its own "in force since /
 * from" chip; a locked framework is shown, not hidden (lock + upgrade hint).
 *
 * `framework` = one `GET /frameworks` row:
 *   { id, name_key, description_key, affects_key, in_force_since, in_force_from,
 *     checks_count, registers[], calendar_count, enabled, core, locked: null|'ceiling'|'not_granted',
 *     lock, relevance: 'relevant'|'not_relevant'|'unknown', relevance_gate, recently_in_force, affects? }
 */

/** Pure: which status chip a framework wears today. `null` when it has no date at all. */
export function statusChipOf(framework, now = Date.now()) {
    if (!framework) return null;
    if (framework.in_force_since) {
        return { tone: 'success', tint: 14, key: 'compliance.fw_in_force_since', fallback: 'in force since {date}', date: framework.in_force_since, days: null };
    }
    if (framework.in_force_from) {
        const days = daysUntil(parseDay(framework.in_force_from), now);
        if (typeof days === 'number' && days >= 0 && days <= SOON_DAYS) {
            return { tone: 'warning', tint: 16, key: 'compliance.fw_from_in_days', fallback: 'from {date} · in {days} days', date: framework.in_force_from, days };
        }
        return { tone: 'neutral', tint: 0, key: 'compliance.fw_from', fallback: 'from {date}', date: framework.in_force_from, days };
    }
    return null;
}

/** Pure: does the Enable button wear the primary recipe? (recently in force, or marked relevant) */
export function enableIsPrimary(framework) {
    return !!framework && (framework.recently_in_force === true || framework.relevance === 'relevant');
}

/** Pure: why a framework is recommended — the "Recommended" chip's tooltip. Null when it is not. */
export function recommendedReason(framework, t) {
    if (!enableIsPrimary(framework)) return null;
    return framework.recently_in_force === true
        ? t('compliance.fw_recommended_recent', 'Recently entered into force')
        : t('compliance.fw_recommended_relevant', 'You marked this framework as relevant');
}

/**
 * Pure: a count in words, singular when n is 1: `<key>_one` ('1 check'), else
 * `<key>` ('{n} checks'). The plural fallback's own {n} is filled in for the
 * singular's fallback when no `one` text is given.
 */
export function countLabel(t, key, n, fallback, one) {
    return n === 1
        ? t(`${key}_one`, one ?? fallback.replace('{n}', '1'), { n })
        : t(key, fallback, { n });
}

/** What an `affects` count counts, plural and singular (the count is printed before the noun). */
const AFFECTS_NOUN = Object.freeze({
    automations: ['automations', 'automation'],
    agents: ['agents', 'agent'],
    webpages: ['web pages', 'web page'],
    forms: ['public forms', 'public form'],
    detections: ['machine integrations', 'machine integration'],
});

/** Above this length a description is assumed to need more than three lines when the browser cannot measure (no layout). */
const CLAMP_CHARS = 160;

const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-[9px] py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] bg-[var(--bg-card)] disabled:opacity-60';

function StatusChip({ chip, t, locale }) {
    if (!chip) return null;
    const date = formatCalDate(chip.date, { locale, year: 'always' });
    const label = t(chip.key, chip.fallback, { date, days: chip.days ?? '' });
    const toned = chip.tone !== 'neutral';
    const style = toned
        ? { background: `color-mix(in srgb, ${TONES[chip.tone].raw} ${chip.tint}%, transparent)`, color: TONES[chip.tone].ink }
        : { border: '1px solid var(--border-default)', color: 'var(--text-secondary)' };
    return (
        <span className="ml-auto text-[11px] px-[7px] py-px rounded-full font-semibold whitespace-nowrap" style={style} data-testid="fw-status-chip" data-tone={chip.tone}>
            {label}
        </span>
    );
}

export default function FrameworkCandidateCard({ framework, now, busy = false, onEnable, onDisable, onRelevance, onViewPlan, className = '', testId }) {
    const { t, resolvedLocale } = useTranslation();
    if (!framework) return null;
    const Icon = frameworkIcon(framework.id);
    const chip = statusChipOf(framework, now);
    const locked = framework.locked === 'ceiling' || framework.locked === 'not_granted';
    const gated = framework.relevance_gate === true || framework.id === 'dora' || framework.id === 'machinery';
    const notRelevant = framework.relevance === 'not_relevant';
    const checks = typeof framework.checks_count === 'number' ? framework.checks_count : null;
    const registers = Array.isArray(framework.registers) ? framework.registers.length : (typeof framework.registers_count === 'number' ? framework.registers_count : null);
    const dates = typeof framework.calendar_count === 'number' ? framework.calendar_count : null;
    const recommended = !locked && !framework.enabled ? recommendedReason(framework, t) : null;
    const affects = framework.affects && typeof framework.affects === 'object'
        ? Object.entries(framework.affects).filter(([, v]) => typeof v === 'number' && v > 0)
        : [];

    const meta = [
        checks !== null ? countLabel(t, 'compliance.fw_meta_checks', checks, '{n} checks', '1 check') : null,
        registers !== null && registers > 0 ? countLabel(t, 'compliance.fw_meta_registers', registers, '{n} registers', '1 register') : null,
        dates !== null && dates > 0 ? countLabel(t, 'compliance.fw_meta_dates', dates, '{n} calendar dates', '1 calendar date') : null,
    ].filter(Boolean).join(' · ');
    const affectsNoun = (k, v) => {
        const [many, one] = AFFECTS_NOUN[k] || [k, k];
        return v === 1 ? t(`compliance.fw_affects_${k}_one`, one) : t(`compliance.fw_affects_${k}`, many);
    };

    let footer;
    if (locked) {
        footer = (
            <>
                <span className="inline-flex items-center gap-[5px] text-[11px] text-[var(--text-tertiary)]" data-testid="fw-locked">
                    <Lock size={12} aria-hidden="true" />
                    {framework.locked === 'ceiling'
                        ? t('studio.locked_upgrade', 'Available on a higher plan')
                        : t('studio.locked_not_granted', 'Not switched on for your organisation — ask an admin')}
                </span>
                <button type="button" className={`ml-auto ${SECONDARY_BUTTON}`} onClick={() => onViewPlan?.(framework)} data-testid="fw-view-plan">
                    {t('compliance.fw_view_plan', 'View plan')}<ArrowUpRight size={12} aria-hidden="true" />
                </button>
            </>
        );
    } else if (framework.enabled) {
        footer = (
            <>
                <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="fw-enabled-meta">
                    {checks !== null
                        ? countLabel(t, 'compliance.fw_enabled_checks', checks, 'Enabled · {n} checks', 'Enabled · 1 check')
                        : t('compliance.fw_enabled', 'Enabled')}
                </span>
                <button type="button" className={`ml-auto ${SECONDARY_BUTTON}`} disabled={busy} onClick={() => onDisable?.(framework.id)} data-testid="fw-disable">
                    {t('compliance.fw_disable', 'Disable')}
                </button>
            </>
        );
    } else {
        const primary = enableIsPrimary(framework);
        footer = (
            <>
                {gated ? (
                    <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        style={notRelevant ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : { color: 'var(--text-secondary)' }}
                        aria-pressed={notRelevant}
                        disabled={busy}
                        onClick={() => onRelevance?.(framework.id, notRelevant ? 'relevant' : 'not_relevant')}
                        data-testid="fw-relevance"
                    >
                        {t('compliance.fw_not_relevant', 'Not relevant')}
                    </button>
                ) : (
                    meta && <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="fw-meta">{meta}</span>
                )}
                <button
                    type="button"
                    className={`ml-auto inline-flex items-center gap-1 px-[9px] py-1 rounded-lg text-[12px] disabled:opacity-60 ${primary ? 'font-semibold' : `font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]`}`}
                    style={primary ? PRIMARY_ACTION_STYLE : undefined}
                    disabled={busy}
                    onClick={() => onEnable?.(framework.id)}
                    data-testid="fw-enable"
                    data-primary={primary ? 'true' : 'false'}
                >
                    <Plus size={12} aria-hidden="true" />{t('compliance.fw_enable', 'Enable')}
                </button>
            </>
        );
    }

    return (
        <article
            className={`rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-3.5 py-3 flex flex-col gap-1.5 text-xs shadow-[var(--shadow-sm)] ${className}`}
            data-testid={testId || `fw-card-${framework.id}`}
            data-framework={framework.id}
            data-locked={framework.locked || undefined}
            aria-busy={busy || undefined}
        >
            {/* The name wraps (never "NIS2 · Cybersecuri…"); when it needs the room the status chip moves under it. */}
            <div className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                    <Icon size={14} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                    <span className="font-semibold" data-testid="fw-name">{t(framework.name_key, framework.name || framework.id)}</span>
                </span>
                {recommended && (
                    <span
                        className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-px rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        title={recommended}
                        data-testid="fw-recommended"
                    >
                        <Sparkles size={10} aria-hidden="true" />
                        {t('compliance.fw_recommended', 'Recommended')}
                        <span className="sr-only">{`: ${recommended}`}</span>
                    </span>
                )}
                <StatusChip chip={chip} t={t} locale={resolvedLocale} />
            </div>
            {framework.description_key && (
                <ClampedText text={t(framework.description_key, '')} t={t} testId="fw-desc" />
            )}
            {framework.affects_key && (
                <div className="text-[11px] text-[var(--text-tertiary)] leading-4">
                    <b className="text-[var(--text-secondary)] font-semibold">{t('compliance.fw_affects_label', 'Affects you:')}</b>{' '}
                    {t(framework.affects_key, '')}
                    {affects.length > 0 && (
                        <span data-testid="fw-affects-counts">{' · '}{affects.map(([k, v]) => `${v} ${affectsNoun(k, v)}`).join(' · ')}</span>
                    )}
                </div>
            )}
            <div className="flex items-center gap-2 mt-auto pt-1">{footer}</div>
        </article>
    );
}

/**
 * A description clamped to three lines, with a More / Less button when it is
 * longer. Whether it is longer is measured once laid out; without layout (a
 * test, a print preview) the length decides.
 */
function ClampedText({ text, t, testId }) {
    const ref = useRef(null);
    const [open, setOpen] = useState(false);
    const [long, setLong] = useState(() => String(text || '').length > CLAMP_CHARS);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || open || !el.clientHeight) return;
        setLong(el.scrollHeight > el.clientHeight + 1);
    }, [text, open]);
    if (!text) return null;
    return (
        <div className="flex flex-col items-start gap-0.5">
            <div ref={ref} className={`text-[var(--text-secondary)] leading-4 ${open ? '' : 'line-clamp-3'}`} data-testid={testId} data-clamped={open ? 'false' : 'true'}>{text}</div>
            {(long || open) && (
                <button
                    type="button"
                    className="text-[11px] font-medium text-[var(--text-tertiary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
                    aria-expanded={open}
                    onClick={() => setOpen(v => !v)}
                    data-testid={`${testId}-toggle`}
                >
                    {open ? t('compliance.fw_less', 'Less') : t('compliance.fw_more', 'More')}
                </button>
            )}
        </div>
    );
}

/** The dashed "Own framework" card that closes the grid — a door to the custom-frameworks page. */
export function OwnFrameworkCard({ onOpen, className = '' }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onOpen}
            className={`rounded-xl border border-dashed border-[var(--border-default)] px-3.5 py-3 flex flex-col gap-1.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] ${className}`}
            data-testid="fw-card-own"
        >
            <span className="flex items-center gap-2"><Plus size={14} aria-hidden="true" /><span className="font-semibold">{t('compliance.fw_custom_title', 'Own framework')}</span></span>
            <span className="leading-4">{t('compliance.fw_custom_desc', 'For example a customer\'s NIS2 questionnaire or a sector code: attest checks yourself, with evidence and the same clocks.')}</span>
        </button>
    );
}
