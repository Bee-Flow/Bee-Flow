/**
 * The client's half of the playbook state machine — a port of
 * agent-hub/src/components/admin/Studio/Playbooks/phaseMachine.js, pinned to
 * it by phaseMachine.lockstep.test.ts (both run on the same phases and
 * events).
 *
 * The SERVER decides every transition (server/routes/playbooks/); this only
 * answers what the page is doing now, what the person may press, and exactly
 * what each press sends — so the wire bodies are testable without a network.
 */

import type { Artifacts, Phase, Playbook } from './types';

/** POST …/phases/<key>/run, then poll: the server runs these itself. */
export const SERVER_RUN: ReadonlySet<string> = new Set(['table', 'fill', 'design', 'compliance']);
/** A builder (or the person) works here; the page PATCHes the status. */
export const CLIENT_RUN: ReadonlySet<string> = new Set(['automation', 'app', 'app_turn', 'access']);
export const TERMINAL: ReadonlySet<string> = new Set(['done', 'skipped', 'locked']);
export const ACTIONABLE: ReadonlySet<string> = new Set(['ready', 'running', 'awaiting', 'failed']);

type PhaseLike = Pick<Phase, 'key' | 'status'> & { kind?: string | null };

/** A phase's KIND decides its stage; rows from before recipe documents carry the key only. */
export function kindOf(phase: { key: string; kind?: string | null } | null | undefined): string | null {
    if (!phase) return null;
    if (phase.kind) return phase.kind;
    return phase.key === 'approvals' ? 'app_turn' : phase.key;
}

export function phaseByKey<P extends PhaseLike>(phases: readonly P[] | null | undefined, key: string): P | null {
    return (phases ?? []).find((p) => p && p.key === key) ?? null;
}

/** The phase the page acts on now: the first one not yet settled, in order. */
export function nextActionable<P extends PhaseLike>(phases: readonly P[] | null | undefined): P | null {
    return (phases ?? []).find((p) => p && ACTIONABLE.has(p.status)) ?? null;
}

/** The phase after `afterKey` that is not terminal — the one whose brief the handoff edits. */
export function nextPending<P extends PhaseLike>(phases: readonly P[] | null | undefined, afterKey: string): P | null {
    const list = phases ?? [];
    const i = list.findIndex((p) => p && p.key === afterKey);
    for (let j = i + 1; j < list.length; j++) {
        const p = list[j];
        if (p && !TERMINAL.has(p.status)) return p;
    }
    return null;
}

export function isComplete(phases: readonly PhaseLike[] | null | undefined): boolean {
    const list = phases ?? [];
    return list.length > 0 && list.every((p) => TERMINAL.has(p.status));
}

export function progress(phases: readonly PhaseLike[] | null | undefined): { done: number; total: number; locked: number } {
    const list = phases ?? [];
    return {
        done: list.filter((p) => p.status === 'done' || p.status === 'skipped').length,
        total: list.length,
        locked: list.filter((p) => p.status === 'locked').length,
    };
}

export function canContinue(phases: readonly PhaseLike[] | null | undefined): boolean {
    const waiting = (phases ?? []).find((p) => p && p.status === 'awaiting');
    if (!waiting) return false;
    const next = nextPending(phases, waiting.key);
    return !next || next.status === 'ready' || next.status === 'pending';
}

export function canRetry(phase: PhaseLike | null | undefined): boolean {
    return !!phase && phase.status === 'failed';
}

/** Never the table — every later brief builds on it. A running phase may be skipped whatever runs it. */
export function canSkip(phase: PhaseLike | null | undefined): boolean {
    if (!phase || kindOf(phase) === 'table') return false;
    return ['ready', 'running', 'awaiting', 'failed', 'locked'].includes(phase.status);
}

export type OptimisticKind = 'started' | 'artifacts' | 'finished' | 'failed' | 'needs_input' | 'dismiss_input' | 'skipped' | 'done';

export interface OptimisticResult {
    kind: OptimisticKind;
    artifacts?: Artifacts;
    summary?: string;
    error?: string;
}

function applyOne(p: Phase, result: OptimisticResult, now: string): Phase {
    switch (result.kind) {
        case 'started': return { ...p, status: 'running', startedAt: p.startedAt || now, needsInput: false, optimistic: true };
        case 'artifacts': return { ...p, artifacts: { ...p.artifacts, ...result.artifacts } };
        case 'finished':
            return { ...p, status: 'awaiting', finishedAt: now, needsInput: false, summary: result.summary || p.summary, artifacts: { ...p.artifacts, ...result.artifacts } };
        case 'failed': return { ...p, status: 'failed', finishedAt: now, needsInput: false, error: result.error || p.error };
        case 'needs_input': return { ...p, needsInput: true };
        case 'dismiss_input': return { ...p, needsInput: false };
        case 'skipped': return { ...p, status: 'skipped', finishedAt: now };
        case 'done': return { ...p, status: 'done', finishedAt: p.finishedAt || now };
        default: return p;
    }
}

/**
 * An event applied before the server answers, so the phase list moves at
 * once. The server's answer then replaces the whole entity (and drops the
 * page-local `optimistic` mark).
 */
export function applyPhaseResult(phases: readonly Phase[], key: string, result: OptimisticResult): Phase[] {
    const now = new Date().toISOString();
    return phases.map((p) => (p && p.key === key ? applyOne(p, result, now) : p));
}

export type PlaybookEvent =
    | { type: 'start'; key: string; artifacts?: Artifacts }
    | { type: 'artifact'; key: string; artifacts: Artifacts }
    | { type: 'finished'; key: string; summary?: string; artifacts?: Artifacts }
    | { type: 'markDone'; key: string; summary?: string; artifacts?: Artifacts }
    | { type: 'failed'; key: string; error?: string }
    | { type: 'continue'; key: string; nextKey?: string | null; brief?: string }
    | { type: 'revise'; key: string; feedback: string }
    | { type: 'skip'; key: string }
    | { type: 'retry'; key: string }
    | { type: 'stop' }
    | { type: 'resume' };

export type Wire =
    | { method: 'PATCH'; body: Record<string, unknown> }
    | { method: 'POST'; route: string; body?: Record<string, unknown> };

function patch(v: number, entry: Record<string, unknown>): Wire {
    return { method: 'PATCH', body: { expectedVersion: v, phases: [entry] } };
}

const withArtifacts = (artifacts: Artifacts | undefined) => (artifacts ? { artifacts } : {});

type PlaybookLike = Pick<Playbook, 'version' | 'phases'>;
type Of<T extends PlaybookEvent['type']> = Extract<PlaybookEvent, { type: T }>;

function startWire(event: Of<'start'>, pb: PlaybookLike): Wire {
    const phase = phaseByKey(pb.phases, event.key);
    if (SERVER_RUN.has(kindOf(phase) || event.key)) return { method: 'POST', route: `phases/${event.key}/run` };
    return patch(pb.version, { key: event.key, status: 'running', ...withArtifacts(event.artifacts) });
}

function landedWire(event: Of<'finished' | 'markDone'>, pb: PlaybookLike): Wire {
    return patch(pb.version, { key: event.key, status: 'awaiting', ...(event.summary ? { summary: event.summary } : {}), ...withArtifacts(event.artifacts) });
}

/** Confirm a phase; an edited brief for the next one lands in the same write. */
function continueWire(event: Of<'continue'>, pb: PlaybookLike): Wire {
    const entries: Record<string, unknown>[] = [{ key: event.key, status: 'done' }];
    if (event.nextKey && typeof event.brief === 'string') entries.push({ key: event.nextKey, brief: event.brief });
    return { method: 'PATCH', body: { expectedVersion: pb.version, phases: entries } };
}

const WIRES: { [T in PlaybookEvent['type']]: (event: Of<T>, pb: PlaybookLike) => Wire } = {
    start: startWire,
    artifact: (e, pb) => patch(pb.version, { key: e.key, artifacts: e.artifacts || {} }),
    finished: landedWire,
    markDone: landedWire,
    failed: (e, pb) => patch(pb.version, { key: e.key, status: 'failed', error: e.error || 'failed' }),
    continue: continueWire,
    // A landed design redrawn with what the person asks for: the same phase
    // doing its work again, so no status changes.
    revise: (e) => ({ method: 'POST', route: `phases/${e.key}/run`, body: { feedback: String(e.feedback || '') } }),
    skip: (e, pb) => ({ method: 'POST', route: `phases/${e.key}/skip`, body: { expectedVersion: pb.version } }),
    retry: (e, pb) => ({ method: 'POST', route: `phases/${e.key}/retry`, body: { expectedVersion: pb.version } }),
    stop: (_e, pb) => ({ method: 'PATCH', body: { expectedVersion: pb.version, status: 'stopped' } }),
    resume: (_e, pb) => ({ method: 'PATCH', body: { expectedVersion: pb.version, status: 'active' } }),
};

/** What an event sends: a CAS PATCH, a POST to a phase route, or nothing. */
export function patchFor(event: PlaybookEvent | null | undefined, playbook: PlaybookLike | null | undefined): Wire | null {
    if (!event || !playbook || !Object.prototype.hasOwnProperty.call(WIRES, event.type)) return null;
    const build = WIRES[event.type] as (e: PlaybookEvent, pb: PlaybookLike) => Wire;
    return build(event, playbook);
}

/** The optimistic step each event takes, if any. */
export const OPTIMISTIC: Readonly<Partial<Record<PlaybookEvent['type'], OptimisticKind>>> = Object.freeze({
    start: 'started',
    artifact: 'artifacts',
    finished: 'finished',
    markDone: 'finished',
    failed: 'failed',
    continue: 'done',
    skip: 'skipped',
});

/** Is a server-run phase working right now? That is when the page polls. */
export function isPolling(playbook: Pick<Playbook, 'status' | 'phases'> | null | undefined): boolean {
    return !!playbook && playbook.status === 'active'
        && playbook.phases.some((p) => SERVER_RUN.has(kindOf(p) ?? '') && p.status === 'running');
}
