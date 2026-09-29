/**
 * AiActLadderModal — "Does the AI Act apply here?", the three-step ladder per
 * automation or agent (Compliance Center redesign, Sep 2026; artboard frame
 * 1f). Art. 5 → Art. 50 → Annex III, in that order: the answers to 1 and 3
 * are a human's declaration (negation chips), step 2 is what the checks see
 * in the signals (disclosure shown, marking enabled) and is never answered by
 * hand.
 *
 * Mounted OUTSIDE the hub (routine builder Settings tab, agent wizard
 * Advanced drawer, and FE-7's per-automation table), so it carries its own
 * data hook (`useAiActAssessment`) and reads through data/api.js directly.
 * Two ways to mount it:
 *   <AiActLadderModal open kind target data={hookResult} onClose />   — the block passes its hook
 *   <AiActLadderModal open kind target onClose />                     — standalone; the modal owns the hook
 *
 * Colours: the kind tile in --kind-compliance, the AI sparkle in --type-ai,
 * verdicts through statusTone TONES (raw for hairlines/discs, ink for text).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, PenLine, Sparkles, Wrench, MessageSquare, FileText } from 'lucide-react';
import Modal from '../../../shared/Modal';
import toast from '../../../shared/Toast';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { TONES } from '../../../shared/statusTone';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatCalDate } from '../shared/calendarMath';
import useAiActAssessment from './useAiActAssessment';
import {
    outcome as computeOutcome,
    inputFromSignals,
    toAnswers,
    daysUntilMarkingDeadline,
    annexAnswerFromDomains,
    annexArticlesFor,
    annexAnsweredCount,
    ART5_PRACTICES,
    ANNEX_III_CATEGORIES,
    ANNEX_III_ARTICLES,
    MARKING_DEADLINE,
    ART5_IN_FORCE,
    ART50_IN_FORCE,
    ANNEX_III_FROM,
} from './ladderOutcome';

/**
 * Art. 5 — all EIGHT prohibited practices, in the server's vocabulary
 * (ladderOutcome.ART5_PRACTICES). Three of them were on screen before, under
 * ids the server did not use, and denying those three recorded "not a
 * prohibited practice" for a system nobody had asked about subliminal
 * manipulation, exploiting vulnerabilities, criminal risk profiling, facial
 * scraping or real-time biometric identification.
 */
const ART5_CHIPS = Object.freeze([
    { id: 'subliminal_manipulation', key: 'compliance.ladder_art5_chip_subliminal', en: 'no subliminal manipulation' },
    { id: 'exploiting_vulnerabilities', key: 'compliance.ladder_art5_chip_vulnerabilities', en: 'no exploiting vulnerabilities' },
    { id: 'social_scoring', key: 'compliance.ladder_art5_chip_social', en: 'no social scoring' },
    { id: 'criminal_risk_profiling', key: 'compliance.ladder_art5_chip_criminal', en: 'no criminal risk profiling' },
    { id: 'facial_scraping', key: 'compliance.ladder_art5_chip_scraping', en: 'no untargeted facial scraping' },
    { id: 'emotion_recognition_work_education', key: 'compliance.ladder_art5_chip_emotion', en: 'no emotion recognition at work or school' },
    { id: 'biometric_categorisation', key: 'compliance.ladder_art5_chip_biometric', en: 'no biometric categorisation' },
    { id: 'realtime_biometric_id', key: 'compliance.ladder_art5_chip_realtime_id', en: 'no real-time biometric identification' },
]);

/**
 * Annex III — one QUESTION per domain, all ten, each naming the point of the
 * annex that settles it.
 *
 * It was four negation chips that had to be ticked together to mean "no". Two
 * things were wrong with that and both mattered:
 *
 *   - six domains were never on screen, so the declaration it recorded was
 *     about things nobody had been asked;
 *   - there was no way to answer YES. A genuinely high-risk system could not
 *     be recorded as one through the ladder at all.
 *
 * So each domain is its own question with its own Yes/No, `null` until
 * answered, and the answer cites `ANNEX_III_ARTICLES[id]` — the reader can
 * look the qualification up instead of taking ours.
 */
const ANNEX_QUESTIONS = Object.freeze([
    { id: 'biometrics', key: 'compliance.ladder_annex_q_biometrics', en: 'Does it identify or categorise people by biometrics?' },
    { id: 'critical_infrastructure', key: 'compliance.ladder_annex_q_critical_infrastructure', en: 'Does it help run critical infrastructure (water, power, traffic)?' },
    { id: 'education', key: 'compliance.ladder_annex_q_education', en: 'Does it decide on admission, assessment or monitoring in education?' },
    { id: 'employment', key: 'compliance.ladder_annex_q_employment', en: 'Does it select, assess or decide about people at work?' },
    { id: 'essential_services', key: 'compliance.ladder_annex_q_essential_services', en: 'Does it decide on access to essential public services or benefits?' },
    { id: 'credit', key: 'compliance.ladder_annex_q_credit', en: 'Does it judge creditworthiness or score credit?' },
    { id: 'insurance', key: 'compliance.ladder_annex_q_insurance', en: 'Does it price or assess risk for life or health insurance?' },
    { id: 'law_enforcement', key: 'compliance.ladder_annex_q_law_enforcement', en: 'Is it used by or for law enforcement?' },
    { id: 'migration', key: 'compliance.ladder_annex_q_migration', en: 'Is it used for migration, asylum or border control?' },
    { id: 'justice', key: 'compliance.ladder_annex_q_justice', en: 'Does it support judicial decisions or democratic processes?' },
]);

const tint = (raw, pct = 14) => `color-mix(in srgb, ${raw} ${pct}%, transparent)`;

export default function AiActLadderModal(props) {
    if (props.data) return <LadderModalView {...props} />;
    return <StandaloneLadder {...props} />;
}

function StandaloneLadder(props) {
    const data = useAiActAssessment(props.kind, props.target, { enabled: props.open !== false });
    return <LadderModalView {...props} data={data} />;
}

export function LadderModalView({ open, onClose, kind = 'automation', target, data, onRecorded, now, zIndex }) {
    const { t, resolvedLocale } = useTranslation();
    const locale = resolvedLocale || 'en';
    const signals = data?.signals || null;
    const saved = data?.assessment || null;
    const rootRef = useRef(null);

    // The shared Modal paints its overlay at z-50; the agent wizard's Advanced
    // drawer sits at z-[1100], so from there the ladder would open BEHIND the
    // drawer. Until Modal grows an overlay z-index prop (asked in the DONE
    // file) the caller passes `zIndex` and we lift the portal's overlay node.
    useEffect(() => {
        if (!open || !zIndex) return;
        const overlay = rootRef.current?.closest('[role="presentation"]');
        if (overlay) overlay.style.zIndex = String(zIndex);
    }, [open, zIndex]);

    // Pre-tick from the saved declaration so re-assessing starts from what was
    // declared, not from zero. A row saved before the ten questions existed
    // carries only `answer`, so a stored 'no' still fills the chips in.
    const [art5Denied, setArt5Denied] = useState(() => new Set());
    const [annexAnswers, setAnnexAnswers] = useState(() => ({}));
    const [busy, setBusy] = useState(null); // 'record' | 'marking' | null
    const [actionError, setActionError] = useState(null);

    useEffect(() => {
        if (!open) return;
        const a = saved?.answers || {};
        setArt5Denied(a.art5?.answer === 'no' ? new Set(ART5_PRACTICES) : new Set());
        const stored = a.annex_iii?.domains;
        if (stored && typeof stored === 'object' && ANNEX_III_CATEGORIES.some(id => stored[id] === 'yes' || stored[id] === 'no')) {
            setAnnexAnswers(Object.fromEntries(
                ANNEX_III_CATEGORIES.filter(id => stored[id] === 'yes' || stored[id] === 'no').map(id => [id, stored[id]]),
            ));
        } else if (a.annex_iii?.answer === 'no' || a.annex_iii?.answer === 'yes') {
            // Pre-ten-question row: one answer that covered all of them.
            setAnnexAnswers(Object.fromEntries(ANNEX_III_CATEGORIES.map(id => [id, a.annex_iii.answer])));
        } else {
            setAnnexAnswers({});
        }
        setActionError(null);
    }, [open, saved]);

    const art5 = useMemo(() => ({
        answer: art5Denied.size === ART5_PRACTICES.length ? 'no' : null,
        practices: [],
    }), [art5Denied]);
    const annexIii = useMemo(() => ({
        answer: annexAnswerFromDomains(annexAnswers),
        category: null,
        domains: annexAnswers,
    }), [annexAnswers]);
    const annexAnswered = annexAnsweredCount(annexAnswers);
    const annexArticles = annexArticlesFor(annexAnswers);

    // Which domains the routine's own wording touches. An ORDERING signal and
    // a marker beside the question — never a pre-filled answer. The server
    // sends all ten in `annex_iii_questions`, hinted ones first; a hint is the
    // same thing the keyword regex used to be, with the authority taken away.
    const annexHints = useMemo(() => new Set(
        (Array.isArray(signals?.annex_iii_questions) ? signals.annex_iii_questions : [])
            .filter(q => q && q.hint && q.id).map(q => q.id),
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
    const aiSteps = Array.isArray(signals?.steps?.ai) ? signals.steps.ai : [];
    const stepCount = typeof signals?.step_count === 'number' ? signals.step_count : null;
    const name = target?.name || target?.title || '';
    const surface = surfaceLabel(signals, t);

    const canRecord = !!data?.save && !busy && (
        !containsAi || (verdict.step1.answered && verdict.step3.answered)
    );

    const toggle = (setter) => (id) => setter(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    // Pressing the answer you already gave takes it back to unanswered. There
    // has to be a way out of an answer you did not mean: this is a legal
    // declaration, and a control you cannot undo is one people stop using.
    const answerAnnex = useCallback((id, value) => setAnnexAnswers(prev => {
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

    const subtitleParts = [name];
    if (stepCount !== null) subtitleParts.push(t('compliance.ladder_sub_steps', '{n} steps', { n: stepCount }));
    if (signals) subtitleParts.push(t('compliance.ladder_sub_ai_steps', '{n} AI steps', { n: aiSteps.length }));
    if (surface) subtitleParts.push(t('compliance.ladder_sub_surface', 'customer-facing via {surface}', { surface }));
    const subtitle = subtitleParts.filter(Boolean).join(' · ');

    const footer = (
        <div className="flex flex-col gap-2 w-full">
            {actionError && (
                <div data-testid="ladder-action-error" className="text-xs" style={{ color: TONES.error.ink }}>
                    {t('compliance.ladder_action_failed', 'That did not save — {error}', { error: String(actionError.message || actionError) })}
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
        <Modal open={!!open} onClose={onClose} title={title} description={subtitle || undefined} footer={footer} size="xl" className="max-w-[760px]!">
            <div ref={rootRef} data-testid="ai-act-ladder" className="flex flex-col gap-4">
                {data?.error && (
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

function surfaceLabel(signals, t) {
    const s = signals?.surface;
    if (!s) return null;
    if (s === 'form') return t('compliance.ladder_surface_form', 'a form');
    if (s === 'published_agent') return t('compliance.ladder_surface_agent', 'a published agent');
    if (s === 'webpage') return t('compliance.ladder_surface_webpage', 'a web page');
    return String(s);
}

function step2State(step2) {
    if (step2.failures.length) return 'failing';
    if (step2.checks > 0 && step2.passed === step2.checks) return 'done';
    return 'open';
}

const DISC = Object.freeze({
    done: { background: tint(TONES.success.raw), color: TONES.success.ink, border: `1px solid ${TONES.success.raw}` },
    failing: { background: tint(TONES.error.raw), color: TONES.error.ink, border: `1px solid ${TONES.error.raw}` },
    open: { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' },
});

function Step({ n, state, title, meta, verdict, children, testId }) {
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
 * A `hint` puts the question at the top and says the routine's own wording
 * mentions it. It never presses a button. Same rule the RoPA follows for the
 * lawful basis: a pre-selected legal position is the product taking one.
 */
function AnnexQuestions({ questions, answers, hints, onAnswer, t }) {
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
                                    <span data-testid="ladder-annex-hint" className="ml-1.5" style={{ color: 'var(--text-secondary)' }}>
                                        · {t('compliance.ladder_annex_mentioned', 'this routine’s wording mentions it')}
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

function ChipRow({ chips, denied, onToggle, t, testId }) {
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

function ContainsAiBanner({ containsAi, aiSteps, signals, t }) {
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

function toneStyle(tone) {
    if (tone === 'success') return { borderColor: TONES.success.raw };
    if (tone === 'error') return { borderColor: TONES.error.raw, background: tint(TONES.error.raw, 6) };
    return { borderColor: 'var(--border-default)' };
}

function SubCard({ icon: Icon, tone, title, detail, children, testId }) {
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

function DisclosureCard({ signals, t }) {
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

function MarkingCard({ signals, t, locale, now, busy, onEnable }) {
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

export function outcomeText(verdict, containsAi, t) {
    if (containsAi && !(verdict.step1.answered && verdict.step3.answered)) {
        return t('compliance.ladder_outcome_pending', 'Outcome: pending — tick the chips of steps 1 and 3 to declare.');
    }
    switch (verdict.outcomeCode) {
        case 'not_applicable':
            return t('compliance.ladder_outcome_not_applicable', 'Outcome: the AI Act does not apply — no step calls a model. Only the GDPR applies.');
        case 'prohibited':
            return t('compliance.ladder_outcome_prohibited', 'Outcome: prohibited practice (Art. 5) — this may not run.');
        case 'high_risk':
            return t('compliance.ladder_outcome_high_risk', 'Outcome: the AI Act applies — high-risk (Annex III). Risk management, technical documentation and human oversight are required.');
        case 'transparency':
            return t('compliance.ladder_outcome_transparency', 'Outcome: the AI Act applies — Art. 4 (literacy) and Art. 50 (transparency). Not high-risk.');
        default:
            return t('compliance.ladder_outcome_minimal', 'Outcome: the AI Act applies — Art. 4 (literacy). Minimal risk: no customer contact, no generated content.');
    }
}

function OutcomeBox({ verdict, containsAi, t }) {
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
                {t('compliance.ladder_outcome_note', 'Recorded in the model inventory (Art. 53) and as a processing activity in the processing register; the "AI notice" and "marking" checks keep running automatically.')}
            </div>
        </div>
    );
}
