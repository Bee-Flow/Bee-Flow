/**
 * The presentational pieces of the AI Act ladder (steps, chip rows, the annex
 * questions, the disclosure and marking cards, the outcome box), split out of
 * AiActLadderModal.tsx, which keeps the modal shell and the wiring. No state
 * lives here: every piece takes its data and callbacks as props.
 */
import { Check, FileText, MessageSquare, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { daysUntilMarkingDeadline, ANNEX_III_ARTICLES, MARKING_DEADLINE, type Outcome } from './ladderOutcome';
import type { SignalsView } from './useAiActAssessment';
import type { StepRef } from './aiSignals';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { TONES } from '../../../shared/statusTone';
import { formatCalDate } from '../shared/calendarMath';
import type { LadderChip } from './ladderChips';

export const tint = (raw: string, pct = 14): string => `color-mix(in srgb, ${raw} ${pct}%, transparent)`;

export function surfaceLabel(signals: SignalsView | null, t: TranslateFn): string | null {
    const s = signals?.surface;
    if (!s) return null;
    if (s === 'form') return t('compliance.ladder_surface_form', 'a form');
    if (s === 'published_agent') return t('compliance.ladder_surface_agent', 'a published agent');
    if (s === 'webpage') return t('compliance.ladder_surface_webpage', 'a web page');
    return String(s);
}

export function step2State(step2: Outcome['step2']): 'failing' | 'done' | 'open' {
    if (step2.failures.length) return 'failing';
    if (step2.checks > 0 && step2.passed === step2.checks) return 'done';
    return 'open';
}

const DISC: Readonly<Record<'done' | 'failing' | 'open', CSSProperties>> = Object.freeze({
    done: { background: tint(TONES.success.raw), color: TONES.success.ink, border: `1px solid ${TONES.success.raw}` },
    failing: { background: tint(TONES.error.raw), color: TONES.error.ink, border: `1px solid ${TONES.error.raw}` },
    open: { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' },
});

export function Step({ n, state, title, meta, verdict, children, testId }: {
    n: number;
    state: 'done' | 'failing' | 'open';
    title: string;
    meta?: string | null;
    verdict?: string | null;
    children?: ReactNode;
    testId: string;
}) {
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

/**
 * The ten Annex III questions. Each row is one question, its point of the
 * annex, and a Yes/No pair that starts on neither — `null` is a real state
 * here and must stay visible, because "we have not answered this" and "no"
 * are different things to a regulator and the product used to store them the
 * same way.
 *
 * A `hint` puts the question at the top and says the automation's own wording
 * mentions it. It never presses a button. Same rule the RoPA follows for the
 * lawful basis: a pre-selected legal position is the product taking one.
 */
export function AnnexQuestions({ questions, answers, hints, onAnswer, t }: {
    questions: readonly LadderChip[];
    answers: Record<string, string>;
    hints: Set<string>;
    onAnswer: (id: string, value: string) => void;
    t: TranslateFn;
}) {
    return (
        <div className="flex flex-col gap-1" role="group">
            {questions.map((q) => {
                const value = answers[q.id] === 'yes' || answers[q.id] === 'no' ? answers[q.id] : null;
                return (
                    <div
                        key={q.id}
                        data-testid="ladder-annex-question"
                        data-domain={q.id}
                        data-answer={value || 'open'}
                        className="flex items-center justify-between gap-3 py-1"
                    >
                        <div className="min-w-0">
                            <div className="text-[12px] text-[var(--text-secondary)]">{t(q.key, q.en)}</div>
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                {ANNEX_III_ARTICLES[q.id]}
                                {hints.has(q.id) && (
                                    <span data-testid="ladder-annex-hint" className="ml-1.5 text-[var(--text-secondary)]">
                                        · {t('compliance.ladder_annex_mentioned', 'this automation’s wording mentions it')}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                            {['no', 'yes'].map((v) => {
                                const on = value === v;
                                const tone = v === 'yes' ? TONES.error : TONES.success;
                                return (
                                    <button
                                        key={v}
                                        type="button"
                                        data-testid={`ladder-annex-${v}`}
                                        data-domain={q.id}
                                        aria-pressed={on}
                                        onClick={() => onAnswer(q.id, v)}
                                        className="text-[11px] px-2 py-0.5 rounded-full border transition"
                                        style={on
                                            ? { borderColor: tone.raw, background: tint(tone.raw), color: tone.ink }
                                            : { borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                                    >
                                        {v === 'yes' ? t('compliance.ladder_yes', 'Yes') : t('compliance.ladder_no', 'No')}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export function ChipRow({ chips, denied, onToggle, t, testId }: {
    chips: readonly LadderChip[];
    denied: Set<string>;
    onToggle: (id: string) => void;
    t: TranslateFn;
    testId: string;
}) {
    return (
        <div className="flex flex-wrap gap-1.5" role="group">
            {chips.map((c) => {
                const on = denied.has(c.id);
                return (
                    <button
                        key={c.id}
                        type="button"
                        data-testid={testId}
                        data-chip={c.id}
                        aria-pressed={on}
                        onClick={() => onToggle(c.id)}
                        className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border transition"
                        style={on
                            ? { borderColor: 'var(--accent-primary)', background: tint('var(--accent-primary)', 10), color: 'var(--text-primary)' }
                            : { borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                        <span
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border"
                            style={on
                                ? { borderColor: 'var(--accent-primary)', background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }
                                : { borderColor: 'var(--border-default)' }}
                            aria-hidden="true"
                        >
                            {on && <Check size={9} strokeWidth={3} />}
                        </span>
                        {t(c.key, c.en)}
                    </button>
                );
            })}
        </div>
    );
}

export function ContainsAiBanner({ containsAi, aiSteps, signals, t }: {
    containsAi: boolean;
    aiSteps: StepRef[];
    signals: SignalsView | null;
    t: TranslateFn;
}) {
    const names = aiSteps.map(s => s?.label).filter(Boolean);
    return (
        <div
            data-testid="ladder-contains-ai"
            data-contains-ai={signals ? String(containsAi) : 'unknown'}
            className="flex items-start gap-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2.5"
        >
            <Sparkles size={16} aria-hidden="true" className="shrink-0 mt-0.5" style={{ color: 'var(--type-ai)' }} />
            <div className="text-[13px] text-[var(--text-primary)] min-w-0">
                <span className="font-semibold">{t('compliance.ladder_contains_ai', 'Contains AI:')}</span>{' '}
                {!signals && <span className="text-[var(--text-tertiary)]">{t('compliance.ladder_signals_loading', 'reading the definition…')}</span>}
                {signals && containsAi && (
                    <span>
                        {names.length === 1 && t('compliance.ladder_contains_ai_yes_one', 'yes — step "{name}" is an AI step.', { name: names[0] })}
                        {names.length > 1 && t('compliance.ladder_contains_ai_yes_many', 'yes — {names} are AI steps.', { names: names.map(n => `"${n}"`).join(', ') })}
                        {names.length === 0 && t('compliance.ladder_contains_ai_yes', 'yes — this is an AI system.')}
                    </span>
                )}
                {signals && !containsAi && (
                    <span>
                        {t('compliance.ladder_contains_ai_no', 'no — none of the steps calls a model.')}{' '}
                        <span className="text-[var(--text-secondary)]">
                            {t('compliance.ladder_no_ai_note', 'Without AI only the GDPR applies: Art. 22 for decisions with legal effect, WOR Art. 27 for employee monitoring.')}
                        </span>
                    </span>
                )}
            </div>
        </div>
    );
}

function toneStyle(tone: SubCardTone): CSSProperties {
    if (tone === 'success') return { borderColor: TONES.success.raw };
    if (tone === 'error') return { borderColor: TONES.error.raw, background: tint(TONES.error.raw, 6) };
    return { borderColor: 'var(--border-default)' };
}

type SubCardTone = 'neutral' | 'success' | 'error' | 'warning';

function SubCard({ icon: Icon, tone, title, detail, children, testId }: {
    icon: LucideIcon;
    tone: SubCardTone;
    title: string;
    detail?: string | null;
    children?: ReactNode;
    testId: string;
}) {
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

export function DisclosureCard({ signals, t }: { signals: SignalsView | null; t: TranslateFn }) {
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

export function MarkingCard({ signals, t, locale, now, busy, onEnable }: {
    signals: SignalsView | null;
    t: TranslateFn;
    locale: string;
    now?: Date | number;
    busy: boolean;
    onEnable: (() => void) | null;
}) {
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
    const tone: SubCardTone = marking === false ? 'error' : 'neutral';
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

export function outcomeText(verdict: Outcome, containsAi: boolean, t: TranslateFn): string {
    if (containsAi && !(verdict.step1.answered && verdict.step3.answered)) {
        return t('compliance.ladder_outcome_pending', 'Outcome: pending — tick the chips of steps 1 and 3 to declare.');
    }
    switch (verdict.outcomeCode) {
        case 'not_applicable':
            return t('compliance.ladder_outcome_not_applicable', 'Outcome: the AI Act does not apply — no step calls a model. Only the GDPR applies.');
        case 'prohibited':
            return t('compliance.ladder_outcome_prohibited', 'Outcome: prohibited practice (Art. 5) — this may not run.');
        case 'high_risk':
            return t('compliance.ladder_outcome_high_risk', 'Outcome: the AI Act applies — high-risk (Annex III). From 2 Dec 2027 risk management, technical documentation and human oversight are required (provider: Art. 9, 11, 14; deployer: Art. 26).');
        case 'transparency':
            return t('compliance.ladder_outcome_transparency', 'Outcome: the AI Act applies — Art. 4 (literacy) and Art. 50 (transparency). Not high-risk.');
        default:
            return t('compliance.ladder_outcome_minimal', 'Outcome: the AI Act applies — Art. 4 (literacy). Minimal risk: no customer contact, no generated content.');
    }
}

export function OutcomeBox({ verdict, containsAi, t }: { verdict: Outcome; containsAi: boolean; t: TranslateFn }) {
    const pending = containsAi && !(verdict.step1.answered && verdict.step3.answered);
    return (
        <div
            data-testid="ladder-outcome"
            data-outcome={pending ? 'pending' : verdict.outcomeCode}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2.5"
        >
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">{outcomeText(verdict, containsAi, t)}</div>
            {verdict.step2.failures.length > 0 && (
                <div className="text-[11px] mt-1" style={{ color: TONES.error.ink }}>
                    {t('compliance.ladder_outcome_step2_open', 'Art. 50 still open: {items}.', {
                        items: verdict.step2.failures
                            .map(f => (f === 'disclosure' ? t('compliance.ladder_fail_disclosure', 'AI notice') : t('compliance.ladder_fail_marking', 'content marking')))
                            .join(', '),
                    })}
                </div>
            )}
            <div className="text-[11px] text-[var(--text-secondary)] mt-1">
                {t('compliance.ladder_outcome_note', 'Recorded with the model inventory and as a processing activity in the processing register; the "AI notice" and "marking" checks keep running automatically.')}
            </div>
        </div>
    );
}
