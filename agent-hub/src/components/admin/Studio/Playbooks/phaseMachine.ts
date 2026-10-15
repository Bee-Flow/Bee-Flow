/**
 * The client's half of the Playbook state machine — pure.
 *
 * The SERVER decides every transition (routes/playbooks.js); this module only
 * answers "what is the page doing now, what may the person press, and what
 * exactly does each press send". Keeping the wire bodies here means the run
 * page's tests can assert them without a network.
 */

/** A column of the playbook's table, as the table phase stores it. */
export interface ArtifactField {
    key: string;
    name?: string;
    type?: string;
}

/** What the design phase stored: the designer's answer. */
export interface DesignElement {
    kind?: string;
    label?: string;
    note?: string;
}

export interface DesignSection {
    title?: string;
    layout: string;
    elements: DesignElement[];
}

export interface DesignScreen {
    name?: string;
    purpose?: string;
    sections: DesignSection[];
}

export interface DesignSpec {
    name?: string;
    tagline?: string;
    look: { preset?: string; mood?: string; accent?: string };
    screens?: DesignScreen[];
    principles?: string[];
}

/** Everything the phases store on `phase.artifacts` (each phase fills its own part). */
export interface PhaseArtifacts {
    datatableId?: string | number;
    datatableName?: string;
    datatableKey?: string;
    rowCount?: number;
    rowsBefore?: number;
    fields?: ArtifactField[];
    mapping?: Record<string, string>;
    hasStatus?: boolean;
    isMirror?: boolean;
    automationId?: string;
    automationTitle?: string;
    runId?: string;
    runStatus?: string;
    design?: DesignSpec;
    designName?: string;
    revisions?: string[];
    screenCount?: number;
    elementCount?: number;
    appId?: string;
    appName?: string;
    briefSentAttempt?: number;
    briefSentAt?: string;
    accessApplied?: boolean;
    frameworks?: string[];
    findings?: unknown[];
    [extra: string]: unknown;
}

/** One phase of a playbook, as the API returns it. */
export interface Phase {
    key: string;
    kind?: string;
    status: string;
    attempt?: number;
    requires?: string;
    label?: string;
    brief?: string;
    startedAt?: string;
    finishedAt?: string;
    needsInput?: boolean;
    summary?: string;
    error?: string;
    artifacts?: PhaseArtifacts;
    _optimistic?: boolean;
    [extra: string]: unknown;
}

/** A playbook, as far as the state machine reads it. */
export interface PlaybookLike {
    id?: string;
    version?: number;
    status?: string;
    phases?: Phase[];
    [extra: string]: unknown;
}

/** What a stage tells the page: the optimistic result of a phase. */
export interface PhaseResult {
    kind?: string;
    artifacts?: PhaseArtifacts;
    summary?: string;
    error?: string;
}

/** An event that names a phase. */
export interface KeyedPlaybookEvent {
    type: 'start' | 'artifact' | 'finished' | 'markDone' | 'failed' | 'continue' | 'revise' | 'skip' | 'retry' | 'needs_input' | 'dismiss_input';
    key: string;
    brief?: string;
    artifacts?: PhaseArtifacts;
    summary?: string;
    error?: string;
    nextKey?: string;
    feedback?: unknown;
    extra?: Record<string, unknown>;
}

/** An event for the playbook as a whole (stop/resume) or one that hands over the server's answer. */
export interface WholePlaybookEvent {
    type: 'stop' | 'resume' | 'replace';
    key?: undefined;
    playbook?: PlaybookLike;
}

export type PlaybookEvent = KeyedPlaybookEvent | WholePlaybookEvent;

/** What an event sends: the CAS write or a server-run route. */
export interface WireRequest {
    method: 'PATCH' | 'POST';
    route?: string;
    body?: Record<string, unknown>;
}

export const PHASE_ORDER = Object.freeze(['table', 'automation', 'fill', 'app', 'approvals']); // the built-in recipe's keys
export const KINDS = Object.freeze(['table', 'automation', 'fill', 'design', 'app', 'app_turn', 'access', 'compliance']); // what a stage can be
export const SERVER_RUN = new Set<string | null>(['table', 'fill', 'design', 'compliance']);    // POST …/phases/<key>/run, then poll
export const CLIENT_RUN = new Set<string | null>(['automation', 'app', 'app_turn', 'access']); // a builder (or the person) works here; the page PATCHes

/** A phase's KIND decides its stage; rows from before recipe documents carry the key only. */
export function kindOf(phase: Phase | null | undefined): string | null {
    if (!phase) return null;
    if (phase.kind) return phase.kind;
    return phase.key === 'approvals' ? 'app_turn' : phase.key;
}
export const TERMINAL = new Set<string>(['done', 'skipped', 'locked']);
export const ACTIONABLE = new Set<string>(['ready', 'running', 'awaiting', 'failed']);

export function phaseByKey(phases: Phase[] | null | undefined, key: string | undefined): Phase | null {
    return (Array.isArray(phases) ? phases : []).find((p) => p && p.key === key) || null;
}

/** The phase the page acts on now: the first one not yet done, in order. */
export function nextActionable(phases: Phase[] | null | undefined): Phase | null {
    const list = Array.isArray(phases) ? phases : [];
    return list.find((p) => p && ACTIONABLE.has(p.status)) || null;
}

/** The phase after `afterKey` that is not terminal — the one whose brief the handoff card edits. */
export function nextPending(phases: Phase[] | null | undefined, afterKey: string): Phase | null {
    const list = Array.isArray(phases) ? phases : [];
    const i = list.findIndex((p) => p && p.key === afterKey);
    for (let j = i + 1; j < list.length; j++) if (list[j] && !TERMINAL.has(list[j].status)) return list[j];
    return null;
}

export function isComplete(phases: Phase[] | null | undefined): boolean {
    const list = Array.isArray(phases) ? phases : [];
    return list.length > 0 && list.every((p) => TERMINAL.has(p.status));
}

export function progress(phases: Phase[] | null | undefined): { done: number; total: number; locked: number } {
    const list = Array.isArray(phases) ? phases : [];
    return {
        done: list.filter((p) => p.status === 'done' || p.status === 'skipped').length,
        total: list.length,
        locked: list.filter((p) => p.status === 'locked').length,
    };
}

export function canContinue(phases: Phase[] | null | undefined): boolean {
    const waiting = (Array.isArray(phases) ? phases : []).find((p) => p && p.status === 'awaiting');
    if (!waiting) return false;
    const next = nextPending(phases, waiting.key);
    return !next || next.status === 'ready' || next.status === 'pending';
}

export function canRetry(phase: Phase | null | undefined): boolean { return !!phase && phase.status === 'failed'; }

/**
 * Never the table — every later brief is built on it.
 *
 * A RUNNING phase can be skipped whatever runs it. The server has always
 * allowed `running → skipped` (lifecycle.js), but this only offered it for the
 * client-run kinds, so a server phase wedged on a model that never answered had
 * no way out at all: Retry needs `failed`, and `running → ready` is illegal.
 */
export function canSkip(phase: Phase | null | undefined): boolean {
    if (!phase || kindOf(phase) === 'table') return false;
    return ['ready', 'running', 'awaiting', 'failed', 'locked'].includes(phase.status);
}

/**
 * Optimistic application of a client event, so the rail moves before the
 * server answers. The server's response then replaces the whole entity.
 * result.kind: started | artifacts | finished | failed | needs_input | skipped | done
 */
export function applyPhaseResult(phases: Phase[] | null | undefined, key: string | undefined, result: PhaseResult): Phase[] {
    const now = new Date().toISOString();
    return (Array.isArray(phases) ? phases : []).map((p) => {
        if (!p || p.key !== key) return p;
        switch (result && result.kind) {
            // `_optimistic` marks a running status the server has not confirmed yet
            // (the response replaces the entity and drops it); a stage that must
            // mount only AFTER the PATCH landed waits for it to clear.
            case 'started': return { ...p, status: 'running', startedAt: p.startedAt || now, needsInput: false, _optimistic: true };
            case 'artifacts': return { ...p, artifacts: { ...(p.artifacts || {}), ...(result.artifacts || {}) } };
            case 'finished': return { ...p, status: 'awaiting', finishedAt: now, needsInput: false, summary: result.summary || p.summary, artifacts: { ...(p.artifacts || {}), ...(result.artifacts || {}) } };
            case 'failed': return { ...p, status: 'failed', finishedAt: now, needsInput: false, error: result.error || p.error };
            case 'needs_input': return { ...p, needsInput: true };
            case 'dismiss_input': return { ...p, needsInput: false };
            case 'skipped': return { ...p, status: 'skipped', finishedAt: now };
            case 'done': return { ...p, status: 'done', finishedAt: p.finishedAt || now };
            default: return p;
        }
    });
}

/**
 * What a client event sends. Returns { method: 'PATCH', body } for the CAS
 * write, { method: 'POST', route } for the server-run routes, or null when
 * the event has no wire form (e.g. needs_input — a page-local flag).
 * event: { type, key?, brief?, artifacts?, summary?, error?, nextKey? }; stop/resume carry no key
 */
export function patchFor(event: PlaybookEvent | null | undefined, playbook: PlaybookLike | null | undefined): WireRequest | null {
    if (!event || !playbook) return null;
    const v = playbook.version;
    switch (event.type) {
        case 'start': {
            const phase = phaseByKey(playbook.phases, event.key);
            if (SERVER_RUN.has(kindOf(phase) || event.key)) return { method: 'POST', route: `phases/${event.key}/run` };
            return { method: 'PATCH', body: { expectedVersion: v, phases: [{ key: event.key, status: 'running', ...(event.artifacts ? { artifacts: event.artifacts } : {}) }] } };
        }
        case 'artifact':
            return { method: 'PATCH', body: { expectedVersion: v, phases: [{ key: event.key, artifacts: event.artifacts || {} }] } };
        case 'finished':
        case 'markDone':
            return { method: 'PATCH', body: { expectedVersion: v, phases: [{ key: event.key, status: 'awaiting', ...(event.summary ? { summary: event.summary } : {}), ...(event.artifacts ? { artifacts: event.artifacts } : {}) }] } };
        case 'failed':
            return { method: 'PATCH', body: { expectedVersion: v, phases: [{ key: event.key, status: 'failed', error: event.error || 'failed' }] } };
        case 'continue': {
            const entries: Array<{ key: string; status?: string; brief?: string }> = [{ key: event.key, status: 'done' }];
            if (event.nextKey && typeof event.brief === 'string') entries.push({ key: event.nextKey, brief: event.brief });
            return { method: 'PATCH', body: { expectedVersion: v, phases: entries } };
        }
        // A design that landed, redrawn with what the person asks for. It is
        // the same phase doing the same work again — no status changes, so
        // there is no transition to ask for; the server answers with the new
        // design and the app's brief recomposed around it.
        case 'revise':
            return { method: 'POST', route: `phases/${event.key}/run`, body: { feedback: String(event.feedback || '') } };
        case 'skip':
            return { method: 'POST', route: `phases/${event.key}/skip`, body: { expectedVersion: v } };
        case 'retry':
            return { method: 'POST', route: `phases/${event.key}/retry`, body: { expectedVersion: v } };
        case 'stop':
            return { method: 'PATCH', body: { expectedVersion: v, status: 'stopped' } };
        case 'resume':
            return { method: 'PATCH', body: { expectedVersion: v, status: 'active' } };
        default:
            return null;
    }
}
