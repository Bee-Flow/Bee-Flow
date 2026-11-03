import { X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import FormRunApproval from './FormRunApproval';
import FormRunClosePrompt from './FormRunClosePrompt';
import FormRunPage from './FormRunPage';
import { EndPhase, ModeChip, SlowPhase, WorkingPhase } from './FormRunPhases';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import useFormRunJourney from './useFormRunJourney';
import type { FollowTiming } from './formRunFollower';
import type { FormDef } from '../../forms/PublicFormRenderer.types';
import type { FormRunClose, FormRunFollow, FormRunKind, FormRunMode, FormRunShellProps, FormRunStart } from './formRunContract';

/**
 * Testing a form-triggered automation as the person filling it in would see
 * it, from page one to the closing page, over the canvas (or over a run in
 * Studio > Runs, attached to it).
 *
 *   1. Page one comes from the DECLARATION being edited. Its button starts a
 *      dry run (nothing is sent or written, pages and approvals wait here);
 *      "Run for real" starts a live test behind the shell's confirm. Both go
 *      through the shell (onStartRun), which follows the run on the canvas.
 *   2. The overlay follows the journey (formRunFollower.ts) to whatever comes
 *      next: a later page, answered here and continued (POST /runs/:id/form,
 *      the canvas follows the continuation through onFollowRun); an approval,
 *      decided here with its snapshot questions (a pause, never an error); or
 *      the end, with the closing page the visitor would see.
 *   3. Closing never loses something by accident: a click beside a typed page
 *      asks first, a parked test run is kept waiting or discarded, and a run
 *      still going is not opened again by itself (RUN-11).
 *
 * The renderer is the visitor's own (PublicFormRenderer), so theme, field
 * types, uploads and the app picker behave as they will there. The picker and
 * uploads go through the builder's owner-scoped endpoints, because the public
 * ones need a form token this automation may not have yet.
 *
 * Attach mode (`runId` without `form`) never starts a run: it follows the run
 * it was given, and is what Studio > Runs opens for "Answer this page" / "Decide".
 * What the overlay does is useFormRunJourney; this file draws it.
 */
interface FormRunOverlayProps extends FormRunShellProps {
    automationId: string | null | undefined;
    /** Page one: the form declaration being edited. */
    form?: FormDef;
    /** Attach mode: the run (journey head) already going or parked on a page. */
    runId?: string | null;
    /** Start the run page one asked for (formRunContract.ts): 'started' carries the id to follow. */
    onStartRun: FormRunStart;
    /** What page one's own button starts: a dry run unless the overlay was opened from Run live. */
    startMode?: FormRunMode;
    /** The canvas follows a run by id; for every continuation of the journey. */
    onFollowRun?: FormRunFollow;
    onClose: FormRunClose;
    /** Attach mode: dry run, live test or production, when the caller knows; else read from the run. */
    runKind?: FormRunKind | null;
    /** The follow loop's cadence and budget. */
    followTiming?: FollowTiming;
}

function headerTitle(t: TranslateFn, attached: boolean, hasStep: boolean) {
    if (attached) return t('automations.form_run_overlay.live_run_title', 'Live run — this page is waiting for you');
    if (hasStep) return t('automations.form_run_overlay.next_page_title', 'Test — the next page');
    return t('automations.form_run_overlay.test_this_form', 'Test this form');
}

/** Esc belongs to the overlay while it is open: the builder's own Esc would close it without asking. */
function useOverlayEscape(onEscape: () => void) {
    const ref = useRef(onEscape);
    useEffect(() => { ref.current = onEscape; });
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            ref.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);
}

type Journey = ReturnType<typeof useFormRunJourney>;

/** The phase on screen. */
function OverlayBody({ j, automationId, startMode }: { j: Journey; automationId: string | null | undefined; startMode: FormRunMode }) {
    const { s } = j;
    if (s.phase === 'form' && s.page.form) {
        return (
            <FormRunPage
                key={s.page.stepId || 'page1'}
                automationId={automationId}
                form={s.page.form}
                stepId={s.page.stepId}
                startMode={startMode}
                onSubmit={j.submit}
                onSearchApp={j.searchApp}
                onUpload={j.upload}
                onTyped={j.typed}
            />
        );
    }
    if (s.phase === 'approval') return <FormRunApproval approval={s.approval} onDecide={j.decide} onWithdraw={j.withdraw} />;
    if (s.phase === 'slow') return <SlowPhase reason={s.slow} onRetry={j.retry} onClose={j.close} />;
    if (s.phase === 'done' || s.phase === 'failed' || s.phase === 'stopped') {
        // Answers can be kept after any journey that answered a page here, however it ended.
        return <EndPhase phase={s.phase} ending={s.ending} automationId={automationId} scenarioRunId={s.answered > 0 ? s.runIds[0] ?? null : null} onClose={j.close} />;
    }
    return <WorkingPhase />;
}

export default function FormRunOverlay({
    automationId, form, runId: attachRunId = null, onStartRun, startMode = 'dry', onFollowRun, onClose,
    runKind = null, triggerStepId = null, followTiming,
}: FormRunOverlayProps) {
    const { t } = useTranslation();
    const attached = !form && !!attachRunId;
    const j = useFormRunJourney({ automationId, form, attachRunId, onStartRun, startMode, onFollowRun, onClose, runKind, triggerStepId, followTiming });
    useOverlayEscape(() => j.requestClose(false));

    return (
        <div
            className="absolute inset-0 z-40 flex items-start justify-center overflow-auto bg-black/40 backdrop-blur-[1px] p-6"
            role="dialog"
            aria-modal="true"
            aria-label={headerTitle(t, attached, false)}
            onMouseDown={(e) => { if (e.target === e.currentTarget) j.requestClose(true); }}
        >
            <div className="w-full max-w-xl my-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)]">
                    <span className="flex-1 text-xs font-medium text-[var(--text-secondary)]">{headerTitle(t, attached, !!j.s.page.stepId)}</span>
                    <ModeChip runKind={j.s.runKind} />
                    <button
                        type="button"
                        onClick={() => j.requestClose(false)}
                        aria-label={t('automations.form_run_overlay.close_the_test_form', 'Close the test form')}
                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <X size={14} />
                    </button>
                </div>
                {j.s.prompt && <FormRunClosePrompt prompt={j.s.prompt} onClose={j.close} onDiscardRun={j.discardAndClose} onBack={j.back} />}
                <div className="p-4 max-h-[75vh] overflow-auto">
                    <OverlayBody j={j} automationId={automationId} startMode={startMode} />
                </div>
            </div>
        </div>
    );
}
