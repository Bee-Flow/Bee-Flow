/**
 * The client's half of the Playbook state machine — pure.
 *
 * The SERVER decides every transition (routes/playbooks.js); this module only
 * answers "what is the page doing now, what may the person press, and what
 * exactly does each press send". Keeping the wire bodies here means the run
 * page's tests can assert them without a network.
 */

export const PHASE_ORDER = Object.freeze(['table', 'automation', 'fill', 'app', 'approvals']); // the built-in recipe's keys
export const KINDS = Object.freeze(['table', 'automation', 'fill', 'design', 'app', 'app_turn', 'access', 'compliance']); // what a stage can be
export const SERVER_RUN = new Set(['table', 'fill', 'design', 'compliance']);    // POST …/phases/<key>/run, then poll
export const CLIENT_RUN = new Set(['automation', 'app', 'app_turn', 'access']); // a builder (or the person) works here; the page PATCHes

/** A phase's KIND decides its stage; rows from before recipe documents carry the key only. */
export function kindOf(phase) {
    if (!phase) return null;
    if (phase.kind) return phase.kind;
    return phase.key === 'approvals' ? 'app_turn' : phase.key;
}
export const TERMINAL = new Set(['done', 'skipped', 'locked']);
export const ACTIONABLE = new Set(['ready', 'running', 'awaiting', 'failed']);

export function phaseByKey(phases, key) {
    return (Array.isArray(phases) ? phases : []).find((p) => p && p.key === key) || null;
}

/** The phase the page acts on now: the first one not yet done, in order. */
export function nextActionable(phases) {
    const list = Array.isArray(phases) ? phases : [];
    return list.find((p) => p && ACTIONABLE.has(p.status)) || null;
}

/** The phase after `afterKey` that is not terminal — the one whose brief the handoff card edits. */
export function nextPending(phases, afterKey) {
    const list = Array.isArray(phases) ? phases : [];
    const i = list.findIndex((p) => p && p.key === afterKey);
    for (let j = i + 1; j < list.length; j++) if (list[j] && !TERMINAL.has(list[j].status)) return list[j];
    return null;
}

export function isComplete(phases) {
    const list = Array.isArray(phases) ? phases : [];
    return list.length > 0 && list.every((p) => TERMINAL.has(p.status));
}

export function progress(phases) {
    const list = Array.isArray(phases) ? phases : [];
    return {
        done: list.filter((p) => p.status === 'done' || p.status === 'skipped').length,
        total: list.length,
        locked: list.filter((p) => p.status === 'locked').length,
    };
}

export function canContinue(phases) {
    const waiting = (Array.isArray(phases) ? phases : []).find((p) => p && p.status === 'awaiting');
    if (!waiting) return false;
    const next = nextPending(phases, waiting.key);
    return !next || next.status === 'ready' || next.status === 'pending';
}

export function canRetry(phase) { return !!phase && phase.status === 'failed'; }

/**
 * Never the table — every later brief is built on it.
 *
 * A RUNNING phase can be skipped whatever runs it. The server has always
 * allowed `running → skipped` (lifecycle.js), but this only offered it for the
 * client-run kinds, so a server phase wedged on a model that never answered had
 * no way out at all: Retry needs `failed`, and `running → ready` is illegal.
 */
export function canSkip(phase) {
    if (!phase || kindOf(phase) === 'table') return false;
    return ['ready', 'running', 'awaiting', 'failed', 'locked'].includes(phase.status);
}

/**
 * Optimistic application of a client event, so the rail moves before the
 * server answers. The server's response then replaces the whole entity.
 * result.kind: started | artifacts | finished | failed | needs_input | skipped | done
 */
export function applyPhaseResult(phases, key, result) {
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
export function patchFor(event, playbook) {
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
            const entries = [{ key: event.key, status: 'done' }];
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
