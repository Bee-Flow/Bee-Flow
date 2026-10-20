// "Save as test case" on a code step's row in a run: opens the test editor
// with this run's input for the step already chosen, so what really happened
// becomes a test in two clicks (plus the checks the person adds).
//
// Only offered when the input is on screen: a step whose data is hidden from
// this viewer, or that has no recorded input, is not a source of test data.
import { FlaskConical, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import { useTranslation } from '../../../../hooks/useTranslation';
import TestCaseEditor from '../flow/settings/codeStep/TestCaseEditor';

interface SaveAsTestCaseActionProps {
    automationId: string | null;
    step: RunStepRecord;
    /** The step as this run's version defined it: its input names. */
    stepDef?: Record<string, unknown> | null;
}

/** Can this row be saved as a test case? Exported for the test. */
export function canSaveAsTestCase(automationId: string | null | undefined, step: RunStepRecord | null | undefined): boolean {
    return !!automationId && !!step && step.stepType === 'code' && !step.dataHidden && !!step.runId
        && step.input !== undefined && step.input !== null;
}

/** The inputs a code step declares, for the typed-values option. */
function inputNamesOf(stepDef: Record<string, unknown> | null | undefined): string[] {
    const inputs = stepDef?.inputs;
    return inputs && typeof inputs === 'object' && !Array.isArray(inputs)
        ? Object.keys(inputs).filter((k) => k !== 'secretKeys')
        : [];
}

export default function SaveAsTestCaseAction({ automationId, step, stepDef = null }: SaveAsTestCaseActionProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState(false);
    if (!canSaveAsTestCase(automationId, step)) return null;

    const dialog = (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('automation_testing.save_as.title', 'Save as test case')}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
                className="relative max-h-[calc(100vh-32px)] w-full max-w-[520px] overflow-auto rounded-xl bg-[var(--bg-card)] text-[var(--text-primary)] shadow-2xl custom-scrollbar"
            >
                <button type="button" onClick={() => setOpen(false)} aria-label={t('automation_testing.save_as.close', 'Close')} className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--bg-tertiary)]">
                    <X size={14} aria-hidden="true" />
                </button>
                <TestCaseEditor
                    automationId={automationId}
                    stepId={step.stepId}
                    params={[]}
                    otherNames={inputNamesOf(stepDef)}
                    run={{ runId: step.runId as string, attempts: typeof step.attempts === 'number' ? step.attempts : null }}
                    onClose={() => setOpen(false)}
                    onSaved={() => setSaved(true)}
                />
            </div>
        </div>
    );

    return (
        <span className="ml-auto flex items-center gap-2">
            {saved && <span role="status" className="text-[var(--success)]">{t('automation_testing.save_as.saved', 'Saved. Find it in the Tests tab of the code editor.')}</span>}
            <button
                type="button"
                onClick={() => { setSaved(false); setOpen(true); }}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                data-testid="save-as-test-case"
            >
                <FlaskConical size={12} aria-hidden="true" />{t('automation_testing.save_as.action', 'Save as test case')}
            </button>
            {open && typeof document !== 'undefined' ? createPortal(dialog, document.body) : null}
        </span>
    );
}
