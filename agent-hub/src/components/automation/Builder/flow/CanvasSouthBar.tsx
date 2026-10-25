import { Crosshair, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { enginePill, engineSegments, showsRates } from './engineLine';
import { statusVar } from './nodeTypeColors';
import RunBanner from './RunBanner';
import useTranslation from '../../../../hooks/useTranslation';
import { type PlanStripProps, type EngineLineProps, type BuildBannerProps, type SouthCall, type Farewell, type CanvasSouthBarProps } from './CanvasSouthBar.types';
import { FAREWELL_MS, SKIPPED_MS, elapsedSince, shortReason, planStrip } from './CanvasSouthBar.helpers';
;

/**
 * The canvas's south edge (design 1a/1d): ONE thing at a time, by precedence —
 *   1. the run banner while a run is in flight or has failed,
 *   2. the build banner while the assistant is building — and for a moment
 *      after, so the ending is read rather than inferred from the silence,
 *   3. the selection bar while steps are selected,
 *   4. the gesture hint otherwise.
 * They used to live in separate <Panel>s and could sit on top of each other.
 *
 * The build banner is also the lock notice: it replaced the amber "AI is
 * editing — structural edits paused" chip. Amber is what this product reserves
 * for "needs your attention", and a build in progress needs nothing from the
 * person watching it. No thought text lives here either — the ghost slot on
 * the canvas carries the narration; the banner says what was just DONE.
 *
 * Props: `runFocus` (flow/runFocus.js), `onShowRun`, `formUrl`,
 * `selectedCount`, `selectionInDrawer` (the one selected step is open in the
 * step drawer: its header carries the same actions, so the bar steps aside
 * and nothing takes its place), `onDeleteSelection`, `onClearSelection`,
 * `structuralEditsBlocked`, `interactive`, `editable`; `buildCue` (BuildTab's
 * per-tool-call cue, carrying `engine` and `turn` from the stream hook for the
 * engine line), `following` + `onFollow` (whether the camera still follows
 * the build, and the way to hand it back).
 */

function PlanStrip({ todos, verb }: PlanStripProps) {
    const { t } = useTranslation();
    const plan = planStrip(Array.isArray(todos) ? todos : [], verb);
    if (!plan) return null;
    return (
        <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="canvas-build-plan">
            {' · '}{t('automations.canvas.plan_progress', 'Plan {done}/{total}', { done: plan.done, total: plan.total })}
            {plan.next && <span className="text-[var(--text-secondary)]" data-testid="canvas-build-plan-next"> · {plan.next}</span>}
        </span>
    );
}

function EngineLine({ engine, turn }: EngineLineProps) {
    const { t } = useTranslation();
    const pill = enginePill({ engine, t });
    const segments = engineSegments({ engine, turn, t });
    if (!pill && !segments.length) return null;
    const title = [
        engine?.modelId ? String(engine.modelId) : null,
        showsRates({ engine, turn }) ? 'measured on the last model call' : null,
    ].filter(Boolean).join(' · ') || undefined;
    return (
        <span
            className="hidden lg:block min-w-0 truncate text-[11px] text-[var(--text-tertiary)] tabular-nums"
            title={title}
            data-testid="canvas-build-engine"
            data-local={engine?.local === true ? '' : undefined}
        >
            {pill && (
                <span
                    className="inline-flex items-center rounded-full border border-[var(--border-default)] px-1.5 py-px mr-1.5 text-[10px] font-medium text-[var(--text-secondary)] align-middle"
                    data-testid="canvas-build-engine-local"
                >
                    {pill}
                </span>
            )}
            {segments.map((seg, i) => (
                <span key={seg}>{i > 0 ? ' · ' : ''}{seg}</span>
            ))}
        </span>
    );
}

function BuildBanner({ building, buildCue, farewell, endedAt, skipped, now, following, onFollow }: BuildBannerProps) {
    const { t } = useTranslation();
    const lastCall = buildCue?.lastCall || null;
    // The clock freezes at the ending: "1m 42s" is how long the build took,
    // not how long ago it finished.
    const elapsed = building
        ? elapsedSince(buildCue?.startedAt, now)
        : elapsedSince(farewell?.startedAt, endedAt);
    let verb: string | null = null;
    let verbTone: string | null = null;
    if (building && skipped) {
        // Nothing red on the cards for a refused call: the model simply tries
        // again. The banner says so, in the colour this product uses for
        // "look here", and only for a moment.
        verb = t('automations.canvas.build_skipped', 'Skipped: {reason}', { reason: shortReason(skipped.error) });
        verbTone = 'var(--warning)';
    } else if (building && buildCue?.phase === 'reviewing') {
        verb = t('automations.canvas.build_reviewing', 'Reviewing the automation…');
    } else if (building && lastCall?.title) {
        // The exact words of the activity row in the chat column, so the two
        // surfaces never disagree about what just happened.
        verb = lastCall.detail ? `${lastCall.title} · ${lastCall.detail}` : lastCall.title;
    }
    // `--accent` marks the live thing on this canvas — while building, the
    // build is it. The ending borrows the shared status table instead.
    const dotTone = building ? 'var(--accent)' : (farewell?.finalizedId ? (statusVar('success') as string) : 'var(--text-tertiary)');
    return (
        <div
            className="flex items-center gap-3 pl-3.5 pr-2 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] text-[12px] text-[var(--text-primary)] [box-shadow:var(--shadow-popover)]"
            data-testid="canvas-build-banner"
            data-phase={building ? buildCue?.phase : 'ended'}
        >
            <span className="relative flex h-2 w-2 shrink-0">
                {building && <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping motion-reduce:animate-none" style={{ background: dotTone }} />}
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: dotTone, boxShadow: `0 0 0 3px color-mix(in srgb, ${dotTone} 30%, transparent)` }} />
            </span>
            <span className="whitespace-nowrap">
                {building ? (
                    <>
                        <b>{t('automations.canvas.build_live', 'Building')}</b>
                        {elapsed && (
                            <span className="text-[var(--text-tertiary)] tabular-nums" data-testid="canvas-build-elapsed"> · {elapsed}</span>
                        )}
                        {verb && (
                            <span className="text-[var(--text-secondary)]" style={verbTone ? { color: verbTone } : undefined} data-testid="canvas-build-verb"> · {verb}</span>
                        )}
                        <PlanStrip todos={buildCue?.todos} verb={verb} />
                    </>
                ) : (
                    <span data-testid="canvas-build-farewell">
                        {farewell?.finalizedId
                            ? t('automations.canvas.build_done', 'Built · {n} steps · {t}', { n: farewell.stepCount, t: elapsed || '0s' })
                            : t('automations.canvas.build_stopped', 'Stopped — draft saved')}
                    </span>
                )}
            </span>
            {/* Only while building: the ending is a frozen snapshot, and a
                live rate beside "Built · 8 steps" would describe a call that
                is over. */}
            {building && <EngineLine engine={buildCue?.engine || null} turn={buildCue?.turn || null} />}
            {/* A gesture on the canvas takes the camera away from the build;
                this is how it is given back. Absent while the camera still
                follows — never a control that does nothing. */}
            {building && following === false && onFollow && (
                <button
                    type="button"
                    onClick={onFollow}
                    data-testid="canvas-build-follow"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-default)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <Crosshair size={12} /> {t('automations.canvas.build_follow', 'Follow the build')}
                </button>
            )}
        </div>
    );
}

export default function CanvasSouthBar({
    runFocus = null, onDismissRun = null, runIdentity = null, onShowRun = null, formUrl = null, onOpenFormOverlay = null,
    selectedCount = 0, selectionInDrawer = false, onDeleteSelection = null, onClearSelection = null,
    structuralEditsBlocked = false, interactive = true, editable = false,
    buildCue = null, following = true, onFollow = null,
}: CanvasSouthBarProps) {
    const { t } = useTranslation();
    const building = !!buildCue?.running;
    const lastCall = buildCue?.lastCall || null;

    // The elapsed clock ticks while the banner is up (design 1d, "12m 33s").
    // One interval for the whole bar, and only while there is something to
    // count — a canvas at rest schedules nothing. A build counts too: "still
    // building" and "building for two minutes" are different facts.
    const ticking = (!!runFocus?.startedAt && runFocus.state !== 'error') || (building && !!buildCue?.startedAt);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!ticking) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [ticking]);

    // Two marks set WHILE RENDERING when their input flips (React's "adjust
    // state during render": a re-render before commit, not an effect one frame
    // later) — so the very first frame after the stream ends already reads
    // "Built · …", and a refusal is on screen in the same frame as the call.
    //
    // The ending is a snapshot, not a read of the live cue: the cue keeps
    // changing after the stream ends (a stale narration, the next turn's
    // reset) and the line must report the build that just finished.
    const [ending, setEnding] = useState<{ building: boolean; at: number; snapshot: Farewell | null }>({ building, at: 0, snapshot: null });
    if (ending.building !== building) {
        setEnding({
            building,
            at: Date.now(),
            snapshot: building ? null : {
                startedAt: buildCue?.startedAt || null,
                finalizedId: buildCue?.finalizedId || null,
                stepCount: Math.max(0, Number(buildCue?.stepCount) || 0),
            },
        });
    }
    // Keyed on the call object's identity, which BuildTab keeps stable across
    // narration updates — a second refusal restarts the clock, the same one
    // re-rendered does not.
    const [refusal, setRefusal] = useState<{ call: SouthCall | null; at: number }>({ call: null, at: 0 });
    if (lastCall?.error && refusal.call !== lastCall) {
        setRefusal({ call: lastCall, at: Date.now() });
    }
    const farewell = !building && ending.snapshot && now < ending.at + FAREWELL_MS ? ending.snapshot : null;
    const skipped = building && refusal.call && now < refusal.at + SKIPPED_MS ? refusal.call : null;
    // Both windows close on their own: one timer for whichever ends first,
    // then `now` moves past it and the derived flags fall. The 1 s interval
    // is not enough — it stops with the build, and the ending must still go.
    const deadline = Math.min(
        farewell ? ending.at + FAREWELL_MS : Infinity,
        skipped ? refusal.at + SKIPPED_MS : Infinity,
    );
    useEffect(() => {
        if (!Number.isFinite(deadline)) return undefined;
        const id = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()) + 1);
        return () => clearTimeout(id);
    }, [deadline]);

    if (runFocus) {
        return (
            <RunBanner
                runFocus={runFocus} now={now} ticking={ticking} runIdentity={runIdentity} onDismissRun={onDismissRun}
                onShowRun={onShowRun} formUrl={formUrl} onOpenFormOverlay={onOpenFormOverlay}
            />
        );
    }

    if (building || farewell) {
        return (
            <BuildBanner
                building={building}
                buildCue={buildCue}
                farewell={farewell}
                endedAt={ending.at}
                skipped={skipped}
                now={now}
                following={following}
                onFollow={onFollow}
            />
        );
    }

    if (editable && selectedCount > 0) {
        if (selectionInDrawer) return null;
        return (
            <div
                className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[12px] [box-shadow:var(--shadow-popover)]"
                data-testid="canvas-selection-bar"
            >
                <span className="font-medium text-[var(--text-primary)]">
                    {selectedCount === 1
                        ? t('automations.canvas.selected_one', '1 step selected')
                        : t('automations.canvas.selected_many', '{n} steps selected', { n: selectedCount })}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)]">
                    {selectedCount === 1
                        ? t('automations.canvas.selected_hint_one', 'ctrl-click to add more · R D U P Del act on it')
                        : t('automations.canvas.selected_hint_many', 'drag to move them together')}
                </span>
                {onDeleteSelection && (
                    <button
                        type="button"
                        onClick={onDeleteSelection}
                        disabled={structuralEditsBlocked}
                        title={t('automations.canvas_south_bar.delete_the_selected_steps_their_neighbours', 'Delete the selected steps (their neighbours reconnect)')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-[var(--bg-tertiary)] disabled:opacity-40 transition text-[var(--error)]"
                    >
                        <Trash2 size={12} /> {t('automations.canvas.delete', 'Delete')}
                    </button>
                )}
                {onClearSelection && (
                    <button
                        type="button"
                        onClick={onClearSelection}
                        title={t('automations.canvas_south_bar.clear_the_selection', 'Clear the selection')}
                        aria-label={t('automations.canvas_south_bar.clear_selection', 'Clear selection')}
                        className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        <X size={13} />
                    </button>
                )}
            </div>
        );
    }

    if (!interactive) return null;
    return (
        <div
            className="rounded-full bg-[var(--bg-card)] border border-[var(--border-default)] px-2.5 py-1 text-[11px] text-[var(--text-tertiary)] pointer-events-none whitespace-nowrap"
            data-testid="canvas-hint"
        >
            {t('automations.canvas.gesture_hint', 'Two fingers or Space+drag to pan · pinch or wheel to zoom · drag to select')}
        </div>
    );
}
