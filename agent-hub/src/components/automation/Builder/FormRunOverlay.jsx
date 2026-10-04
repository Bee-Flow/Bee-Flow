import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import PublicFormRenderer from '../../forms/PublicFormRenderer';
import apiClient from '../../../api/client';

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
export default function FormRunOverlay({
    automationId,
    // The form declaration being edited — page one, live from the panel.
    form,
    // (answers) => Promise<{ run }>. Starts the live run. Owned by the shell,
    // because that is what holds the run stream the canvas is animating.
    onStartRun,
    onClose,
}) {
    // 'form' — a page is on screen; 'working' — the run is going; 'waiting' —
    // paused on a later page; 'done' / 'error' — it ended.
    const [phase, setPhase] = useState('form');
    const [page, setPage] = useState({ form, stepId: null });
    const [runId, setRunId] = useState(null);
    const [error, setError] = useState(null);
    const closedRef = useRef(false);

    useEffect(() => () => { closedRef.current = true; }, []);

    /** The app picker, against the owner's own connections. */
    const searchApp = useCallback(async (field, query) => {
        const body = await apiClient.post(`/api/automation/${encodeURIComponent(automationId)}/form-pick`, {
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
    const follow = useCallback(async (id) => {
        for (let i = 0; i < 600 && !closedRef.current; i++) {
            let state = null;
            try {
                state = await apiClient.get(`/api/automation/runs/${encodeURIComponent(id)}/form`);
            } catch (_) {
                // A transient read must not end the test; the next tick retries.
            }
            if (closedRef.current) return;
            if (state?.waiting && state.form) {
                setRunId(state.runId || id);
                setPage({ form: state.form, stepId: state.stepId });
                setPhase('form');
                return;
            }
            if (state && state.status && !['running', 'queued', 'awaiting_form'].includes(state.status)) {
                setPhase(state.status === 'success' ? 'done' : 'error');
                if (state.status !== 'success') setError(`The run ended as ${state.status}.`);
                return;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }, []);

    /** Page one: start the run. Later pages: continue the one that is paused. */
    const submit = useCallback(async ({ website_url: _honeypot, ...answers }) => {
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
            const out = await apiClient.post(`/api/automation/runs/${encodeURIComponent(runId)}/form`, {
                stepId: page.stepId, values: answers,
            });
            const next = out?.run?.id || runId;
            setRunId(next);
            await follow(next);
        } catch (e) {
            if (closedRef.current) return;
            setPhase('error');
            setError(e?.message || 'That run could not be started.');
        }
    }, [page.stepId, runId, onStartRun, follow]);

    return (
        <div
            className="absolute inset-0 z-40 flex items-start justify-center overflow-auto bg-black/40 backdrop-blur-[1px] p-6"
            role="dialog"
            aria-modal="true"
            aria-label="Test this form"
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
        >
            <div className="w-full max-w-xl my-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)]">
                    <span className="flex-1 text-xs font-medium text-[var(--text-secondary)]">
                        {page.stepId ? 'Test — the next page' : 'Test this form'}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close the test form"
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
                                    ? 'The automation paused here and is waiting for an answer.'
                                    : 'What you submit runs the automation for real, with these answers as the trigger.'}
                            </p>
                            <PublicFormRenderer
                                key={page.stepId || 'page1'}
                                form={page.form}
                                onSubmit={submit}
                                onSearchApp={searchApp}
                                showSuccess={false}
                            />
                        </>
                    )}

                    {phase === 'working' && (
                        <div className="py-12 text-center">
                            <Loader2 size={20} className="mx-auto animate-spin text-[var(--text-tertiary)]" />
                            <p className="mt-3 text-sm text-[var(--text-secondary)]">Running the automation…</p>
                            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                                Each step lights up on the canvas behind this.
                            </p>
                        </div>
                    )}

                    {phase === 'done' && (
                        <div className="py-12 text-center">
                            <CheckCircle2 size={20} className="mx-auto text-emerald-500" />
                            <p className="mt-3 text-sm text-[var(--text-primary)]">The automation finished.</p>
                            <button
                                type="button"
                                onClick={onClose}
                                className="mt-4 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90"
                            >
                                See what each step did
                            </button>
                        </div>
                    )}

                    {phase === 'error' && (
                        <div className="py-12 text-center">
                            <AlertTriangle size={20} className="mx-auto text-amber-500" />
                            <p className="mt-3 text-sm text-[var(--text-primary)]">{error || 'Something went wrong.'}</p>
                            <button
                                type="button"
                                onClick={onClose}
                                className="mt-4 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                            >
                                Close and look at the run
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
