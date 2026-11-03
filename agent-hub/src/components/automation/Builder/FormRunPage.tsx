import React, { useRef, useState } from 'react';
import FormScenarioPicker from './FormScenarioPicker';
import PublicFormRenderer from '../../forms/PublicFormRenderer';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { FormDef, PublicFormRendererProps } from '../../forms/PublicFormRenderer.types';
import type { FormRunMode } from './formRunContract';
import type { UploadedFile } from './formRunApi';

/**
 * One page of the journey in the overlay: page one of the declaration being
 * edited, or the page a run parked on (`stepId`).
 *
 * Page one has two ways in. The page's own button starts what the overlay was
 * opened for (a dry run, unless it came from Run live); the button under it
 * starts the other one ("Run for real", whose confirm the shell asks once per
 * session). Both go through the renderer's own submit, so the questions are
 * checked the same way either way: the second button only sets the mode and
 * submits the form.
 */
interface FormRunPageProps {
    automationId: string | null | undefined;
    form: FormDef;
    stepId: string | null;
    startMode: FormRunMode;
    onSubmit: (values: Record<string, unknown>, mode: FormRunMode) => Promise<void>;
    onSearchApp: NonNullable<PublicFormRendererProps['onSearchApp']>;
    onUpload: (file: File, field: string) => Promise<UploadedFile>;
    /** Something was typed or picked on this page. */
    onTyped: () => void;
}

function pageHint(t: TranslateFn, paused: boolean, mode: FormRunMode) {
    if (paused) return t('automations.form_run_overlay.paused_hint', 'The automation paused here and is waiting for an answer.');
    if (mode === 'dry') return t('automation_testing.overlay.first_page_hint_dry', 'What you submit starts a dry run with these answers as the trigger: nothing is sent or written, and forms and approvals wait for you here.');
    return t('automations.form_run_overlay.first_page_hint', 'What you submit runs the automation for real, with these answers as the trigger.');
}

export default function FormRunPage({ automationId, form, stepId, startMode, onSubmit, onSearchApp, onUpload, onTyped }: FormRunPageProps) {
    const { t } = useTranslation();
    // Saved answers laid over the page on screen (see FormScenarioPicker).
    const [prefill, setPrefill] = useState<Record<string, unknown> | null>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Set only for the length of the other button's submit, which calls onSubmit synchronously.
    const otherModeRef = useRef<FormRunMode | null>(null);
    const otherMode: FormRunMode = startMode === 'dry' ? 'live' : 'dry';

    const submit = (values: Record<string, unknown>) => onSubmit(values, otherModeRef.current ?? startMode);
    const submitOther = () => {
        otherModeRef.current = otherMode;
        try { wrapRef.current?.querySelector('form')?.requestSubmit(); } finally { otherModeRef.current = null; }
    };
    const pick = (values: Record<string, unknown> | null) => { setPrefill(values); onTyped(); };

    return (
        <>
            <p className="mb-3 text-[11px] text-[var(--text-tertiary)]">{pageHint(t, !!stepId, startMode)}</p>
            <FormScenarioPicker automationId={automationId} stepId={stepId} onPick={pick} />
            <div ref={wrapRef} onChange={onTyped}>
                <PublicFormRenderer
                    form={form}
                    prefill={prefill}
                    onSubmit={submit}
                    onUpload={onUpload}
                    onSearchApp={onSearchApp}
                    showSuccess={false}
                />
            </div>
            {!stepId && (
                <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={submitOther}
                        className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        {otherMode === 'live'
                            ? t('automation_testing.overlay.run_for_real', 'Run for real')
                            : t('automation_testing.overlay.dry_run_instead', 'Dry run instead')}
                    </button>
                </div>
            )}
        </>
    );
}
