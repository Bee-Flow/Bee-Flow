import React, { useEffect, useRef, useState } from 'react';
import { Loader2, OctagonX, X } from 'lucide-react';
import Modal from '../../../shared/Modal';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useAiActCheck, useAnswerAiAct, type AiActCheckResult } from '../../../../api/queries/automation/aiActCheck';
import AiActQuestions, { draftBody, draftComplete, initialDraft, type AiActDraft } from './AiActQuestions';
import { PRIMARY_BTN, SECONDARY_BTN } from './settingsUi';

export type GoLiveAction = 'publish' | 'activate';

/**
 * Activate / "Make vN live" was refused with 409 `ai_act_check_required`: Bee
 * checked the routine and has questions it could not answer. This asks ONLY
 * those, all on one screen, and "Save and make live" saves the answers and
 * hands back to the caller, which retries the same publish or activate.
 *
 * The questions are read fresh (GET /:id/ai-act/check, the same check the
 * gate ran). When nothing is left to ask (another tab answered, or the model
 * came back) the caller retries straight away.
 */
export default function AiActQuestionsDialog({ open, automationId, stamp, action, onClose, onAnswered }: {
    open: boolean;
    automationId: string;
    stamp: string;
    action: GoLiveAction;
    onClose: () => void;
    /** The answers are recorded: retry the publish or activate. */
    onAnswered: () => void;
}) {
    const { t } = useTranslation();
    const check = useAiActCheck(automationId, stamp, { enabled: open, fresh: true });
    // Only an answer read after the dialog opened counts: a cached "all
    // done" from the settings page must not send the caller round again.
    const [openedAt] = useState(() => Date.now());
    const r = check.isFetching || check.dataUpdatedAt < openedAt ? undefined : check.data;
    const nothingLeft = !!r && r.required && !r.questions.length && r.status === 'valid';
    const handedBack = useRef(false);

    // Nothing to ask any more (also right after the answers were saved): go
    // live without a click. A parent callback, no request here.
    useEffect(() => {
        if (!open || !nothingLeft || handedBack.current) return;
        handedBack.current = true;
        onAnswered();
    }, [open, nothingLeft, onAnswered]);

    const heading = t('routines.aiact.title', 'AI Act check');
    let body: React.ReactNode;
    if (!r) {
        body = (
            <p className="flex items-center gap-2 text-[var(--text-secondary)]" role="status">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                {check.isError ? t('routines.aiact.check_failed', 'Bee could not check this automation right now.') : t('routines.aiact.checking', 'Bee is checking…')}
            </p>
        );
    } else if (r.status === 'prohibited') {
        body = (
            <p className="flex items-start gap-1.5 text-[var(--error)]">
                <OctagonX className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                {t('routines.aiact.prohibited_body', 'The check found a prohibited practice. This automation cannot go live. Ask your compliance officer to review it in the Compliance Hub.')}
            </p>
        );
    } else if (r.questions.length) {
        const key = r.questions.map(q => `${q.id}:${q.confidence}:${q.suggested}`).join('|');
        body = <Answering key={key} automationId={automationId} result={r} action={action} onClose={onClose} />;
    } else {
        body = null;
    }

    return (
        <Modal open={open} onClose={onClose} size="auto" className="w-full max-w-[560px]" label={heading} variant="bare">
            <div className="rounded-[14px] bg-[var(--bg-card)] shadow-xl text-xs text-[var(--text-primary)] flex flex-col max-h-[90vh] overflow-hidden">
                <div className="px-[18px] py-3.5 flex items-center gap-2 border-b border-[var(--border-default)]">
                    <h2 className="font-semibold text-sm">{heading}</h2>
                    <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <X className="w-[15px] h-[15px]" aria-hidden />
                    </button>
                </div>
                {body && !(r && r.questions.length) ? <div className="p-[18px]">{body}</div> : body}
            </div>
        </Modal>
    );
}

/** The questions and the two buttons. A saved answer lands in the shared check, which hands back above. */
function Answering({ automationId, result, action, onClose }: {
    automationId: string;
    result: AiActCheckResult;
    action: GoLiveAction;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<AiActDraft>(() => initialDraft(result.questions));
    const answer = useAnswerAiAct(automationId);
    const complete = draftComplete(result.questions, draft);
    const primary = action === 'publish'
        ? t('routines.aiact.save_and_live', 'Save and make live')
        : t('routines.aiact.save_and_activate', 'Save and activate');
    return (
        <>
            <div className="p-[18px] flex flex-col gap-3 overflow-y-auto">
                <p className="text-[var(--text-secondary)] leading-[17px]">
                    {t('routines.aiact.dialog_intro', 'Bee checked this automation for the AI Act. Answer what it could not work out, then it goes live.')}
                </p>
                <AiActQuestions questions={result.questions} draft={draft} onChange={setDraft} disabled={answer.isPending} />
                {answer.error && (
                    <p role="alert" className="text-[var(--error)]">
                        {answer.error.code?.startsWith('ai_act') && answer.error.message
                            ? answer.error.message
                            : t('routines.aiact.save_failed', 'Could not record the check. Try again.')}
                    </p>
                )}
            </div>
            <div className="px-[18px] py-3 border-t border-[var(--border-default)] flex gap-2 justify-end">
                <button type="button" onClick={onClose} className={SECONDARY_BTN}>{t('routines.aiact.cancel', 'Cancel')}</button>
                <button
                    type="button"
                    disabled={!complete || answer.isPending}
                    onClick={() => answer.mutate(draftBody(result.questions, draft))}
                    className={PRIMARY_BTN}
                >
                    {primary}
                </button>
            </div>
        </>
    );
}
