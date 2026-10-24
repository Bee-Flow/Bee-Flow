import { X, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import FormSaveScenario from './FormSaveScenario';
import FormScenarioPicker from './FormScenarioPicker';
import apiClient from '../../../api/client';
import { useTranslation, type TranslateParams } from '../../../hooks/useTranslation';
import PublicFormRenderer from '../../forms/PublicFormRenderer';
import type { FormDef, FormFieldDef } from '../../forms/PublicFormRenderer.types';
import { logger } from '../../../utils/logger';

function headerTitle(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, attached: boolean, hasStep: boolean) {
    if (attached) return t('automations.form_run_overlay.live_run_title', 'Live run — this page is waiting for you');
    if (hasStep) return t('automations.form_run_overlay.next_page_title', 'Test — the next page');
    return t('automations.form_run_overlay.test_this_form', 'Test this form');
}

/**
 * Testing a form-triggered automation, as the person filling it in would see it.
 *
 * A form trigger is the one kind you cannot test by pressing Run: the trigger
 * IS a page somebody fills in, and pressing Run with nothing to submit used to
 * open the node editor and leave you to find the inline preview inside it. The
 * public page is no help while you are building either — formPublic 404s a
 * draft or deactivated automation by design, and a real submission there would run
 * the flow for real.
 *
 * So this is the form, over the canvas, wired to a real run:
 *
 *   1. page one comes from the DECLARATION being edited, so it reflects what is
 *      on screen right now rather than what was last saved;
 *   2. submitting starts a live run with those answers as the trigger payload;
 *   3. if the automation pauses at a `form_page`, the overlay serves THAT page and
 *      continues the same run — which is what makes it a test of the journey
 *      and not just of the first screen;
 *   4. when the run ends, the overlay says so and gets out of the way, leaving
 *      the canvas to show what every step did.
 *
 * The renderer is the same component the visitor gets (PublicFormRenderer), so
 * the theme, the field types and the app picker behave here exactly as they
 * will there. The picker is the one thing wired differently: it searches
 * through the builder's own owner-scoped endpoint, because the public one needs
 * a form token this automation does not have yet.
 */
interface FormRunOverlayProps {
    automationId: string | null | undefined;
    form?: FormDef;
    runId?: string | null;
    onStartRun: (answers: Record<string, unknown>) => Promise<{ run?: { id?: string }; id?: string } | null | undefined>;
    onClose: (e?: React.MouseEvent<HTMLButtonElement>) => void;
}

interface RunFormState {
    waiting?: boolean;
    form?: FormDef;
    runId?: string;
    stepId: string | null;
    status?: string;
    run?: { id?: string };
}

export default function FormRunOverlay({
    automationId,
    // The form declaration being edited — page one, live from the panel.
    form,
    // ATTACH mode: the id of a run that is already going (or parked on a page).
    // With no `form`, the overlay starts in 'working' and follows that run, so
    // the page it is waiting on shows up here instead of in a new browser tab.
    runId: attachRunId = null,
    // (answers) => Promise<{ run }>. Starts the live run. Owned by the shell,
    // because that is what holds the run stream the canvas is animating.
    onStartRun,
    onClose,
}: FormRunOverlayProps) {
    const { t } = useTranslation();
    // 'form' — a page is on screen; 'working' — the run is going; 'waiting' —
    // paused on a later page; 'done' / 'error' — it ended.
    const attached = !form && !!attachRunId;
    const [phase, setPhase] = useState(attached ? 'working' : 'form');
    const [page, setPage] = useState<{ form: FormDef | null; stepId: string | null }>({ form: form || null, stepId: null });
    const [runId, setRunId] = useState(attachRunId || null);
    const [error, setError] = useState<string | null>(null);
    // Saved answers laid over the page on screen (see FormScenarioPicker).
    const [prefill, setPrefill] = useState<Record<string, unknown> | null>(null);
    const closedRef = useRef(false);

    useEffect(() => {
        closedRef.current = false;
        return () => { closedRef.current = true; };
    }, []);

    /** The app picker, against the owner's own connections. */
    const searchApp = useCallback(async (field: FormFieldDef, query: string) => {
        const body = await apiClient.post(`/api/automation/${encodeURIComponent(String(automationId))}/form-pick`, {
            source: field.source, query,
        });
        return body || { results: [] };
    }, [automationId]);

    /**
     * Follow the run until it either ends or stops on another page.
     *
     * Polled rather than streamed: the builder already has a run stream for the
     * canvas, but what this needs is a different question ("is there a page for
     * me?") and a much slower cadence. A form pause can last as long as the
     * steps before it take.
     */
    const follow = useCallback(async (id: string | null) => {
        for (let i = 0; i < 600 && !closedRef.current; i++) {
            let state: RunFormState | null = null;
            try {
                state = await apiClient.get<RunFormState>(`/api/automation/runs/${encodeURIComponent(String(id))}/form`);
            } catch (err) { logger.debug('A transient read must not end the test; the next tick retries.', err); }
            if (closedRef.current) return;
            if (state?.waiting && state.form) {
                setRunId(state.runId || id);
                setPage({ form: state.form, stepId: state.stepId });
                setPrefill(null);
                setPhase('form');
                return;
            }
            if (state && state.status && !['running', 'queued', 'awaiting_form'].includes(state.status)) {
                setPhase(state.status === 'success' ? 'done' : 'error');
                if (state.status !== 'success') {
                    setError(t('automations.form_run_overlay.run_ended_as', 'The run ended as {status}.', { status: state.status }));
                }
                return;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }, [t]);

    // Attach mode: pick up the run that is already waiting.
    useEffect(() => {
        if (attached) follow(attachRunId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
    }, []);

    /** Page one: start the run. Later pages: continue the one that is paused. */
    const submit = useCallback(async ({ website_url: _honeypot, ...answers }: Record<string, unknown>) => {
        setError(null);
        setPhase('working');
        try {
            if (!page.stepId) {
                const out = await onStartRun(answers);
                const id = out?.run?.id || out?.id || null;
                setRunId(id);
                if (!id) { setPhase('done'); return; }
                await follow(id);
                return;
            }
            const out = await apiClient.post<RunFormState>(`/api/automation/runs/${encodeURIComponent(String(runId))}/form`, {
                stepId: page.stepId, values: answers,
            });
            const next = out?.run?.id || runId;
            setRunId(next);
            await follow(next);
        } catch (e) {
            if (closedRef.current) return;
            setPhase('error');
            setError((e as Error)?.message || t('automations.form_run_overlay.could_not_start', 'That run could not be started.'));
        }
    }, [page.stepId, runId, onStartRun, follow, t]);

    return (
        <div
            className="absolute inset-0 z-40 flex items-start justify-center overflow-auto bg-black/40 backdrop-blur-[1px] p-6"
            role="dialog"
            aria-modal="true"
            aria-label={headerTitle(t, attached, false)}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
        >
            <div className="w-full max-w-xl my-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)]">
                    <span className="flex-1 text-xs font-medium text-[var(--text-secondary)]">
                        {headerTitle(t, attached, !!page.stepId)}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('automations.form_run_overlay.close_the_test_form', 'Close the test form')}
                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <X size={14} />
                    </button>
                </div>

                <div className="p-4 max-h-[75vh] overflow-auto">
                    {phase === 'form' && (
                        <>
                            {/* Answers go through the automation for real — the
                                overlay is a test of the flow, not of the page. */}
                            <p className="mb-3 text-[11px] text-[var(--text-tertiary)]">
                                {page.stepId
                                    ? t('automations.form_run_overlay.paused_hint', 'The automation paused here and is waiting for an answer.')
                                    : t('automations.form_run_overlay.first_page_hint', 'What you submit runs the automation for real, with these answers as the trigger.')}
                            </p>
                            <FormScenarioPicker automationId={automationId} stepId={page.stepId} onPick={setPrefill} />
                            <PublicFormRenderer
                                key={page.stepId || 'page1'}
                                form={page.form as FormDef}
                                prefill={prefill}
                                onSubmit={submit}
                                onSearchApp={searchApp}
                                showSuccess={false}
                            />
                        </>
                    )}

                    {phase === 'working' && (
                        <div className="py-12 text-center">
                            <Loader2 size={20} className="mx-auto animate-spin text-[var(--text-tertiary)]" />
                            <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('automations.form_run_overlay.running_the_automation', 'Running the automation…')}</p>
                            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                                {t('automations.form_run_overlay.each_step_lights_up_on_the', 'Each step lights up on the canvas behind this.')}
                            </p>
                        </div>
                    )}

                    {phase === 'done' && (
                        <div className="py-12 text-center">
                            <CheckCircle2 size={20} className="mx-auto text-emerald-500" />
                            <p className="mt-3 text-sm text-[var(--text-primary)]">{t('automations.form_run_overlay.the_automation_finished', 'The automation finished.')}</p>
                            <button
                                type="button"
                                onClick={onClose}
                                className="mt-4 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90"
                            >
                                {t('automations.form_run_overlay.see_what_each_step_did', 'See what each step did')}
                            </button>
                            {runId && <FormSaveScenario automationId={automationId} runId={runId} />}
                        </div>
                    )}

                    {phase === 'error' && (
                        <div className="py-12 text-center">
                            <AlertTriangle size={20} className="mx-auto text-amber-500" />
                            <p className="mt-3 text-sm text-[var(--text-primary)]">{error || t('automations.form_run_overlay.something_went_wrong', 'Something went wrong.')}</p>
                            <button
                                type="button"
                                onClick={onClose}
                                className="mt-4 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                            >
                                {t('automations.form_run_overlay.close_and_look_at_the_run', 'Close and look at the run')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
