import React, { useState } from 'react';
import { CircleCheck, ClipboardCheck, Loader2, OctagonX } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatDate } from '../../../../utils/dateFormatters';
import { useAiActCheck, useAnswerAiAct, type AiActCheckResult } from '../../../../api/queries/automation/aiActCheck';
import AiActWizard from './AiActWizard';
import AiActQuestions, { draftBody, draftComplete, initialDraft, visibleQuestions, type AiActDraft } from './AiActQuestions';
import { answerWord, findingLabel, outcomeText, reasonText } from './aiActCopy';
import { PRIMARY_BTN, SECONDARY_BTN } from './settingsUi';

type Variant = 'section' | 'rail';

const WARN_CARD = 'p-3.5 rounded-xl border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[var(--bg-card)] flex flex-col gap-2.5 text-xs';

/**
 * The AI Act check as Bee does it (Studio → Automations handoff 5): Bee
 * checks the routine by itself (GET /:id/ai-act/check) and records what it
 * can answer. The card says what came out, and asks only what Bee could not
 * tell:
 *
 *   "Bee is checking…"          while the check runs
 *   "Checked automatically · …" with "What Bee found" and "Change answers"
 *                               (the full editor, AiActWizard, as the override)
 *   "1 question left"           the question inline; answering saves at once
 *
 * `variant="rail"` is the readiness rail's copy: it only shows while there is
 * something to do (checking, a question, a prohibited practice).
 */
type Phase = 'checking' | 'failed' | 'hidden' | 'questions' | 'prohibited' | 'valid' | 'unchecked';

/** Which state the card is in. The rail copy hides a done check. */
function phaseOf(check: ReturnType<typeof useAiActCheck>, variant: Variant): Phase {
    const r = check.data;
    if (check.isLoading || (check.isFetching && check.isPlaceholderData)) return 'checking';
    if (check.isError || !r) return 'failed';
    if (!r.required) return 'hidden';
    if (r.questions.length) return 'questions';
    if (r.status === 'prohibited') return 'prohibited';
    if (r.status === 'valid') return variant === 'rail' ? 'hidden' : 'valid';
    return 'unchecked';
}

export default function AiActAutoCard({ automationId, stamp, canEdit, variant = 'section' }: {
    automationId: string;
    stamp: string;
    canEdit: boolean;
    variant?: Variant;
}) {
    const { t } = useTranslation();
    const check = useAiActCheck(automationId, stamp);
    const [wizardOpen, setWizardOpen] = useState(false);
    const phase = phaseOf(check, variant);
    const r = check.data as AiActCheckResult;
    if (phase === 'hidden') return null;
    if (phase === 'questions') {
        const key = r.questions.map(q => `${q.id}:${q.confidence}:${q.suggested}`).join('|');
        return <OpenQuestions key={key} automationId={automationId} result={r} canEdit={canEdit} />;
    }
    const body: Record<Exclude<Phase, 'hidden' | 'questions'>, () => React.ReactNode> = {
        checking: () => (
            <p className="flex items-center gap-2 text-[var(--text-secondary)]" role="status" data-testid="aiact-checking">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden />
                {t('routines.aiact.checking', 'Bee is checking…')}
            </p>
        ),
        failed: () => (
            <div className="flex items-center gap-2 flex-wrap">
                <p className="text-[var(--text-secondary)]">{t('routines.aiact.check_failed', 'Bee could not check this automation right now.')}</p>
                <button type="button" onClick={() => { void check.refetch(); }} className={`${SECONDARY_BTN} ml-auto`}>
                    {t('routines.aiact.retry', 'Try again')}
                </button>
            </div>
        ),
        prohibited: () => (
            <p className="flex items-start gap-1.5 text-[var(--error)]">
                <OctagonX className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                {t('routines.aiact.prohibited_body', 'The check found a prohibited practice. This automation cannot go live. Ask your compliance officer to review it in the Compliance Hub.')}
            </p>
        ),
        valid: () => <Checked result={r} />,
        unchecked: () => <p className="text-[var(--text-secondary)]">{t('routines.aiact.not_checked', 'Not checked yet. Bee checks it as soon as someone who can edit this automation opens it.')}</p>,
    };
    const showChange = canEdit && (phase === 'valid' || phase === 'prohibited');
    return (
        <div className={variant === 'rail' ? WARN_CARD : 'flex flex-col gap-2.5 text-xs'} data-testid={`aiact-card-${variant}`}>
            {body[phase]()}
            {showChange && (
                <button type="button" onClick={() => setWizardOpen(true)} className={`${SECONDARY_BTN} self-start`}>
                    {t('routines.aiact.change_answers', 'Change answers')}
                </button>
            )}
            {canEdit && <AiActWizard open={wizardOpen} onClose={() => setWizardOpen(false)} automationId={automationId} />}
        </div>
    );
}

/** "Checked automatically · Minimal risk, no extra duties · valid until 28 Sep 2027" and what Bee found. */
function Checked({ result: r }: { result: AiActCheckResult }) {
    const { t } = useTranslation();
    const head = r.source === 'auto'
        ? t('routines.aiact.checked_auto', 'Checked automatically')
        : t('routines.aiact.checked', 'Checked');
    const until = r.expiresAt
        ? t('routines.aiact.valid_until_short', 'valid until {date}', { date: formatDate(r.expiresAt) })
        : null;
    return (
        <>
            <p className="flex items-start gap-2" data-testid="aiact-checked">
                <CircleCheck className="w-3.5 h-3.5 shrink-0 mt-px text-[var(--success)]" aria-hidden />
                <span>{[head, outcomeText(r.outcome, t), until].filter(Boolean).join(' · ')}</span>
            </p>
            {r.findings.length > 0 && (
                <details className="group">
                    <summary className="cursor-pointer text-[var(--text-secondary)] underline underline-offset-2 w-fit">
                        {t('routines.aiact.what_bee_found', 'What Bee found')}
                    </summary>
                    <ul className="mt-1.5 flex flex-col gap-1 pl-1" data-testid="aiact-findings">
                        {r.findings.map(f => (
                            <li key={f.id} className="leading-4">
                                <span className="font-semibold">{findingLabel(f.id, t)}: {answerWord(f.answer, t)}</span>
                                {f.by === 'person' && <span className="text-[var(--text-tertiary)]"> ({t('routines.aiact.your_answer', 'your answer')})</span>}
                                {f.evidence.length > 0 && (
                                    <span className="text-[var(--text-tertiary)]"> · {f.evidence.map(e => reasonText(e, t)).filter(Boolean).join(' ')}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </>
    );
}

/** The questions Bee could not answer, inline. The completing answer saves at once. */
function OpenQuestions({ automationId, result, canEdit }: { automationId: string; result: AiActCheckResult; canEdit: boolean }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<AiActDraft>(() => initialDraft(result.questions));
    const answer = useAnswerAiAct(automationId);
    const shown = visibleQuestions(result.questions, draft).length;
    const complete = draftComplete(result.questions, draft);
    const save = (d: AiActDraft) => answer.mutate(draftBody(result.questions, d));
    const onChange = (next: AiActDraft) => {
        setDraft(next);
        // Picking areas waits for the button: one tick is rarely the whole answer.
        if (draftComplete(result.questions, next) && next.answers.sensitiveUse !== 'yes') save(next);
    };
    return (
        <div className={WARN_CARD} data-testid="aiact-open">
            <div className="flex items-center gap-2 font-semibold">
                <ClipboardCheck className="w-[15px] h-[15px] text-[var(--warning)]" aria-hidden />
                {shown === 1
                    ? t('routines.aiact.questions_left_one', '1 question left')
                    : t('routines.aiact.questions_left', '{n} questions left', { n: shown })}
            </div>
            <p className="text-[var(--text-secondary)] leading-[17px]">
                {canEdit
                    ? t('routines.aiact.questions_intro', 'Bee checked the rest by itself. Only you can answer this.')
                    : t('routines.aiact.questions_viewer', 'Bee checked the rest by itself. Someone who can edit this automation has to answer this.')}
            </p>
            <AiActQuestions questions={result.questions} draft={draft} onChange={onChange} disabled={!canEdit || answer.isPending} />
            {canEdit && complete && !answer.isPending && (
                <button type="button" onClick={() => save(draft)} className={`${PRIMARY_BTN} self-start`}>
                    {t('routines.aiact.save_answers', 'Save answers')}
                </button>
            )}
            {answer.isPending && <p className="text-[var(--text-tertiary)]" role="status">{t('routines.aiact.saving', 'Saving…')}</p>}
            {answer.error && (
                <p role="alert" className="text-[var(--error)]">
                    {answer.error.code?.startsWith('ai_act') && answer.error.message
                        ? answer.error.message
                        : t('routines.aiact.save_failed', 'Could not record the check. Try again.')}
                </p>
            )}
            <p className="text-[var(--text-tertiary)]">{t('routines.aiact.needed', 'Needed before you can activate · valid 12 months')}</p>
        </div>
    );
}
