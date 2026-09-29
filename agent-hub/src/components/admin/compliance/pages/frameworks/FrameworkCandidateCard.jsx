import React from 'react';
import { ArrowUpRight, Lock, Plus } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { daysUntil, formatCalDate, parseDay, SOON_DAYS } from '../../shared/calendarMath';
import { frameworkIcon } from './frameworkIcons';

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
    const affects = framework.affects && typeof framework.affects === 'object'
        ? Object.entries(framework.affects).filter(([, v]) => typeof v === 'number' && v > 0)
        : [];

    const meta = [
        checks !== null ? t('compliance.fw_meta_checks', '{n} checks', { n: checks }) : null,
        registers !== null && registers > 0 ? t('compliance.fw_meta_registers', '{n} registers', { n: registers }) : null,
        dates !== null && dates > 0 ? t('compliance.fw_meta_dates', '{n} calendar dates', { n: dates }) : null,
    ].filter(Boolean).join(' · ');

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
                        ? t('compliance.fw_enabled_checks', 'Enabled · {n} checks', { n: checks })
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
            className={`rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-3.5 py-3 flex flex-col gap-1.5 text-xs ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId || `fw-card-${framework.id}`}
            data-framework={framework.id}
            data-locked={framework.locked || undefined}
            aria-busy={busy || undefined}
        >
            <div className="flex items-center gap-2 min-w-0">
                <Icon size={14} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                <span className="font-semibold truncate">{t(framework.name_key, framework.name || framework.id)}</span>
                <StatusChip chip={chip} t={t} locale={resolvedLocale} />
            </div>
            {framework.description_key && (
                <div className="text-[var(--text-secondary)] leading-4">{t(framework.description_key, '')}</div>
            )}
            {framework.affects_key && (
                <div className="text-[11px] text-[var(--text-tertiary)] leading-4">
                    <b className="text-[var(--text-secondary)] font-semibold">{t('compliance.fw_affects_label', 'Affects you:')}</b>{' '}
                    {t(framework.affects_key, '')}
                    {affects.length > 0 && (
                        <span data-testid="fw-affects-counts">{' · '}{affects.map(([k, v]) => `${v} ${t(`compliance.fw_affects_${k}`, k)}`).join(' · ')}</span>
                    )}
                </div>
            )}
            <div className="flex items-center gap-2 mt-auto pt-1">{footer}</div>
        </article>
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
