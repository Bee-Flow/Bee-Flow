import { ClipboardPen, Gavel } from 'lucide-react';
import React, { Suspense, useState } from 'react';
import { lazyWithI18n } from '@/utils/lazyWithReload';
import { useTranslation } from '@/hooks/useTranslation';
import { runPhase } from '@/components/automation/Builder/runs/runPhase';
import type { FormRunKind } from '@/components/automation/Builder/formRunContract';
import type { ExecutionRun } from './ExecutionBar';

const FormRunOverlay = lazyWithI18n(() => import('@/components/automation/Builder/FormRunOverlay'));

/**
 * A run waiting on a person, opened in Studio > Runs: "Answer this page" for a
 * form page, "Decide" for an approval (studio-and-forms F4). Both open the
 * builder's form test overlay ATTACHED to the run, so the page or the decision
 * is answered here and the overlay follows the journey to its next pause or its
 * end. Attach mode never starts a run.
 *
 * The overlay covers the run view (ExecutionView is its positioned parent);
 * every continuation and the close reload the run underneath.
 */
interface ExecutionFormAttachProps {
    run: ExecutionRun | null;
    /** The run view reads the run and its steps again. */
    onChanged: () => void;
}

/** The chip of the run: dry run, live test, or a production run (none). */
function kindOf(run: ExecutionRun): FormRunKind {
    const { isDry, isTest } = runPhase(run);
    if (isDry) return 'dry';
    return isTest ? 'live' : 'production';
}

export default function ExecutionFormAttach({ run, onChanged }: ExecutionFormAttachProps) {
    const { t } = useTranslation();
    const [attachedTo, setAttachedTo] = useState<{ runId: string; automationId: string | null; runKind: FormRunKind } | null>(null);
    const status = run?.status;
    const canAnswer = status === 'awaiting_form' || status === 'awaiting_approval';

    const open = () => {
        if (!run?.id) return;
        setAttachedTo({ runId: run.id, automationId: run.automationId ?? null, runKind: kindOf(run) });
    };
    const close = () => { setAttachedTo(null); onChanged(); };

    return (
        <>
            {canAnswer && !attachedTo && (
                <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                    <span className="flex-1 text-xs text-[var(--text-secondary)]">
                        {status === 'awaiting_form'
                            ? t('automation_testing.overlay.runs_form_hint', 'This run waits for somebody to fill in a page.')
                            : t('automation_testing.overlay.runs_approval_hint', 'This run waits for a decision.')}
                    </span>
                    <button
                        type="button"
                        onClick={open}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90"
                    >
                        {status === 'awaiting_form' ? <ClipboardPen size={12} aria-hidden="true" /> : <Gavel size={12} aria-hidden="true" />}
                        {status === 'awaiting_form'
                            ? t('automation_testing.overlay.answer_this_page', 'Answer this page')
                            : t('automation_testing.overlay.decide', 'Decide')}
                    </button>
                </div>
            )}
            {attachedTo && (
                <Suspense fallback={null}>
                    <FormRunOverlay
                        automationId={attachedTo.automationId}
                        runId={attachedTo.runId}
                        runKind={attachedTo.runKind}
                        onStartRun={async () => ({ kind: 'declined' })}
                        onFollowRun={onChanged}
                        onClose={close}
                    />
                </Suspense>
            )}
        </>
    );
}
