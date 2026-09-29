/**
 * The phase state machine of a Playbook — pure.
 *
 * A phase is `pending` until its predecessor is done or skipped (then
 * `ready`), `running` while a builder or the server works on it, `awaiting`
 * when it landed and the user has to say "go on" (the handoff card),
 * `done` after that consent, `failed` when it could not land (retry → ready),
 * `skipped` by the user, `locked` when the plan lacks the capability. The
 * server owns every transition; the client asks for them.
 */

'use strict';

const PHASE_STATUSES = Object.freeze(['pending', 'ready', 'running', 'awaiting', 'done', 'failed', 'skipped', 'locked']);
const TERMINAL = new Set(['done', 'skipped', 'locked']);

const TRANSITIONS = Object.freeze({
    pending: ['ready', 'locked', 'skipped'],
    ready: ['running', 'skipped', 'locked'],
    running: ['awaiting', 'failed', 'skipped'],
    awaiting: ['done', 'failed', 'skipped'],
    // `failed → awaiting`: a builder phase keeps its shell mounted after a
    // failure (RoutineStage, AppStage), so the person carries on in the chat and
    // the builder finalises — and that finalize used to 409 for ever. The
    // awaiting gate in routes/playbooks.js re-verifies the owner and that the
    // routine is no longer a draft, so nothing half-built lands this way.
    failed: ['ready', 'skipped', 'awaiting'],
    skipped: ['ready'],
    locked: ['skipped', 'ready'],
    done: [],
});

function canTransition(from, to) {
    return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function phaseByKey(phases, key) {
    return (Array.isArray(phases) ? phases : []).find((p) => p && p.key === key) || null;
}

/**
 * A new phases array with `key` moved to `to` (+ patch). Stamps startedAt on
 * running, finishedAt on awaiting/failed/skipped/done. Throws on an illegal
 * transition so the route can answer 409 with both ends named.
 */
function applyTransition(phases, key, to, patch = {}, now = new Date().toISOString()) {
    const cur = phaseByKey(phases, key);
    if (!cur) { const e = new Error(`unknown phase ${key}`); e.code = 'unknown_phase'; throw e; }
    if (!canTransition(cur.status, to)) {
        const e = new Error(`phase ${key} cannot go from ${cur.status} to ${to}`);
        e.code = 'illegal_transition'; e.from = cur.status; e.to = to;
        throw e;
    }
    const stamps = {};
    if (to === 'running') { stamps.startedAt = now; stamps.finishedAt = null; }
    if (to === 'awaiting' || to === 'failed' || to === 'skipped' || to === 'done') stamps.finishedAt = now;
    if (to === 'ready') { stamps.finishedAt = null; }
    return phases.map((p) => (p.key === key
        ? { ...p, ...patch, ...stamps, status: to, artifacts: { ...(p.artifacts || {}), ...((patch && patch.artifacts) || {}) } }
        : p));
}

/** The phase after `key` that is not terminal, or null. */
function nextPhaseKey(phases, key) {
    const list = Array.isArray(phases) ? phases : [];
    const i = list.findIndex((p) => p && p.key === key);
    for (let j = i + 1; j < list.length; j++) {
        if (list[j] && !TERMINAL.has(list[j].status)) return list[j].key;
    }
    return null;
}

/**
 * Consent on `key` (awaiting → done) and the next non-terminal phase becomes
 * ready. Returns the new array and the key that is ready now (null when the
 * playbook is complete).
 */
function advance(phases, key, now) {
    let out = applyTransition(phases, key, 'done', {}, now);
    const nextKey = nextPhaseKey(out, key);
    if (nextKey) {
        const next = phaseByKey(out, nextKey);
        if (next.status === 'pending' || next.status === 'failed' || next.status === 'skipped') out = applyTransition(out, nextKey, 'ready', {}, now);
    }
    return { phases: out, nextKey };
}

/** 'done' when nothing is left to do, else 'active'. */
function playbookStatus(phases) {
    const list = Array.isArray(phases) ? phases : [];
    return list.length && list.every((p) => TERMINAL.has(p.status)) ? 'done' : 'active';
}

/** The first phase the user or the machine acts on next. */
function currentPhaseKey(phases) {
    const list = Array.isArray(phases) ? phases : [];
    const hit = list.find((p) => p && !TERMINAL.has(p.status));
    return hit ? hit.key : null;
}

/**
 * The brief a phase runs on, composed from the recipe with the playbook's
 * REAL artifacts. null for phases the server runs (table, fill). Throws when
 * the artifacts a brief needs are not there yet (a routine brief before the
 * table exists) — the route reports that as 409 `artifacts_missing`. Both
 * recipe shapes (the built-in module, a recipe document) answer through
 * `composeBrief(key, { table, options, playbook })`.
 */
function composeBriefFor(recipe, key, playbook) {
    const phases = playbook.phases || [];
    const tablePhase = phases.find((p) => p && (p.kind || p.key) === 'table') || null;
    const table = tablePhase && tablePhase.artifacts && tablePhase.artifacts.datatableId ? {
        id: tablePhase.artifacts.datatableId,
        key: tablePhase.artifacts.datatableKey,
        name: tablePhase.artifacts.datatableName,
        mapping: tablePhase.artifacts.mapping || recipe.schemaMapping((playbook.options || {}).locale),
        isMirror: !!tablePhase.artifacts.isMirror,
        hasStatus: tablePhase.artifacts.hasStatus !== false,
    } : null;
    const phase = phaseByKey(phases, key);
    const kind = phase ? (phase.kind || phase.key) : key;
    if (['table', 'fill', 'design', 'access', 'compliance'].includes(kind)) return null;
    if (!table && recipe.hasTable !== false) {
        const e = new Error('the table phase has not produced a table yet');
        e.code = 'artifacts_missing';
        throw e;
    }
    const brief = recipe.composeBrief(key, { table, options: playbook.options || {}, playbook });
    // The app phase carries the DESIGN the designer phase produced, in the
    // builder's words — appended after the brief, never counted in its cap.
    if (brief && kind === 'app') {
        const design = designBefore(phases, key);
        if (design) return `${brief}\n\n${require('./phases/designPhase').designToBrief(design)}`;
    }
    return brief;
}

/** The nearest design phase BEFORE `key` that produced a design. */
function designBefore(phases, key) {
    const list = Array.isArray(phases) ? phases : [];
    const i = list.findIndex((p) => p && p.key === key);
    for (let j = (i < 0 ? list.length : i) - 1; j >= 0; j--) {
        const p = list[j];
        if (p && (p.kind || p.key) === 'design' && p.artifacts && p.artifacts.design) return p.artifacts.design;
    }
    return null;
}

module.exports = {
    PHASE_STATUSES,
    TERMINAL,
    TRANSITIONS,
    canTransition,
    phaseByKey,
    applyTransition,
    nextPhaseKey,
    advance,
    playbookStatus,
    currentPhaseKey,
    composeBriefFor,
    designBefore,
};
