import { Bot, Check, PenLine, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { outcome as computeOutcome, inputFromSignals, toAnswers, annexAnswerFromDomains, annexArticlesFor, annexAnsweredCount, legacyAnnexAnswers, ART5_PRACTICES, ANNEX_III_CATEGORIES, ART5_IN_FORCE, type DomainAnswers } from '../ladderOutcome';
import useAiActAssessment from '../useAiActAssessment';
import { useTranslation, type TranslateParams } from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import toast from '../../../../shared/Toast';
import { formatCalDate } from '../../shared/calendarMath';
import type { LadderSignals } from '../useAiActAssessment';
import type { Verdict, Translate, LadderModalViewProps, ChipRowProps, ContainsAiBannerProps, OutcomeBoxProps } from '../AiActLadderModal.types';
import { ART5_CHIPS, ANNEX_QUESTIONS } from './AiActLadderModal.constants';
import { tint, LadderModalViewStep2, Step } from './LadderModalViewStep2';
import { LadderModalViewStep } from './LadderModalViewStep';

export function StandaloneLadder(props: LadderModalViewProps) {
    const data = useAiActAssessment(props.kind, props.target, { enabled: props.open !== false });
    return <LadderModalView {...props} data={data} />;
}

export function LadderModalView({ open, onClose, kind = 'automation', target, data, onRecorded, now, zIndex }: LadderModalViewProps) {
    const { t, resolvedLocale } = useTranslation();
    const locale = resolvedLocale || 'en';
    const signals = data?.signals || null;
    const saved = data?.assessment || null;
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
    const [annexAnswers, setAnnexAnswers] = useState<DomainAnswers>(() => ({}));
    const [legacyYes, setLegacyYes] = useState(false);
    const [busy, setBusy] = useState<string | null>(null); // 'record' | 'marking' | null
    const [actionError, setActionError] = useState<Error | null>(null);

    useEffect(() => {
        if (!open) return;
        const a = saved?.answers || {};
        setArt5Denied(a.art5?.answer === 'no' ? new Set(ART5_PRACTICES) : new Set());
        const stored = a.annex_iii?.domains;
        if (stored && typeof stored === 'object' && ANNEX_III_CATEGORIES.some(id => stored[id] === 'yes' || stored[id] === 'no')) {
            setAnnexAnswers(Object.fromEntries(
                ANNEX_III_CATEGORIES.filter(id => stored[id] === 'yes' || stored[id] === 'no').map(id => [id, stored[id]]),
            ));
            setLegacyYes(false);
        } else {
            setAnnexAnswers(legacyAnnexAnswers(a.annex_iii));
            setLegacyYes(a.annex_iii?.answer === 'yes');
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

    // Which domains the automation's own wording touches. An ORDERING signal and
    // a marker beside the question — never a pre-filled answer. The server
    // sends all ten in `annex_iii_questions`, hinted ones first; a hint is the
    // same thing the keyword regex used to be, with the authority taken away.
    const annexHints = useMemo(() => new Set<string>(
        (Array.isArray(signals?.annex_iii_questions) ? signals.annex_iii_questions : [])
            .filter((q: { id: string; hint?: boolean }) => q && q.hint && q.id).map((q: { id: string; hint?: boolean }) => q.id),
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

    const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) => setter((prev) => {
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
            setActionError(err as Error);
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
            setActionError(err as Error);
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
                <LadderModalViewStep2 verdict={verdict} t={t} locale={locale} signals={signals} now={now} busy={busy} data={data} enableMarking={enableMarking} />

                {/* Step 3 — Annex III */}
                <LadderModalViewStep verdict={verdict} t={t} locale={locale} annexAnswered={annexAnswered} legacyYes={legacyYes} annexOrder={annexOrder} annexAnswers={annexAnswers} annexHints={annexHints} answerAnnex={answerAnnex} annexArticles={annexArticles} />

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

function surfaceLabel(signals: LadderSignals | null, t: Translate) {
    const s = signals?.surface;
    if (!s) return null;
    if (s === 'form') return t('compliance.ladder_surface_form', 'a form');
    if (s === 'published_agent') return t('compliance.ladder_surface_agent', 'a published agent');
    if (s === 'webpage') return t('compliance.ladder_surface_webpage', 'a web page');
    return String(s);
}

function ChipRow({ chips, denied, onToggle, t, testId }: ChipRowProps) {
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

function ContainsAiBanner({ containsAi, aiSteps, signals, t }: ContainsAiBannerProps) {
    const names = aiSteps.map(s => s?.label).filter(Boolean);
    return (
        <div
            data-testid="ladder-contains-ai"
            data-contains-ai={signals ? String(containsAi) : 'unknown'}
            className="flex items-start gap-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2.5"
        >
            <Sparkles size={16} aria-hidden="true" className="shrink-0 mt-0.5 [color:var(--type-ai)]" />
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

function outcomeText(verdict: Verdict, containsAi: boolean, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
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

function OutcomeBox({ verdict, containsAi, t }: OutcomeBoxProps) {
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
                            .map((f: string): string => (f === 'disclosure' ? t('compliance.ladder_fail_disclosure', 'AI notice') : t('compliance.ladder_fail_marking', 'content marking')))
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
