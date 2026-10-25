import { Wrench, MessageSquare, FileText } from 'lucide-react';
import React from 'react';
import { daysUntilMarkingDeadline, MARKING_DEADLINE, ART50_IN_FORCE } from '../ladderOutcome';
import { type TranslateParams } from '../../../../../hooks/useTranslation';
import { TONES } from '../../../../shared/statusTone';
import { formatCalDate } from '../../shared/calendarMath';
import type { LadderAssessment, LadderSignals } from '../useAiActAssessment';
import type { StepProps, SubCardProps, DisclosureCardProps, MarkingCardProps } from '../AiActLadderModal.types';

export const tint = (raw: string, pct: number = 14) => `color-mix(in srgb, ${raw} ${pct}%, transparent)`;

export function LadderModalViewStep2({ verdict, t, locale, signals, now, busy, data, enableMarking }: { verdict: { applies: boolean; articles: string[]; prohibited: boolean; highRisk: boolean; step1: { answered: boolean; ok: boolean; }; step2: { ok: boolean; failures: ("disclosure" | "marking")[]; checks: number; passed: number; }; step3: { answered: boolean; ok: boolean; }; outcomeCode: string; }; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; locale: string; signals: LadderSignals | null; now: string | number | Date | undefined; busy: string | null; data: Partial<{ loading: boolean; error: Error | null; absent: boolean; assessment: LadderAssessment | null; signals: LadderSignals | null; signalsSource: string | null; reload: () => Promise<void>; refetchSignals: () => Promise<LadderSignals | null>; save: (answers: { art5: { answer: string | null; practices: string[]; }; art50: { interacts: boolean | null; disclosure: boolean | null; generates: boolean | null; marking: boolean | null; }; annex_iii: { answer: string | null; category: string | null; domains: { [x: string]: string | null | undefined; }; }; }) => Promise<LadderAssessment | null>; enableMarking: () => Promise<void>; }> | null | undefined; enableMarking: () => Promise<void>; }) {
    return <Step
        n={2}
        state={step2State(verdict.step2)}
        title={t('compliance.ladder_step2_title', 'Art. 50 — transparency')}
        meta={t('compliance.ladder_step2_meta', 'in force since {date} — this is what is missed most', { date: formatCalDate(ART50_IN_FORCE, { locale }) })}
        verdict={verdict.step2.checks > 0 && verdict.step2.passed + verdict.step2.failures.length === verdict.step2.checks
            // Only when every applicable sub-card is KNOWN — an unknown count renders nothing, never "0 of 2".
            ? t('compliance.ladder_step2_score', '{passed} of {checks} in order', { passed: verdict.step2.passed, checks: verdict.step2.checks })
            : null}
        testId="ladder-step-2"
    >
        <div className="grid gap-2 sm:grid-cols-2">
            <DisclosureCard signals={signals} t={t} />
            <MarkingCard signals={signals} t={t} locale={locale} now={now} busy={busy === 'marking'} onEnable={data?.enableMarking ? enableMarking : null} />
        </div>
    </Step>;
}

function step2State(step2: { ok: boolean; failures: string[]; checks: number; passed: number; }) {
    if (step2.failures.length) return 'failing';
    if (step2.checks > 0 && step2.passed === step2.checks) return 'done';
    return 'open';
}

const DISC: Readonly<Record<string, React.CSSProperties>> = Object.freeze({
    done: { background: tint(TONES.success.raw), color: TONES.success.ink, border: `1px solid ${TONES.success.raw}` },
    failing: { background: tint(TONES.error.raw), color: TONES.error.ink, border: `1px solid ${TONES.error.raw}` },
    open: { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' },
});

export function Step({ n, state, title, meta, verdict, children, testId }: StepProps) {
    return (
        <section data-testid={testId} data-state={state} className="flex gap-3">
            <span
                data-testid={`${testId}-disc`}
                className="inline-flex items-center justify-center shrink-0 rounded-full text-[12px] font-semibold"
                style={{ width: 26, height: 26, ...DISC[state] }}
                aria-hidden="true"
            >
                {n}
            </span>
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</div>
                        {meta && <div className="text-[11px] text-[var(--text-tertiary)]">{meta}</div>}
                    </div>
                    {verdict && (
                        <span
                            data-testid={`${testId}-verdict`}
                            className="text-[12px] font-semibold"
                            style={{ color: state === 'failing' ? TONES.error.ink : state === 'done' ? TONES.success.ink : 'var(--text-secondary)' }}
                        >
                            {verdict}
                        </span>
                    )}
                </div>
                <div className="mt-2">{children}</div>
            </div>
        </section>
    );
}

function toneStyle(tone: string) {
    if (tone === 'success') return { borderColor: TONES.success.raw };
    if (tone === 'error') return { borderColor: TONES.error.raw, background: tint(TONES.error.raw, 6) };
    return { borderColor: 'var(--border-default)' };
}

function SubCard({ icon: Icon, tone, title, detail, children, testId }: SubCardProps) {
    const inkColor = tone === 'success' ? TONES.success.ink : tone === 'error' ? TONES.error.ink : 'var(--text-secondary)';
    return (
        <div data-testid={testId} data-tone={tone} className="rounded-lg border px-3 py-2.5 flex flex-col gap-1.5" style={toneStyle(tone)}>
            <div className="flex items-center gap-2 text-[12px] font-semibold" style={{ color: inkColor }}>
                <Icon size={13} aria-hidden="true" />
                <span>{title}</span>
            </div>
            {detail && <div className="text-[11px] text-[var(--text-secondary)]">{detail}</div>}
            {children}
        </div>
    );
}

function DisclosureCard({ signals, t }: DisclosureCardProps) {
    const talks = signals?.customer_facing;
    const disclosed = signals?.disclosure_present;
    if (talks !== true) {
        return (
            <SubCard icon={MessageSquare} tone="neutral" testId="ladder-card-disclosure"
                title={t('compliance.ladder_talks_no', 'Talks to people: no')}
                detail={t('compliance.ladder_talks_no_detail', 'No form page, form trigger or published surface — no AI notice needed.')} />
        );
    }
    if (disclosed === true) {
        return (
            <SubCard icon={MessageSquare} tone="success" testId="ladder-card-disclosure"
                title={t('compliance.ladder_talks_yes_ok', 'Talks to people: yes → AI notice shown')}
                detail={t('compliance.ladder_talks_yes_ok_detail', 'The public page says it was made with AI · checked automatically')} />
        );
    }
    if (disclosed === false) {
        return (
            <SubCard icon={MessageSquare} tone="error" testId="ladder-card-disclosure"
                title={t('compliance.ladder_talks_yes_missing', 'Talks to people: yes → AI notice missing')}
                detail={t('compliance.ladder_talks_yes_missing_detail', 'Add a line such as "calculated with AI" to the ending page or the greeting; the check picks it up automatically.')} />
        );
    }
    return (
        <SubCard icon={MessageSquare} tone="neutral" testId="ladder-card-disclosure"
            title={t('compliance.ladder_talks_yes_unknown', 'Talks to people: yes → AI notice')}
            detail={t('compliance.ladder_talks_yes_unknown_detail', 'Whether the notice is shown is checked automatically once the assessment is recorded.')} />
    );
}

function MarkingCard({ signals, t, locale, now, busy, onEnable }: MarkingCardProps) {
    const generates = signals?.generates_content;
    const marking = signals?.marking_enabled;
    const days = daysUntilMarkingDeadline(now ? new Date(now) : new Date());
    const deadline = formatCalDate(MARKING_DEADLINE, { locale });
    const deadlineLine = days >= 0
        ? t('compliance.ladder_marking_deadline', 'mandatory for existing systems from {date} (in {days} days)', { date: deadline, days })
        : t('compliance.ladder_marking_deadline_passed', 'mandatory for existing systems since {date}', { date: deadline });

    if (generates !== true) {
        return (
            <SubCard icon={FileText} tone="neutral" testId="ladder-card-marking"
                title={t('compliance.ladder_generates_no', 'Generates content: no')}
                detail={t('compliance.ladder_generates_no_detail', 'No document step writes model output to a file — no marking needed.')} />
        );
    }
    if (marking === true) {
        return (
            <SubCard icon={FileText} tone="success" testId="ladder-card-marking"
                title={t('compliance.ladder_generates_yes_ok', 'Generates content: yes → marking on')}
                detail={t('compliance.ladder_generates_yes_ok_detail', 'Generated documents carry the AI marking footer · checked automatically')} />
        );
    }
    const tone = marking === false ? 'error' : 'neutral';
    return (
        <SubCard icon={FileText} tone={tone} testId="ladder-card-marking"
            title={marking === false
                ? t('compliance.ladder_generates_yes_missing', 'Generates content: yes → marking missing')
                : t('compliance.ladder_generates_yes_unknown', 'Generates content: yes → marking')}
            detail={`${t('compliance.ladder_marking_detail', 'AI text in a generated document without a marking')} · ${deadlineLine}`}
        >
            {onEnable && (
                <button
                    type="button"
                    data-testid="ladder-enable-marking"
                    onClick={onEnable}
                    disabled={busy}
                    className="self-start inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 transition"
                >
                    <Wrench size={12} aria-hidden="true" />
                    {t('compliance.ladder_enable_marking', 'Enable marking')}
                </button>
            )}
        </SubCard>
    );
}
