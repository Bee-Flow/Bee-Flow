import { useEffect, useState } from 'react';

/**
 * The test run, replayed step by step.
 *
 * The builder stream delivers a dry run's rows all at once (`dryrun` event →
 * `state.steps`, with `state.dryRunSeq` counting the events). Shown at once,
 * a run of twelve steps is a wall of "done" badges; shown one card at a time
 * it reads as a run — each card lights up "running" for `stepMs`, then
 * settles into its real row as the next one starts, and the canvas can follow
 * the card being revealed (`currentStepId` → DiagramPane's camera).
 *
 * Contract:
 *   - a replay starts on every CHANGE of `seq` observed after mount, when
 *     there are at least two rows, the hook is enabled and the OS did not ask
 *     for less motion. Mounting with rows already there (an old run reloaded
 *     with the automation) replays nothing; StrictMode's second mount pass sees
 *     the same seq and starts nothing either.
 *   - rows are revealed in execution order: by startedAt/started_at when every
 *     row carries one, else array order; the trigger's rows first regardless.
 *   - rows whose step is not on this canvas (a flowlet's internals, a deleted
 *     step) cannot be shown, so they land instantly with the next shown row.
 *   - when the last row settles, `replaying` is false and `visibleSteps` IS
 *     `steps` — the same reference — so memos downstream see no change.
 *   - a new seq mid-replay restarts; disabling (or reduced motion, or fewer
 *     than two rows) cancels and hands `steps` through untouched.
 *
 * `state.dryRun` is never touched — BuildTab's live-run poll keys on it, and a
 * replay that faked `status: 'running'` would start the poll and be overwritten.
 *
 * The frame list is built when the seq flips, in render ("adjust state while
 * rendering": a re-render before commit, not an effect one frame later), so
 * the first "running" card is on screen in the same commit the rows land.
 * Only the interval lives in an effect.
 */
export const REPLAY_STEP_MS = 650;

function startOf(row) {
    const raw = row?.startedAt ?? row?.started_at;
    if (!raw) return null;
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

/** `{ nodeIds, triggerIds }` for a definition — nodeIds null when there is none to check against. */
function idsOf(definition) {
    const triggerIds = new Set();
    if (!definition) return { nodeIds: null, triggerIds };
    const nodeIds = new Set();
    if (definition.trigger?.id) { nodeIds.add(definition.trigger.id); triggerIds.add(definition.trigger.id); }
    for (const tr of (definition.triggers || [])) if (tr?.id) { nodeIds.add(tr.id); triggerIds.add(tr.id); }
    for (const s of (definition.steps || [])) if (s?.id) nodeIds.add(s.id);
    return { nodeIds, triggerIds };
}

/** The rows in the order they ran: triggers first, then by start time when every row has one, else as given. */
export function replayOrder(steps, definition = null) {
    const { triggerIds } = idsOf(definition);
    const indexed = (steps || [])
        .filter((row) => row && row.stepId)
        .map((row, i) => ({ row, i, t: startOf(row), trigger: triggerIds.has(row.stepId) }));
    const timed = indexed.length > 0 && indexed.every((e) => e.t != null);
    indexed.sort((a, b) => {
        if (a.trigger !== b.trigger) return a.trigger ? -1 : 1;
        if (timed && a.t !== b.t) return a.t - b.t;
        return a.i - b.i;
    });
    return indexed.map((e) => e.row);
}

/**
 * The frames of a replay, in order: each one the rows visible while ONE row
 * is being revealed (`{ ...row, status: 'running' }`) plus everything already
 * settled before it. Rows with no node on the canvas ride along instantly.
 * The final state — every row real — is not a frame: it is `steps` itself.
 */
export function replayFrames(steps, definition = null) {
    const order = replayOrder(steps, definition);
    const { nodeIds } = idsOf(definition);
    const frames = [];
    const shown = [];
    let i = 0;
    while (i < order.length) {
        while (i < order.length && nodeIds && !nodeIds.has(order[i].stepId)) shown.push(order[i++]);
        if (i >= order.length) break;
        const row = order[i++];
        frames.push({ visibleSteps: [...shown, { ...row, status: 'running' }], currentStepId: row.stepId });
        shown.push(row);
    }
    return frames;
}

export function useDryRunReplay({
    steps,
    seq,
    enabled = true,
    stepMs = REPLAY_STEP_MS,
    reducedMotion = false,
    // The graph on the canvas, for "can this row be shown" and "is this a
    // trigger row". Optional: without it every row is shown in array order.
    definition = null,
}) {
    const [replay, setReplay] = useState(() => ({ seenSeq: seq, frames: null, i: 0 }));
    const canPlay = enabled && !reducedMotion;

    if (replay.seenSeq !== seq) {
        // A new dry run landed: build its frames now, so the first "running"
        // card is in this very commit. Idempotent for StrictMode's re-render.
        const frames = canPlay && Array.isArray(steps) && steps.length >= 2 ? replayFrames(steps, definition) : [];
        setReplay({ seenSeq: seq, frames: frames.length ? frames : null, i: 0 });
    } else if (replay.frames && !canPlay) {
        // Disabled (or reduced motion) mid-replay: cancel, never resume later.
        setReplay({ seenSeq: seq, frames: null, i: 0 });
    }

    const frames = canPlay ? replay.frames : null;
    useEffect(() => {
        if (!frames) return undefined;
        const id = setInterval(() => {
            setReplay((r) => {
                if (!r.frames) return r;
                const next = r.i + 1;
                return next >= r.frames.length ? { ...r, frames: null, i: 0 } : { ...r, i: next };
            });
        }, Math.max(0, Number(stepMs) || 0));
        return () => clearInterval(id);
    }, [frames, stepMs]);

    const frame = frames ? frames[Math.min(replay.i, frames.length - 1)] : null;
    return {
        visibleSteps: frame ? frame.visibleSteps : steps,
        currentStepId: frame ? frame.currentStepId : null,
        replaying: !!frame,
    };
}
