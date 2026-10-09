import React, { useMemo, useState } from 'react';
import DiagramPane from './DiagramPane';
import { buildRunStepLabelMap, runStepLabel } from './flow/displayHelpers';
import OutputView from './OutputView';
import { tokenForStep } from '../../shared/statusTokens';
import { useTranslation } from '../../../hooks/useTranslation';

/**
 * Read-only execution view for ONE run, shared by the in-automation Run
 * history tab and the cross-automation History drawer so both show the
 * identical overview/detail.
 *
 * Renders the run's flow diagram (each node coloured by its recorded status)
 * and a click-to-inspect panel below it that shows the selected step's
 * recorded Input and Output with the SAME friendly Table/JSON OutputView the
 * Build editor uses — so the data reads the same everywhere.
 *
 * The caller should pass a `key` of the run id so switching runs remounts
 * this view (the diagram re-fits and the open step resets).
 *
 * Props:
 *   definition  — the run-time definition snapshot (render THIS, not the
 *                 current definition, so the graph shows what actually ran)
 *   steps       — run step records:
 *                 [{ stepId, stepType, status, input, output, error, errorRemediation, durationMs }]
 *   emptyDefinitionMessage — text shown when no definition snapshot exists
 */
export default function RunExecutionView({
    definition,
    steps = [],
    emptyDefinitionMessage = 'Definition unavailable for this run.',
    // Controlled selection (ExecutionView lifts it so the timeline, the
    // canvas and the URL's ?step= all agree). Leave undefined for the legacy
    // self-managed behaviour.
    selectedStepId: controlledSelectedId = undefined,
    onSelectStep = null,
}) {
    const [localSelectedId, setLocalSelectedId] = useState(null);
    const controlled = controlledSelectedId !== undefined;
    const selectedStepId = controlled ? controlledSelectedId : localSelectedId;
    const select = (id) => {
        onSelectStep?.(id);
        if (!controlled) setLocalSelectedId(id);
    };

    // ALL attempts for the selected step, latest last. `steps.find` returned
    // the FIRST record, so a retried step always showed its stale failure.
    const attempts = useMemo(
        () => (selectedStepId ? steps.filter(s => s.stepId === selectedStepId) : []),
        [steps, selectedStepId],
    );
    // Nested flowlet steps are recorded as `<callId>/<innerId>` (BFSF-457).
    const labelById = useMemo(() => buildRunStepLabelMap(definition), [definition]);

    return (
        <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 relative">
                {definition ? (
                    <DiagramPane
                        definition={definition}
                        runSteps={steps}
                        onNodeClick={select}
                        /* No catalog here: the Executions view never loads one,
                           so its cards cannot name a table or a knowledge base.
                           Since the name maps are now UNDEFINED rather than
                           empty when absent, they degrade to "a table" instead
                           of claiming it was deleted — the actual harm. Wiring
                           a catalog fetch into this read-only view is its own
                           piece of work. */
                        readOnly
                    />
                ) : (
                    <div className="p-4 text-xs text-[var(--text-tertiary)]">{emptyDefinitionMessage}</div>
                )}
            </div>
            {attempts.length > 0 && (
                <StepDataPanel
                    attempts={attempts}
                    label={runStepLabel(labelById, selectedStepId)}
                    onClose={() => select(null)}
                />
            )}
        </div>
    );
}

/**
 * Bottom panel for the clicked step: a status/identity strip (the step's
 * NAME, not its internal id — the id stays in the title attribute), an
 * attempt switcher when the step ran more than once, any error, and the
 * recorded Input + Output side by side as friendly OutputViews.
 */
function StepDataPanel({ attempts, label, onClose }) {
    const { t } = useTranslation();
    // Latest attempt by default — that is the one whose outcome counted.
    const [attemptIdx, setAttemptIdx] = useState(-1);
    const idx = attemptIdx === -1 ? attempts.length - 1 : Math.min(attemptIdx, attempts.length - 1);
    const record = attempts[idx];
    if (!record) return null;
    return (
        <div className="flex-shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] max-h-[45%] overflow-y-auto p-3">
            <div className="flex items-center gap-2 text-xs mb-2">
                <StatusIcon step={record} />
                <span className="font-medium text-[var(--text-primary)] truncate" title={record.stepId}>{label}</span>
                {record.stepType && <span className="text-[var(--text-tertiary)]">({record.stepType})</span>}
                {attempts.length > 1 && (
                    <select
                        aria-label={t('automations.run_execution_view.attempt', 'Attempt')}
                        value={idx}
                        onChange={(e) => setAttemptIdx(Number(e.target.value))}
                        className="px-1.5 py-0.5 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] text-[11px] text-[var(--text-primary)]"
                    >
                        {attempts.map((_, i) => (
                            <option key={i} value={i}>{t('automations.run_execution_view.attempt_of', 'attempt {n} of {total}', { n: i + 1, total: attempts.length })}</option>
                        ))}
                    </select>
                )}
                <button
                    onClick={onClose}
                    className="ml-auto text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    {t('automations.run_execution_view.close', 'Close')}
                </button>
            </div>
            {record.error && (
                <div className="text-xs text-red-600 dark:text-red-400 mb-2">{record.error}</div>
            )}
            {record.errorRemediation && (
                <div className="text-xs text-amber-600 dark:text-amber-400 mb-2">→ {record.errorRemediation}</div>
            )}
            {/* Same friendly Table/JSON view as the Build editor's node Run tab. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('automations.run_execution_view.input', 'Input')}</div>
                    <OutputView value={record.input ?? null} emptyMessage="No input recorded." />
                </div>
                <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1">{t('automations.run_execution_view.output', 'Output')}</div>
                    <OutputView
                        value={record.output ?? null}
                        basePath={`steps.${record.stepId}.output`}
                        emptyMessage="No output recorded."
                        // Read-only view, but a nested list still has to be
                        // reachable: without this a `tasks` column is an inert
                        // badge here (BFSF-402).
                        allowExpand
                    />
                </div>
            </div>
        </div>
    );
}

function StatusIcon({ step }) {
    // Use the canonical status token table (single source of truth) so every
    // state — incl. awaiting_approval / cancelled / queued / handled_error —
    // gets its correct icon + colour, instead of falling through to a neutral
    // gray Play icon that made distinct states look identical.
    //
    // The whole RECORD goes in, not just its status word: that is what lets a
    // step that was switched off stay grey while one that ran and found
    // nothing to do reads amber.
    const t = tokenForStep(step);
    const Icon = t.icon;
    return <Icon size={12} data-status-key={t.labelKey} className={`${t.solid}${t.spin ? ' animate-spin' : ''}`} />;
}
