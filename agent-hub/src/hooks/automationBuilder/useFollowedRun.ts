import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { DryRun } from '../builderStream';
import type { AutomationBuilderState } from './types';
import { API_BASE, RefusedError, request } from '../../api/mutate';
import { logger } from '../../utils/logger';

/**
 * The builder's run tracker, and the only writer of `state.dryRun`.
 *
 * Every run the builder shows is followed by the id the SERVER gave it: the
 * 202 { runId } of a start sent with respond 'created', the AI builder's
 * `dryrun_started`, or my newest run found again after a reload. Nothing
 * guesses which run of the automation is "the" active one, so another run of
 * the same automation (a schedule, a webhook, someone else's test) never shows
 * as this one.
 *
 * While the run goes, the tracker reads GET /runs/:id (its status; on a
 * journey the status of the leg that ran last) and GET /runs/:id/steps (the
 * rows, every leg merged) every 750 ms. It settles on the first paused or
 * terminal phase: the run row replaces the 'running' stub, so a stub cannot
 * stay 'running' when a request or a stream ends early. A paused run is then
 * read every 10 s, so an answer given elsewhere (the overlay, the inbox) puts
 * the canvas back on the running journey; a terminal one stops the loop.
 *
 * The loop runs on timers started by follow(), not in an effect: it keeps
 * going whichever tab is shown, and stops on stop(), on the next follow() and
 * when the builder unmounts.
 *
 * `phaseOf` is runPhase (components/automation/Builder/runs/runPhase.ts),
 * handed in so this hooks/ module does not import from components/.
 */

type FollowKind = 'full' | 'partial' | 'journey';
type StepRows = AutomationBuilderState['steps'];
type SetState = Dispatch<SetStateAction<AutomationBuilderState>>;

/** The part of runPhase() the tracker reads. */
interface FollowedPhase { phase: string; terminal: boolean }
export type PhaseOf = (run: DryRun | null | undefined) => FollowedPhase;
/** Reads a run's step rows into state; `merge` keeps the rows of steps the answer does not carry. */
export type PollRows = (runId: string, opts?: { merge?: boolean }) => Promise<unknown>;

/** The run where it first paused or ended, with the rows read at that moment. */
export interface SettledRun { run: DryRun; steps: StepRows }

interface FollowOptions {
    /** 'full' starts on a clean canvas; 'partial' (Execute step) and 'journey' merge into the rows on screen. */
    kind?: FollowKind;
    startedAt?: number | string | null;
}

export const FOLLOW_RUNNING_MS = 750;
export const FOLLOW_PAUSED_MS = 10_000;
/** Unreadable polls in a row after which the stub is settled as failed: about three minutes at the running cadence. */
const FOLLOW_MAX_FAILED_POLLS = 240;
export const LOST_RUN_MESSAGE = 'Lost track of the run. Open Runs to see how it ended.';

interface Following {
    id: string;
    kind: FollowKind;
    token: number;
    failures: number;
    lastStatus: string | null;
    settled: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    resolve: (settled: SettledRun | null) => void;
}

type RunRead = { kind: 'ok'; run: DryRun } | { kind: 'gone' } | { kind: 'failed' };

const asRows = (steps: unknown): StepRows => (Array.isArray(steps) ? steps as StepRows : []);

/** The loop itself, outside React so every method stays small and testable. */
class RunFollower {
    private current: Following | null = null;
    private seq = 0;
    /** The last run id followed: a `dryrun` event for it was seen live and is not replayed. */
    private lastId: string | null = null;

    constructor(private readonly setState: SetState, private readonly pollRows: PollRows, private readonly phaseOf: PhaseOf) {}

    /** The run being followed, if any. */
    following(): { id: string; kind: FollowKind } | null {
        return this.current ? { id: this.current.id, kind: this.current.kind } : null;
    }

    /** Follow `runId` from now on: a 'running' stub, then the loop. Resolves when it first pauses or ends, null when replaced. */
    follow(runId: string, opts: FollowOptions = {}): Promise<SettledRun | null> {
        const kind = opts.kind || 'full';
        const stub: DryRun = { id: runId, status: 'running', startedAt: (opts.startedAt as DryRun['startedAt']) ?? null };
        this.setState(s => ({ ...s, dryRun: stub, steps: kind === 'full' ? [] : s.steps }));
        return this.start(runId, kind, null);
    }

    /** Follow a journey from its root (or any leg): GET /runs/:id reports the leg that ran last, /steps merges them all. */
    followJourney(rootRunId: string): Promise<SettledRun | null> {
        return this.follow(rootRunId, { kind: 'journey' });
    }

    /** Stop the loop. The run on screen stays as it is. */
    stop(): void {
        const f = this.current;
        if (!f) return;
        if (f.timer) clearTimeout(f.timer);
        this.current = null;
        f.resolve(null);
    }

    /**
     * Put a run the caller already holds on screen: a start that answered with
     * the finished run, the AI builder's `dryrun` event, a restored run. A run
     * that is not over yet is followed from here (its rows merge), so nothing
     * written here can stay 'running'. `fromStream` bumps the replay counter
     * unless the run was followed live.
     */
    adopt(run: DryRun | null | undefined, steps?: unknown, opts: { merge?: boolean; fromStream?: boolean } = {}): void {
        if (!run) { this.settle(); return; }
        const replay = !!opts.fromStream && !(run.id && run.id === this.lastId);
        this.setState(s => {
            const rows = Array.isArray(steps) ? (opts.merge ? mergeRows(s.steps, steps as StepRows) : steps as StepRows) : s.steps;
            return { ...s, dryRun: run, steps: rows, dryRunSeq: replay ? (s.dryRunSeq || 0) + 1 : s.dryRunSeq };
        });
        const id = typeof run.id === 'string' ? run.id : null;
        if (!id || this.phaseOf(run).terminal) {
            if (id && this.current?.id === id) this.stop();
            return;
        }
        if (this.current?.id !== id) void this.start(id, 'journey', String(run.status ?? ''));
    }

    /**
     * A start that failed: no run record is coming, so a 'running' or 'queued'
     * stub becomes 'error' (BFSF-360: left running, every ▶ Execute stays
     * disabled). A run that reported a real status is left alone; the rows stay.
     */
    settle(): void {
        this.stop();
        this.setState(s => (s.dryRun && (s.dryRun.status === 'running' || s.dryRun.status === 'queued')
            ? { ...s, dryRun: { ...s.dryRun, status: 'error' } }
            : s));
    }

    /** Dismiss the run: stop following it and clear the canvas. */
    clear(): void {
        this.stop();
        this.setState(s => ({ ...s, dryRun: null, steps: [] }));
    }

    private start(id: string, kind: FollowKind, lastStatus: string | null): Promise<SettledRun | null> {
        this.stop();
        const token = ++this.seq;
        this.lastId = id;
        let resolve: Following['resolve'] = () => {};
        const settled = new Promise<SettledRun | null>(r => { resolve = r; });
        this.current = { id, kind, token, failures: 0, lastStatus, settled: false, timer: null, resolve };
        void this.tick(token);
        return settled;
    }

    private live(token: number): Following | null {
        return this.current && this.current.token === token ? this.current : null;
    }

    private schedule(token: number, ms: number): void {
        const f = this.live(token);
        if (f) f.timer = setTimeout(() => { void this.tick(token); }, ms);
    }

    /** One poll: the status first, then (while running, or on a change of status) the rows. */
    async tick(token: number): Promise<void> {
        const f = this.live(token);
        if (!f) return;
        f.timer = null;
        const read = await readRun(f.id);
        if (!this.live(token)) return;
        if (read.kind !== 'ok') { this.unreadable(token, read.kind === 'gone'); return; }
        f.failures = 0;
        const run = read.run;
        const { phase, terminal } = this.phaseOf(run);
        const status = String(run.status ?? '');
        const rows = (phase === 'running' || status !== f.lastStatus)
            ? asRows(await this.pollRows(f.id, { merge: f.kind !== 'full' }))
            : [];
        if (!this.live(token)) return;
        f.lastStatus = status;
        if (phase === 'running') { this.markRunning(f.id, run); this.schedule(token, FOLLOW_RUNNING_MS); return; }
        this.settleOn(f, run, rows, terminal);
    }

    /** Paused or over: the run row replaces the stub, the first such answer resolves follow(), a pause is read on slowly. */
    private settleOn(f: Following, run: DryRun, rows: StepRows, terminal: boolean): void {
        const row = { ...run, id: run.id || f.id };
        this.setState(s => ({ ...s, dryRun: row }));
        if (!f.settled) { f.settled = true; f.resolve({ run: row, steps: rows }); }
        if (terminal) { this.current = null; return; }
        this.schedule(f.token, FOLLOW_PAUSED_MS);
    }

    /** The run cannot be read: refused or gone ends the follow, a transient failure is retried for a while. */
    private unreadable(token: number, gone: boolean): void {
        const f = this.live(token);
        if (!f) return;
        f.failures += 1;
        if (!gone && f.failures < FOLLOW_MAX_FAILED_POLLS) { this.schedule(token, FOLLOW_RUNNING_MS); return; }
        const wasRunning = !f.settled;
        this.settle();
        if (wasRunning) this.setState(s => ({ ...s, error: s.error || LOST_RUN_MESSAGE }));
    }

    /** Keep the stub 'running' for this id; write only when it is not already, so a poll does not re-render. */
    private markRunning(id: string, run: DryRun): void {
        this.setState(s => (s.dryRun?.id === id && (s.dryRun.status === 'running' || s.dryRun.status === 'queued')
            ? s
            : { ...s, dryRun: { id, status: 'running', startedAt: run.startedAt ?? s.dryRun?.startedAt ?? null } }));
    }
}

/** Rows by stepId: the incoming rows win, the others stay. */
function mergeRows(prev: StepRows, next: StepRows): StepRows {
    const byId = new Map((prev || []).map(st => [st.stepId, st]));
    for (const ns of next) byId.set(ns.stepId, ns);
    return Array.from(byId.values());
}

async function readRun(id: string): Promise<RunRead> {
    try {
        const r = await request(`${API_BASE}/api/automation/runs/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => null);
        const run = j && typeof j === 'object' ? (j as { run?: unknown }).run : null;
        return run && typeof run === 'object' ? { kind: 'ok', run: run as DryRun } : { kind: 'failed' };
    } catch (err) {
        if (err instanceof RefusedError && (err.status === 404 || err.status === 403)) return { kind: 'gone' };
        logger.debug('A transient read must not end the follow; the next tick retries.', err);
        return { kind: 'failed' };
    }
}

export interface FollowedRunApi {
    follow: (runId: string, opts?: FollowOptions) => Promise<SettledRun | null>;
    followJourney: (rootRunId: string) => Promise<SettledRun | null>;
    stop: () => void;
    adopt: (run: DryRun | null | undefined, steps?: unknown, opts?: { merge?: boolean; fromStream?: boolean }) => void;
    settle: () => void;
    clear: () => void;
    /** The run being followed right now, if any. */
    current: () => { id: string; kind: FollowKind } | null;
}

/** The tracker for one builder; its methods are stable for the builder's lifetime. */
export default function useFollowedRun({ setState, pollRows, phaseOf }: { setState: SetState; pollRows: PollRows; phaseOf: PhaseOf }): FollowedRunApi {
    const [follower] = useState(() => new RunFollower(setState, pollRows, phaseOf));
    useEffect(() => () => follower.stop(), [follower]);
    return useMemo<FollowedRunApi>(() => ({
        follow: (runId, opts) => follower.follow(runId, opts),
        followJourney: (rootRunId) => follower.followJourney(rootRunId),
        stop: () => follower.stop(),
        adopt: (run, steps, opts) => follower.adopt(run, steps, opts),
        settle: () => follower.settle(),
        clear: () => follower.clear(),
        current: () => follower.following(),
    }), [follower]);
}
