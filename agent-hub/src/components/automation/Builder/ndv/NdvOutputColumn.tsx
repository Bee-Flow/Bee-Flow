import type { ComponentProps, ReactNode } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import RunTabContainer from '../debug/RunTabContainer';
import type { DataSummary } from '../flow/types';
import { continuesSummary } from './ndvModel';
import NdvColumnHeader from './NdvColumnHeader';

type RunTabProps = ComponentProps<typeof RunTabContainer>;

/**
 * Column 3, "Continues on": its numbered head, the latest output (or the
 * hand-written one while Edit is open), and who reads it next.
 */
export default function NdvOutputColumn({
    step, runStep, outSummary, isTrigger, editButton, editorOpen, editor, downstream,
    definition, describedSample, automationId, onAddAfterStep, onRetryFromStep, onFixError,
}: {
    step: RunTabProps['step'];
    runStep: RunTabProps['runStep'];
    outSummary: DataSummary | null;
    isTrigger: boolean;
    editButton: ReactNode;
    editorOpen: boolean;
    editor: ReactNode;
    /** Labels of the steps wired after this one. */
    downstream: string[];
    definition: RunTabProps['definition'];
    describedSample: unknown;
    automationId: string | null;
    onAddAfterStep: RunTabProps['onAddAfterStep'];
    onRetryFromStep: RunTabProps['onRetryFromStep'];
    onFixError: RunTabProps['onFixError'];
}) {
    const { t } = useTranslation();
    const summary = continuesSummary(runStep, outSummary, isTrigger, t);
    return (
        <>
            <NdvColumnHeader
                n={3}
                testId="ndv-col-output"
                title={t('routines.ndv.continues', 'Continues on')}
                summary={runStep?.status === 'error'
                    // "Nothing, the step stopped" reads in the error colour (artboard 4a).
                    ? <span className="text-[var(--error)] font-medium">{summary}</span>
                    : summary}
            >
                {editButton}
            </NdvColumnHeader>
            <div className="flex-1 min-h-0 flex flex-col">
                {editorOpen ? editor : (
                    <RunTabContainer
                        step={step}
                        runStep={runStep}
                        definition={definition}
                        describedSample={describedSample}
                        automationId={automationId}
                        onAddAfterStep={onAddAfterStep}
                        onRetryFromStep={onRetryFromStep}
                        onFixError={onFixError}
                    />
                )}
            </div>
            {/* The column body says "Used by" itself; this line only
                stands in while the output editor covers it. */}
            {editorOpen && downstream.length > 0 && (
                <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)] border-t border-[var(--border-default)] shrink-0 truncate" data-testid="ndv-used-next">
                    {t('routines.ndv.used_next', 'Used next by {steps}', { steps: downstream.join(', ') })}
                </div>
            )}
        </>
    );
}
