import React, { useMemo } from 'react';
import { errorInfoTitle } from './runLogSentence';
import { useTranslation } from '../../../../hooks/useTranslation';
import { buildRunStepLabelMap, runStepLabel } from '../../../automation/Builder/flow/displayHelpers';
import { statusLabel, tokenForStep } from '../../../shared/statusTokens';
import { formatDuration } from '../AutomationsStudio/historyUtils';

/**
 * The run as a story: every step in order, named as the user named it, with
 * what happened and how long it took. Sits beside the read-only canvas —
 * the canvas answers "where in the flow", this answers "in what order, and
 * where did it stop". Clicking a row selects the same step on the canvas.
 *
 * Reads only what ExecutionView already holds — no new request. Sub-steps
 * (parentStepId set — a Step/flowlet call's inner records) render indented
 * under their call step. Multiple attempts of one step collapse into the
 * LATEST record with an "attempt N" note.
 *
 * Rows go through `tokenForStep` rather than `tokenFor`: this is the one
 * surface that holds the whole step record, so it is the one that can tell a
 * step that was switched off (grey, a setting) from a step that ran and found
 * nothing to do (amber, an outcome). Both used to be one grey "Not needed".
 */
export default function RunStepTimeline({
    steps = [],
    definition = null,
    selectedStepId = null,
    onSelectStep = null,
    runStatus = null,
}) {
    const { t } = useTranslation();
    // Knows flowlet steps too: a nested row's stepId is `<callId>/<innerId>`.
    const labelById = useMemo(() => buildRunStepLabelMap(definition), [definition]);

    // Latest record per (parent, stepId), preserving first-seen order —
    // attempts of one step are one row, not three.
    const rows = useMemo(() => {
        const byKey = new Map();
        for (const s of steps) {
            const key = `${s.parentStepId || ''}/${s.stepId}`;
            const cur = byKey.get(key);
            if (!cur) byKey.set(key, { ...s, attempts: 1 });
            else byKey.set(key, { ...s, attempts: cur.attempts + 1 });
        }
        return [...byKey.values()];
    }, [steps]);

    // Where the run STOPPED — the first failing row (if the run failed).
    const stopIndex = useMemo(() => {
        if (runStatus !== 'error' && runStatus !== 'failed') return -1;
        return rows.findIndex(r => r.status === 'error' || r.status === 'failed');
    }, [rows, runStatus]);

    if (!rows.length) {
        return (
            <div className="px-3 py-4 text-[11px] text-[var(--text-tertiary)] italic">
                {t('studio_misc.steptimeline.none', 'No steps recorded for this run.')}
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 overflow-y-auto custom-scrollbar" role="list" aria-label={t('studio_misc.steptimeline.steps', 'Steps')}>
            <div className="px-3 py-2 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)] border-b border-[var(--border-default)] sticky top-0 bg-[var(--bg-primary)] z-10">
                {t('studio_misc.steptimeline.steps', 'Steps')}
            </div>
            {rows.map((row, i) => {
                const token = tokenForStep(row);
                const Icon = token.icon;
                const selected = row.stepId === selectedStepId;
                const label = runStepLabel(labelById, row.stepId);
                const nested = !!row.parentStepId;
                return (
                    <React.Fragment key={`${row.parentStepId || ''}/${row.stepId}`}>
                        <button
                            type="button"
                            role="listitem"
                            onClick={() => onSelectStep?.(selected ? null : row.stepId)}
                            title={row.stepId}
                            className={`w-full text-left flex items-start gap-2 px-3 py-2 border-b border-[var(--border-subtle,var(--border-default))] transition ${
                                selected ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'
                            } ${nested ? 'pl-7' : ''}`}
                        >
                            <Icon size={13} data-status-key={token.labelKey} className={`shrink-0 mt-0.5 ${token.solid}${token.spin ? ' animate-spin' : ''}`} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs font-medium text-[var(--text-primary)] truncate">{label}</span>
                                <span className="block text-[10px] text-[var(--text-tertiary)]">
                                    {statusLabel(t, token)}
                                    {row.durationMs != null && ` · ${t('studio_misc.steptimeline.took', 'took {duration}', { duration: formatDuration(row.durationMs) })}`}
                                    {row.attempts > 1 && ` · ${t('studio_misc.steptimeline.attempt', 'attempt {n} of {total}', { n: row.attempts, total: row.attempts })}`}
                                </span>
                                {/* The classifier's plain title when there is one;
                                    the raw message stays in the hover. */}
                                {row.error && (
                                    <span className="block text-[10px] text-[var(--error-ink)] truncate" title={row.error}>{errorInfoTitle(t, row.errorInfo) || row.error}</span>
                                )}
                            </span>
                        </button>
                        {i === stopIndex && (
                            <div className="px-3 py-1.5 text-[10px] text-[var(--error-ink)] border-b border-[var(--border-subtle,var(--border-default))] bg-[color-mix(in_srgb,var(--error)_5%,transparent)]">
                                {t('studio_misc.steptimeline.stopped_here', 'This is where it stopped. Nothing ran after this point.')}
                            </div>
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
}
