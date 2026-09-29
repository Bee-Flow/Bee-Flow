import { Loader2, Rows3, Table2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import RowsPreview from './RowsPreview';
import { StageHeader } from './StageShell';
import { stagePadding, stageType } from './stageChrome';
import useCountUp from './useCountUp';
import useRunFilm from './useRunFilm';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { kindColorVar } from '../../../../shared/kindColors';
import RunExecutionView from '../../../../automation/Builder/RunExecutionView';

const STEPS_POLL_MS = 1500;
/**
 * Phase 3 — the server runs the automation once. Two things only, and the
 * width belongs to them (owner, 2026-09-16: no menus left or right while the
 * data is landing): the FLOW executing, each step tinted by what it did, and
 * the TABLE underneath filling up. The run's own progress is already in the
 * canvas ("Live run · <step> · 2/5"), so the step list beside it was saying
 * the same thing twice; the row count moved into the bar above the flow.
 */
export default function FillStage({ playbook, phase, dispatch, t, reducedMotion = false, presenter = false, onNavigate = null }) {
    const api = useAutomationApi();
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const startedRef = useRef(null);
    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${phase.attempt || 0}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, dispatch]);

    const [steps, setSteps] = useState([]);
    const [definition, setDefinition] = useState(null);
    const [selectedStepId, setSelectedStepId] = useState(null);
    const runId = art.runId || null;
    const live = status === 'running';
    useEffect(() => {
        if (!runId) return undefined;
        let alive = true;
        let timer = null;
        const fetchSteps = async () => {
            try {
                const d = await api.getRunSteps(runId);
                if (!alive) return;
                setSteps(Array.isArray(d?.steps) ? d.steps : []);
                setDefinition(d?.definition || null);
            } catch { /* keep the last good data */ }
            if (alive && live) timer = setTimeout(fetchSteps, STEPS_POLL_MS);
        };
        fetchSteps();
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [runId, live, api]);

    // The table the rows land in: its columns come from the table phase.
    const tablePhase = (playbook?.phases || []).find((p) => (p.kind || p.key) === 'table');
    const tableArt = tablePhase?.artifacts || {};
    const datatableId = art.datatableId || tableArt.datatableId || null;
    // While the run lives the preview re-reads every few seconds, so the rows
    // are seen arriving; once landed it reads once more for the final state.
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!live) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 4000);
        return () => clearInterval(id);
    }, [live]);
    // What the canvas shows: the run walked node by node, so the trigger is
    // seen firing and every step lights up before it lands. Never ahead of
    // what the server recorded — see runFilm.js.
    const filmSteps = useRunFilm(steps, definition, { runId, runStatus: art.runStatus || null, reducedMotion });

    const target = Number.isFinite(art.rowCount) ? art.rowCount : (Number.isFinite(art.rowsBefore) ? art.rowsBefore : 0);
    const shown = useCountUp(target, { reducedMotion });
    const landed = status === 'awaiting' || status === 'done';
    const type = stageType(presenter);
    const added = Number.isFinite(art.rowCount) && Number.isFinite(art.rowsBefore) ? art.rowCount - art.rowsBefore : null;

    return (
        <div className="pbk-stage-enter h-full flex flex-col overflow-hidden" data-testid="playbook-stage-fill">
            {/* The same header every other phase opens with — this one used to
                be a bare 11px uppercase h3 with no tile at all. */}
            <div className="shrink-0" style={{ padding: `${stagePadding(presenter).split(' ')[0]} ${stagePadding(presenter).split(' ').slice(-1)[0]} 8px` }}>
                <StageHeader
                    kind="datatable"
                    icon={Table2}
                    presenter={presenter}
                    title={t('playbooks.fill.steps', 'The run, step by step')}
                    tone={status === 'failed' ? 'error' : 'busy'}
                    status={(
                        <>
                            {live && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                            {landed
                                ? t('playbooks.fill.done', '{n} rows · done', { n: target })
                                : status === 'failed'
                                    ? t('playbooks.fill.failed', 'The run failed')
                                    : t('playbooks.fill.running', 'running')}
                        </>
                    )}
                    actions={(
                        <span className="flex items-baseline gap-2">
                            {landed && Number.isFinite(added) && added >= 0 && (
                                <span style={{ fontSize: type.meta, color: 'var(--kind-playbook)' }}>{t('playbooks.fill.added', '+{n} this run', { n: added })}</span>
                            )}
                            <Rows3 className="self-center" style={{ width: 14, height: 14, color: kindColorVar('datatable') }} aria-hidden="true" />
                            {/* The digits carry their own motion; `key` used to be
                                the animated value, so the 220ms lift restarted on
                                every frame and the number read dim for its whole run. */}
                            <span className={reducedMotion ? 'tabular-nums font-semibold' : 'tabular-nums font-semibold pbk-digit-in'} key={landed ? 'final' : 'live'} style={{ fontSize: presenter ? 28 : 22, lineHeight: 1, color: 'var(--text-primary)', letterSpacing: '-0.02em' }} data-testid="playbook-row-counter">{shown}</span>
                            {/* The live region carries the SETTLED value, not the
                                36 frames of the count-up. */}
                            <span className="sr-only" aria-live="polite">{t('playbooks.fill.rows_so_far_n', '{n} rows in the table', { n: target })}</span>
                            <span style={{ fontSize: type.meta, color: 'var(--text-secondary)' }} aria-hidden="true">
                                {t('playbooks.fill.rows_so_far', 'rows in the table')}
                            </span>
                        </span>
                    )}
                />
            </div>

            {runId ? (
                <div className="flex-1 min-h-0 flex flex-col" data-testid="playbook-fill-canvas">
                    <RunExecutionView
                        key={runId}
                        definition={definition}
                        steps={filmSteps}
                        selectedStepId={selectedStepId}
                        onSelectStep={setSelectedStepId}
                        emptyDefinitionMessage={t('playbooks.fill.loading_flow', 'Loading the flow…')}
                    />
                </div>
            ) : (
                <div className="flex-1 flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)', padding: presenter ? '0 32px' : '0 24px' }}>
                    <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    {status === 'failed' ? t('playbooks.fill.not_started', 'The run did not start') : t('playbooks.fill.starting', 'Starting the automation…')}
                </div>
            )}

            {datatableId && (live || landed) && (
                <div className="shrink-0" style={{ padding: presenter ? '0 32px 24px' : '0 24px 16px', maxHeight: '45%', overflowY: 'auto' }}>
                    <RowsPreview
                        datatableId={datatableId}
                        fields={tableArt.fields || []}
                        rowCount={Number.isFinite(art.rowCount) ? art.rowCount : null}
                        refreshKey={`${tick}:${status}:${art.rowCount || 0}`}
                        t={t}
                        onNavigate={onNavigate}
                        reducedMotion={reducedMotion}
                        title={live ? t('playbooks.rows.arriving', 'Rows arriving in the table') : undefined}
                    />
                </div>
            )}
        </div>
    );
}
