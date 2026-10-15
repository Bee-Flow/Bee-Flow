/**
 * AiActLadderModal — "Does the AI Act apply here?", the three-step ladder per
 * automation or agent (Compliance Center redesign, Sep 2026; artboard frame
 * 1f). Art. 5 → Art. 50 → Annex III, in that order: the answers to 1 and 3
 * are a human's declaration (negation chips), step 2 is what the checks see
 * in the signals (disclosure shown, marking enabled) and is never answered by
 * hand.
 *
 * Mounted OUTSIDE the hub (automation builder Settings tab, agent wizard
 * Advanced drawer, and FE-7's per-automation table), so it carries its own
 * data hook (`useAiActAssessment`) and reads through data/api.js directly.
 * Two ways to mount it:
 *   <AiActLadderModal open kind target data={hookResult} onClose />   — the block passes its hook
 *   <AiActLadderModal open kind target onClose />                     — standalone; the modal owns the hook
 *
 * Colours: the kind tile in --kind-compliance, the AI sparkle in --type-ai,
 * verdicts through statusTone TONES (raw for hairlines/discs, ink for text).
 */
import { Bot, Check, PenLine, Sparkles, Wrench, MessageSquare, FileText, type LucideIcon } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
    outcome as computeOutcome,
    inputFromSignals,
    toAnswers,
    daysUntilMarkingDeadline,
    annexAnswerFromDomains,
    annexArticlesFor,
    annexAnsweredCount,
    legacyAnnexAnswers,
    ART5_PRACTICES,
    ANNEX_III_CATEGORIES,
    ANNEX_III_ARTICLES,
    MARKING_DEADLINE,
    ART5_IN_FORCE,
    ART50_IN_FORCE,
    ANNEX_III_FROM,
    type AnnexIiiAnswer,
    type Outcome,
    type YesNo,
} from './ladderOutcome';
import useAiActAssessment, { type AiActAssessment, type AssessmentTarget, type SignalsView, type AnnexHint } from './useAiActAssessment';
import type { StepRef } from './aiSignals';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { TONES } from '../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import toast from '../../../shared/Toast';
import { formatCalDate } from '../shared/calendarMath';
import {
    AnnexQuestions, ChipRow, ContainsAiBanner, DisclosureCard, MarkingCard, OutcomeBox, Step, step2State, surfaceLabel, tint,
} from './AiActLadderParts';
import { ANNEX_QUESTIONS, ART5_CHIPS, type LadderChip } from './ladderChips';

/** The hook's result, as the modal reads it. */
export type LadderData = ReturnType<typeof useAiActAssessment>;


/** The answers a saved row keeps (`answers` of GET /ai-act/assessments/:kind/:id). */
interface SavedAnswers {
    art5?: { answer?: YesNo };
    annex_iii?: { answer?: YesNo; category?: string | null; domains?: Record<string, unknown> };
}



/** The Art. 5 answer the modal keeps: a yes/no, or null while open. */
type Art5Input = { answer: YesNo; practices: string[] };

export interface LadderModalProps {
    open?: boolean;
    onClose?: () => void;
    kind?: string;
    target?: AssessmentTarget | null;
    /** The block's hook result; absent when the modal mounts standalone. */
    data?: LadderData | null;
    onRecorded?: (row: AiActAssessment | null) => void;
    now?: Date | number;
    zIndex?: number;
}

export default function AiActLadderModal(props: LadderModalProps) {
    if (props.data) return <LadderModalView {...props} data={props.data} />;
    return <StandaloneLadder {...props} />;
}

function StandaloneLadder(props: LadderModalProps) {
    const data = useAiActAssessment(props.kind as string, props.target, { enabled: props.open !== false });
    return <LadderModalView {...props} data={data} />;
}

export function LadderModalView({ open, onClose, kind = 'automation', target, data, onRecorded, now, zIndex }: LadderModalProps & { data: LadderData | null }) {
    const { t, resolvedLocale } = useTranslation();
    const locale = resolvedLocale || 'en';
    const signals: SignalsView | null = data?.signals || null;
    const saved: AiActAssessment | null = data?.assessment || null;
    const rootRef = useRef<HTMLDivElement>(null);

    // The shared Modal paints its overlay at z-50; the agent wizard's Advanced
    // drawer sits at z-[1100], so from there the ladder would open BEHIND the
    // drawer. Until Modal grows an overlay z-index prop (asked in the DONE
    // file) the caller passes `zIndex` and we lift the portal's overlay node.
    useEffect(() => {
        if (!open || !zIndex) return;
        const overlay = rootRef.current?.closest<HTMLElement>('[role="presentation"]');
        if (overlay) overlay.style.zIndex = String(zIndex);
    }, [open, zIndex]);

    // Pre-tick from the saved declaration so re-assessing starts from what was
    // declared, not from zero. A row saved before the ten questions existed
    // carries only `answer` (legacyAnnexAnswers): a stored 'no' still fills
    // the chips in; a stored 'yes' names at most one area.
    const [art5Denied, setArt5Denied] = useState<Set<string>>(() => new Set());
    const [annexAnswers, setAnnexAnswers] = useState<Record<string, string>>({});
    const [legacyYes, setLegacyYes] = useState(false);
    const [busy, setBusy] = useState<'record' | 'marking' | null>(null);
    const [actionError, setActionError] = useState<unknown>(null);

    useEffect(() => {
        if (!open) return;
        const a = (saved?.answers || {}) as SavedAnswers;
        setArt5Denied(a.art5?.answer === 'no' ? new Set(ART5_PRACTICES) : new Set());
        const stored = a.annex_iii?.domains;
        if (stored && typeof stored === 'object' && ANNEX_III_CATEGORIES.some(id => stored[id] === 'yes' || stored[id] === 'no')) {
            setAnnexAnswers(Object.fromEntries(
                ANNEX_III_CATEGORIES.filter(id => stored[id] === 'yes' || stored[id] === 'no').map(id => [id, stored[id] as string]),
            ));
            setLegacyYes(false);
        } else {
            setAnnexAnswers(legacyAnnexAnswers(a.annex_iii));
            setLegacyYes(a.annex_iii?.answer === 'yes');
        }
        setActionError(null);
    }, [open, saved]);

    const art5 = useMemo((): Art5Input => ({
        answer: art5Denied.size === ART5_PRACTICES.length ? 'no' : null,
        practices: [],
    }), [art5Denied]);
    const annexIii = useMemo((): AnnexIiiAnswer => ({
        answer: annexAnswerFromDomains(annexAnswers),
        category: null,
        domains: annexAnswers,
    }), [annexAnswers]);
    const annexAnswered = annexAnsweredCount(annexAnswers);
    const annexArticles = annexArticlesFor(annexAnswers);

    // Which domains the automation's own wording touches. An ORDERING signal and
    // a marker beside the question — never a pre-filled answer. The server
    // sends all ten in `annex_iii_questions`, hinted ones first; a hint is the
    // same thing the keyword regex used to be, with the authority taken away.
    const annexHints = useMemo(() => new Set(
        (Array.isArray(signals?.annex_iii_questions) ? signals.annex_iii_questions : [])
            .filter((q: AnnexHint) => q && q.hint && q.id).map((q: AnnexHint) => q.id),
    ), [signals]);
    const annexOrder = useMemo(
        () => [...ANNEX_QUESTIONS].sort((a, b) => (annexHints.has(b.id) ? 1 : 0) - (annexHints.has(a.id) ? 1 : 0)),
        [annexHints],
    );

    const verdict = useMemo(
        () => computeOutcome(inputFromSignals(signals, { art5, annexIii })),
        [signals, art5, annexIii],
    );

    const containsAi = signals?.contains_ai === true;
    const aiSteps: StepRef[] = Array.isArray(signals?.steps?.ai) ? signals.steps.ai : [];
    const stepCount = typeof signals?.step_count === 'number' ? signals.step_count : null;
    const name = String(target?.name || target?.title || '');
    const surface = surfaceLabel(signals, t);

    const canRecord = !!data?.save && !busy && (
        !containsAi || (verdict.step1.answered && verdict.step3.answered)
    );

    const toggle = (setter: Dispatch<SetStateAction<Set<string>>>) => (id: string) => setter(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    // Pressing the answer you already gave takes it back to unanswered. There
    // has to be a way out of an answer you did not mean: this is a legal
    // declaration, and a control you cannot undo is one people stop using.
    const answerAnnex = useCallback((id: string, value: string) => setAnnexAnswers(prev => {
        const next = { ...prev };
        if (next[id] === value) delete next[id]; else next[id] = value;
        return next;
    }), []);

    const record = useCallback(async () => {
        if (!data?.save) return;
        setBusy('record');
        setActionError(null);
        try {
            const row = await data.save(toAnswers({ art5, annexIii, signals }));
            toast.success(t('compliance.ladder_toast_recorded', 'Recorded as self-declared — stamped with who and when, valid for 12 months.'));
            onRecorded?.(row);
            onClose?.();
        } catch (err) {
            setActionError(err);
        } finally {
            setBusy(null);
        }
    }, [data, art5, annexIii, signals, t, onRecorded, onClose]);

    const enableMarking = useCallback(async () => {
        if (!data?.enableMarking) return;
        setBusy('marking');
        setActionError(null);
        try {
            await data.enableMarking();
            toast.success(t('compliance.ladder_toast_marking_on', 'Content marking enabled for this organisation.'));
        } catch (err) {
            setActionError(err);
        } finally {
            setBusy(null);
        }
    }, [data, t]);

    const title = (
        <span className="flex items-center gap-3">
            <span
                data-testid="ladder-kind-tile"
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
                style={{ background: tint('var(--kind-compliance)'), color: 'var(--kind-compliance)' }}
            >
                <Bot size={16} aria-hidden="true" />
            </span>
            <span className="text-[15px] font-semibold text-[var(--text-primary)]">
                {kind === 'agent'
                    ? t('compliance.ladder_title_agent', 'Does the AI Act apply to this agent?')
                    : t('compliance.ladder_title_automation', 'Does the AI Act apply to this automation?')}
            </span>
        </span>
    );

    const subtitleParts: string[] = [name];
    if (stepCount !== null) {
        subtitleParts.push(stepCount === 1
            ? t('compliance.ladder_sub_steps_one', '1 step')
            : t('compliance.ladder_sub_steps', '{n} steps', { n: stepCount }));
    }
    if (signals) {
        subtitleParts.push(aiSteps.length === 1
            ? t('compliance.ladder_sub_ai_steps_one', '1 AI step')
            : t('compliance.ladder_sub_ai_steps', '{n} AI steps', { n: aiSteps.length }));
    }
    if (surface) subtitleParts.push(t('compliance.ladder_sub_surface', 'customer-facing via {surface}', { surface }));
    const subtitle = subtitleParts.filter(Boolean).join(' · ');

    const footer = (
        <div className="flex flex-col gap-2 w-full">
            {Boolean(actionError) && (
                <div data-testid="ladder-action-error" className="text-xs" style={{ color: TONES.error.ink }}>
                    {t('compliance.ladder_action_failed', 'That did not save — {error}', { error: String((actionError as { message?: unknown }).message || actionError) })}
                </div>
            )}
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-lg text-sm border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                >
                    {t('compliance.ladder_later', 'Later')}
                </button>
                <button
                    type="button"
                    data-testid="ladder-record"
                    onClick={record}
                    disabled={!canRecord}
                    style={PRIMARY_ACTION_STYLE}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                    <PenLine size={14} aria-hidden="true" />
                    {t('compliance.ladder_record', 'Record as self-declared')}
                </button>
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)] text-left">
                {t('compliance.ladder_footer_note', 'Also reachable from Studio › Automations › Settings › Compliance and per agent. A declaration is stamped with who and when and expires after 12 months.')}
            </p>
        </div>
    );

    return (
        <Modal open={!!open} onClose={() => onClose?.()} title={title} description={subtitle || undefined} footer={footer} size="xl" className="max-w-[760px]!">
            <div ref={rootRef} data-testid="ai-act-ladder" className="flex flex-col gap-4">
                {Boolean(data?.error) && (
                    <div data-testid="ladder-load-error" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: TONES.error.raw, color: TONES.error.ink }}>
                        {t('compliance.ladder_load_failed', 'The saved assessment could not be read — the signals below come from the definition itself.')}
                    </div>
                )}

                <ContainsAiBanner containsAi={containsAi} aiSteps={aiSteps} signals={signals} t={t} />

                {/* Step 1 — Art. 5 */}
                <Step
                    n={1}
                    state={verdict.step1.ok ? 'done' : 'open'}
                    title={t('compliance.ladder_step1_title', 'Art. 5 — prohibited practice?')}
                    meta={t('compliance.ladder_step1_meta', 'in force since {date} · no delay', { date: formatCalDate(ART5_IN_FORCE, { locale }) })}
                    verdict={verdict.step1.ok ? t('compliance.ladder_no', 'No') : null}
                    testId="ladder-step-1"
                >
                    <ChipRow chips={ART5_CHIPS} denied={art5Denied} onToggle={toggle(setArt5Denied)} t={t} testId="ladder-art5-chip" />
                </Step>

                {/* Step 2 — Art. 50 */}
                <Step
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
                </Step>

                {/* Step 3 — Annex III */}
                <Step
                    n={3}
                    state={verdict.step3.ok ? 'done' : 'open'}
                    title={t('compliance.ladder_step3_title', 'Annex III — high-risk?')}
                    meta={t('compliance.ladder_step3_meta', 'from {date} — but what you build now falls under it then', { date: formatCalDate(ANNEX_III_FROM, { locale }) })}
                    verdict={verdict.step3.answered
                        ? (verdict.step3.ok ? t('compliance.ladder_no', 'No') : t('compliance.ladder_yes', 'Yes'))
                        // An unanswered step says how far along it is rather
                        // than nothing: "4 of 10" is the difference between
                        // "not high risk" and "not asked yet", and conflating
                        // those two is the bug this step was rebuilt for.
                        : t('compliance.ladder_annex_progress', '{answered} of {total} answered', {
                            answered: annexAnswered, total: ANNEX_III_CATEGORIES.length,
                        })}
                    testId="ladder-step-3"
                >
                    {legacyYes && (
                        <p data-testid="ladder-legacy-yes-note" className="text-[11px] mb-2 font-medium text-[var(--warning-ink)]">
                            {t('compliance.ladder_legacy_yes_note', 'Declared high-risk earlier — pick the area(s) to confirm')}
                        </p>
                    )}
                    <AnnexQuestions
                        questions={annexOrder}
                        answers={annexAnswers}
                        hints={annexHints}
                        onAnswer={answerAnnex}
                        t={t}
                    />
                    {annexArticles.length > 0 && (
                        <p data-testid="ladder-annex-articles" className="text-[11px] mt-2 font-medium" style={{ color: TONES.error.ink }}>
                            {t('compliance.ladder_annex_high_risk_points', 'High risk under {points}.', { points: annexArticles.join(', ') })}
                        </p>
                    )}
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-2">
                        {t('compliance.ladder_step3_note', 'If this does become high-risk later: risk management, technical documentation and human oversight are 12–18 months of work, not a quarter.')}
                    </p>
                </Step>

                <OutcomeBox verdict={verdict} containsAi={containsAi} t={t} />

                {saved?.attested_at && (
                    <p data-testid="ladder-saved-stamp" className="text-[11px] text-[var(--text-tertiary)]">
                        {t('compliance.ladder_saved_stamp', 'Last declared {date}, valid until {expires}.', {
                            date: formatCalDate(saved.attested_at, { locale }),
                            expires: saved.expires_at ? formatCalDate(saved.expires_at, { locale }) : '—',
                        })}
                    </p>
                )}
            </div>
        </Modal>
    );
}

/* ----------------------------------------------------------------------- */

