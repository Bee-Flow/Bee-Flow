import React, { useMemo } from 'react';
import { Bot } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES, toneOfScore } from '../../../../shared/statusTone';
import StatusPill from '../../shared/StatusPill';
import TimelinePhases from '../../shared/TimelinePhases';
import { daysUntil, parseDay, SOON_DAYS } from '../../shared/calendarMath';

/**
 * AiActPhasesCard — "AI Act — phasing" (artboard frame 1e, top-left card).
 *
 * Phases come from the AIA catalogue entry (`framework.phases = [{ date, label_key }]`,
 * `GET /frameworks` / `GET /registry`), falling back to the calendar's AIA
 * milestones. The state of each phase is derived HERE by date — TimelinePhases
 * only draws the caller's word — with one exception the design pins: the Art. 50
 * phase is `missed` (red X) when the AIA disclosure check fails today.
 */

const ART50_RE = /(^|_)art50($|_)/i;

/** Is this phase the Art. 50 transparency step? (label_key slug or explicit article) */
export function isArt50Phase(phase) {
    if (!phase) return false;
    if (String(phase.article ?? '').startsWith('50')) return true;
    return ART50_RE.test(String(phase.label_key ?? phase.key ?? phase.id ?? ''));
}

/** Does any AIA Art. 50 check fail in the latest check rows? */
export function disclosureFails(checks) {
    if (!Array.isArray(checks)) return false;
    return checks.some(c => c && c.status === 'fail'
        && String(c.regulation ?? '').toUpperCase() === 'AIA'
        && String(c.article ?? '').startsWith('50'));
}

/**
 * Pure: catalogue phases → TimelinePhases items with state done|missed|upcoming|future.
 * `upcoming` = within SOON_DAYS (carries `daysLeft`), `future` beyond; past = done, or
 * missed for the Art. 50 phase while the disclosure check fails.
 */
export function phaseStates(phases, { now = Date.now(), art50Missed = false, t = (k, f) => f ?? k } = {}) {
    if (!Array.isArray(phases)) return [];
    return phases
        .filter(p => p && parseDay(p.date) !== null)
        .map(p => {
            const days = daysUntil(p.date, now);
            let state;
            if (days < 0) state = art50Missed && isArt50Phase(p) ? 'missed' : 'done';
            else if (days <= SOON_DAYS) state = 'upcoming';
            else state = 'future';
            const title = p.title ?? (p.label_key ? t(p.label_key, p.label ?? '') : (p.label ?? ''));
            return { date: p.date, title, subtitle: p.subtitle, state, daysLeft: state === 'upcoming' ? days : undefined, key: p.label_key ?? p.id ?? p.date };
        })
        .sort((a, b) => parseDay(a.date) - parseDay(b.date));
}

/** Calendar milestones of the AI Act as a phases fallback when the catalogue row carries none. */
export function phasesFromMilestones(milestones) {
    if (!Array.isArray(milestones)) return [];
    return milestones
        .filter(m => m && m.framework_id === 'aia' && m.kind !== 'uncertain' && m.date)
        .map(m => ({ date: m.date, label_key: m.label_key, label: m.label, id: m.id }));
}

export default function AiActPhasesCard({ framework, milestones, checks, score, now, className = '', testId = 'aia-phases-card' }) {
    const { t } = useTranslation();
    const nowMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.now());
    const art50Missed = disclosureFails(checks);
    const phases = useMemo(() => {
        const source = Array.isArray(framework?.phases) && framework.phases.length ? framework.phases : phasesFromMilestones(milestones);
        return phaseStates(source, { now: nowMs, art50Missed, t });
    }, [framework, milestones, nowMs, art50Missed, t]);

    const scoreValue = typeof score === 'number' ? score
        : (typeof framework?.score?.score === 'number' ? framework.score.score
            : (typeof framework?.score === 'number' ? framework.score : null));
    const tone = toneOfScore(scoreValue);

    return (
        <section
            className={`rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-4 py-3.5 flex flex-col gap-2.5 ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
            aria-label={t('compliance.fw_aia_phasing', 'AI Act — phasing')}
        >
            <div className="flex items-center gap-2 min-w-0">
                <Bot size={15} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                <span className="font-semibold text-xs">{t('compliance.fw_aia_phasing', 'AI Act — phasing')}</span>
                <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                    {t('compliance.fw_aia_omnibus_note', 'Regulation (EU) 2024/1689 · Omnibus: Art. 4 "support" instead of "ensure", Annex III moved to Dec 2027')}
                </span>
                {scoreValue !== null && (
                    <StatusPill
                        tone={tone}
                        className="ml-auto"
                        testId={`${testId}-score`}
                        icon={<span className="w-2 h-2 rounded-full inline-block" style={{ background: TONES[tone]?.raw || 'var(--border-default)' }} aria-hidden="true" />}
                        title={t('compliance.score_aria', '{score} of 100', { score: Math.round(scoreValue) })}
                    >
                        {Math.round(scoreValue)}
                    </StatusPill>
                )}
            </div>
            {phases.length > 0 ? (
                <TimelinePhases phases={phases} now={nowMs} className="mt-1.5" testId={`${testId}-timeline`} />
            ) : (
                <div className="text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-empty`}>
                    {t('compliance.fw_aia_phases_unavailable', 'The AI Act phases could not be read.')}
                </div>
            )}
        </section>
    );
}
