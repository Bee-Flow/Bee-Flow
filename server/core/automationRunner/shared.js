/**
 * Shared constants, run-state helpers and DAG-traversal primitives for the
 * automation engine (extracted verbatim from engine.js). Leaf relative to
 * every executor module: nothing here requires another engine module.
 */

// Feature C — http_request credential injection. MASK_VALUES is the Symbol-
// keyed mask array on runState: unreachable from templates/exprs/code steps
// (bind.js walks string paths only), folded into secretValuesFor below.
const { MASK_VALUES } = require('./httpAuth');

const RUNNER_INTERVAL_MS = 60_000;
const POLLING_INTERVAL_MS = 30_000;
const REAPER_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000; // §WS3.1 run-history retention sweep
const MAX_CONCURRENT = 5;
// Max depth of nested layer (sub-automation) calls. A → B → C ... up to 8
// levels. Bounds stack growth and runaway expansion; generous for any
// human-authored composition. Cycles (A → B → A) are caught separately via
// ctx.layerStack regardless of depth.
const MAX_LAYER_DEPTH = 8;
// Default per-run timeout. Automations can override per-row via
// `automations.run_timeout_ms` (capped at MAX_RUN_TIMEOUT_MS). A long-
// running automation that legitimately needs more than five minutes can
// raise its own ceiling without bumping the global default.
const RUN_HARD_TIMEOUT_MS = 5 * 60_000;
const MAX_RUN_TIMEOUT_MS = 60 * 60_000;
// Reaper window is computed per-row in SQL: max(floor, run_timeout_ms + buffer).
// Floor protects rows with no timeout override; buffer keeps the runner's
// own timeout from racing the reaper for the same row.
const REAPER_FLOOR_MS = 6 * 60_000;
const REAPER_BUFFER_MS = 60_000;
const REAPER_MAX_ATTEMPTS = 5;
// §WS2.2 — approval deadline. A run paused at an approval step expires after
// this window if no decision is made; the reaper then flips it to error
// (ApprovalExpired) so paused runs don't accumulate forever. A step may shorten
// it via step.approval.expiresInHours / step.approval.expiresInMs, capped at the
// max. Set AUTOMATION_APPROVAL_TTL_MS=0 to disable expiry entirely.
const APPROVAL_DEFAULT_TTL_MS = (() => {
    const env = parseInt(process.env.AUTOMATION_APPROVAL_TTL_MS, 10);
    return Number.isFinite(env) ? env : 7 * 24 * 60 * 60_000; // 7 days
})();
const APPROVAL_MAX_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

// Resolve the approval deadline (ms from now) for an approval step, or null when
// expiry is disabled. Per-step override is clamped to [0, APPROVAL_MAX_TTL_MS].
function resolveApprovalTtlMs(step) {
    const a = (step && step.approval) || {};
    const fromMs = Number.isFinite(a.expiresInMs) ? a.expiresInMs : null;
    const fromHours = Number.isFinite(a.expiresInHours) ? a.expiresInHours * 3600_000
        : (Number.isFinite(step?.expiresInHours) ? step.expiresInHours * 3600_000 : null);
    const chosen = fromMs ?? fromHours ?? APPROVAL_DEFAULT_TTL_MS;
    if (!Number.isFinite(chosen) || chosen <= 0) return null; // disabled
    return Math.min(chosen, APPROVAL_MAX_TTL_MS);
}
// WS5.4 — hard ceiling on collection-op input size (filter/limit/dedupe/
// aggregate/summarize). execFilter runs evaluate() per item and execDedupe
// JSON.stringifies per item, so an unbounded upstream array pins the event
// loop for the whole pod. Per-step `maxItems` may tighten but never raise it.
const COLLECTION_OP_MAX_ITEMS = parseInt(process.env.AUTOMATION_COLLECTION_MAX_ITEMS, 10) || 10_000;

function clampRunTimeout(automation) {
    const ms = automation?.runTimeoutMs;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return RUN_HARD_TIMEOUT_MS;
    return Math.min(ms, MAX_RUN_TIMEOUT_MS);
}

// Deep-clone for run-state and step outputs. Without this, an object output
// stored in `runState.steps[...]` is shared by reference with downstream
// steps' inputs; if one mutates the object, every later binding to the same
// step's output sees the mutated value, and a resume / partial-run loaded
// from `replayState` corrupts the persisted run row on subsequent partial
// executions.
function cloneRunValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

// WS5.2 — secret values in flight for this run, handed to every
// recordRunStep call so the persistence chokepoint can exact-match-mask
// them in recorded input/output/error. Computed at record time (not run
// start) because secret bridges populate runState.secrets mid-run. Empty
// strings are dropped — as mask needles they'd match everywhere.
// The Symbol-keyed MASK_VALUES array (http_request credential injection)
// folds in here so every existing recordRunStep call site masks injected
// header/token values with zero call-site changes.
function secretValuesFor(runState) {
    return [...Object.values(runState?.secrets || {}), ...(runState?.[MASK_VALUES] || [])]
        .filter(v => typeof v === 'string' && v);
}

// ── DAG traversal helpers ───────────────────────────────

/**
 * True when a tool result is "empty" by the conventions of our integration
 * tools — used by the dry-run fallback so the AI gets a sample shape to
 * bind against instead of binding to undefined keys on an empty object.
 */
function isEmptyToolResult(result) {
    if (result == null) return true;
    if (typeof result === 'string') return result.trim().length === 0;
    if (Array.isArray(result)) return result.length === 0;
    if (typeof result !== 'object') return false;
    if (result.error) return false; // already an error path
    const arrayKeys = ['results', 'items', 'events', 'messages', 'tasks', 'cards', 'notes', 'rows'];
    for (const k of arrayKeys) {
        if (Array.isArray(result[k]) && result[k].length === 0) return true;
    }
    if (typeof result.total === 'number' && result.total === 0) return true;
    if (typeof result.count === 'number' && result.count === 0) return true;
    return false;
}

// A tool that returns a soft `{ error }` object — the cross-integration
// convention for "this failed but didn't throw" (see the `result.error`
// carve-out in isEmptyToolResult above) — must FAIL the step rather than be
// recorded as a successful output. Without this, a misconfigured step (e.g. a
// Talk send with no room token, or a lapsed credential) reports green while
// doing nothing.
function isToolErrorResult(result) {
    return !!result
        && typeof result === 'object'
        && !Array.isArray(result)
        && !!result.error;
}

/**
 * Is this soft tool error about the ENVIRONMENT rather than about the step?
 *
 * The distinction decides what a DRY RUN does with it: an app this workspace
 * has not connected, or cannot reach, still yields a sample so the builder can
 * plan against a realistic shape; anything else — a missing required input, an
 * unknown column, a bad id — fails the step, because a green dry run on a step
 * that cannot run is worse than no dry run at all.
 *
 * Deliberately a phrase list and not a status code: these errors are RETURNED
 * strings from a dozen different integrations, and most never carry a status.
 * Unmatched text is treated as the step's own fault, which is the safe way
 * round — it fails loudly instead of passing quietly.
 */
const ENVIRONMENT_TOOL_ERROR_RE = new RegExp([
    'not connected', 'no (nextcloud|google|microsoft|slack)? ?(account|connection)',
    'not author(is|iz)ed', 'unauthori[sz]ed', 'permission denied', 'forbidden',
    'session (has )?expired', 're-?authenticate', 'token (refresh|expired|is invalid)',
    'could not reach', 'unreachable', 'is not installed', 'is disabled',
    'no access token', 'credentials? (are )?(missing|invalid)', 'connect .* in settings',
].join('|'), 'i');

function isEnvironmentToolError(message) {
    return typeof message === 'string' && ENVIRONMENT_TOOL_ERROR_RE.test(message);
}

// Enrich a Nextcloud tool failure with a human-readable message + a stable
// error_class — SURFACING ONLY. It reads the error that already bubbled up
// and rewrites the message to "<what happened> — <what to do>", stashing the
// raw text + classification on the error for run history. It does NOT change
// how Nextcloud connects or how auth is resolved. Non-Nextcloud errors and
// classifier failures pass through untouched.
function enrichNextcloudError(toolName, err, rawText) {
    if (!err || !toolName || !String(toolName).startsWith('nextcloud_')) return err;
    try {
        const { classifyNextcloudError } = require('../integrations/nextcloudErrorClassifier');
        const c = classifyNextcloudError(rawText != null ? rawText : err);
        err.ncRawMessage = err.message;
        err.ncError = { code: c.code, category: c.category, remediation: c.remediation };
        err.errorClass = c.errorClass;
        err.message = `${c.message} — ${c.remediation}`;
    } catch (_) { /* never let classification break the run */ }
    return err;
}

function buildAdjacency(def) {
    const adj = new Map();
    const incoming = new Map();
    const stepById = new Map();
    if (def.trigger?.id) stepById.set(def.trigger.id, def.trigger);
    // Additional webhook/app_event triggers (definition.triggers[] — see
    // automation/validate.js) are alternate ROOTS: a run seeded from one of
    // their ids (via runDag's rootStepId option) needs stepById to resolve
    // them just like the primary trigger.
    for (const t of (def.triggers || [])) if (t?.id) stepById.set(t.id, t);
    for (const s of (def.steps || [])) stepById.set(s.id, s);
    for (const e of (def.edges || [])) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e);
        if (!incoming.has(e.to)) incoming.set(e.to, []);
        incoming.get(e.to).push(e);
    }
    return { adj, incoming, stepById };
}

/**
 * Return outgoing edges from a step, optionally filtered by edge label.
 *
 * `label === null/undefined`  → every outgoing edge (legacy traversal).
 * `label === 'on_success'`    → edges explicitly labelled 'on_success'
 *                               PLUS unlabeled edges (back-compat: an
 *                               edge without a label fires on success).
 * Any other label             → exact match only.
 *
 * The back-compat carve-out for 'on_success' means existing automations
 * (which never set edge.label) keep working without migration. New
 * routines can opt into explicit success/error/complete branches and
 * have them routed by §19's edge semantics.
 */
/**
 * The label an edge routes on, normalising the two persisted shapes: writers
 * historically stamped `label: 'case:vip'` + `caseName: 'vip'`, label-only,
 * or caseName-ONLY. validate.js and the canvas accept all three, but routing
 * used to read `e.label` alone — a caseName-only edge validated green, drew
 * from the right port, and then never fired (node-audit A3). When both are
 * present, `label` wins (every current writer keeps them in sync).
 */
function effectiveEdgeLabel(e) {
    if (e.label) return e.label;
    if (e.caseName != null) return `case:${e.caseName}`;
    return undefined;
}

function nextEdgesFor(stepId, adj, label = null) {
    const out = adj.get(stepId) || [];
    if (!label) return out;
    if (label === 'on_success') {
        return out.filter(e => { const l = effectiveEdgeLabel(e); return !l || l === 'on_success'; });
    }
    return out.filter(e => effectiveEdgeLabel(e) === label);
}

/**
 * Step types that route by a BRANCH LABEL their executor returns instead of by
 * plain success — `then`/`else` for condition + guard, `case:<name>` for switch.
 *
 * One set, shared by everything that has to know: runDag's live + replay label
 * resolution, buildLinearEdges' synthesized body chains, and the disabled-step
 * pass-through. It exists because the knowledge used to be duplicated as
 * type-name literals in three places and `guard` was only ever added to two of
 * them — so every body step after a guard inside a loop body or a parallel
 * branch got an unlabelled edge that `then` could never match, and the rest of
 * the iteration silently died (node-audit C3, second occurrence). A fourth
 * brancher must not be able to get half-wired the same way.
 */
const BRANCHER_TYPES = new Set(['condition', 'guard', 'switch']);

/**
 * Step types after which NOTHING runs — re-exported, not restated.
 *
 * IMPORTED from the validator's vocabulary module (which is frozen literals
 * with no requires of its own, so this direction costs nothing and cannot
 * cycle). Deliberately NOT the hand-kept copy BRANCHER_TYPES above is: that
 * one is a copy because the VALIDATOR must not pull in the runner, while this
 * is the runner pulling in a literals file — the cheap direction.
 *
 * And the sharing is the whole point. A terminal step that the validator
 * treats as terminal and the runner walks past would let a routine carry on
 * after it had already told the app it was finished. See the header on
 * TERMINAL_STEP_TYPES in automation/validate/constants.js for the full list of
 * places that have to agree.
 */
const { TERMINAL_STEP_TYPES } = require('../../automation/validate/constants');

// Synthetic root ids for the sub-DAGs a loop body / parallel branch is run as.
// Named constants because the id has to agree in TWO places per caller (the
// synthesized `trigger.id` and the first edge buildLinearEdges emits) and a
// silent disagreement executes zero steps while still reporting success.
const LOOP_ROOT_ID = '__loop_root__';
const PARALLEL_ROOT_ID = '__parallel_root__';

// Step types whose output is a re-shaped SUBSET of data that was already
// scanned upstream — reordering, cutting down or summing rows can't introduce
// personal data that wasn't in the input. The builder-only output rescan skips
// them (BFSF-359): on an 8k-row window the rescan cost seconds per node while
// producing, by construction, the same finding the source step already
// recorded. Anything that can INTRODUCE new content (ai_step, code,
// integration_action, http_request, parse_json, …) is deliberately absent.
const PII_RESCAN_EXEMPT_TYPES = new Set(['limit', 'filter', 'dedupe', 'aggregate', 'set']);

// ── Dry-run synthetic-input taint tracking ──────────────
//
// Dry-runs execute READ tools for real so the builder sees genuine data —
// but only when their inputs are real. An input derived from synthesized
// data (a simulated side-effect's sample, a read that fell back to its
// sample, a synthetic app_event trigger payload) is fake: dispatching it
// live guarantees a provider error per call (e.g. gmail_read with a sample
// messageId → "Invalid id value" × N forEach items). Taint is tracked at
// the binding-root level: steps.<id> whose runState record is marked
// `synthesised`, `trigger` when ctx.triggerSynthetic, and loop vars whose
// source array was tainted (propagated by execForEachStep / execLoop).

/** True when a binding path's ROOT resolves to synthesized dry-run data. */
function refIsSynthetic(path, runState, ctx) {
    const p = String(path || '').trim();
    if (/^trigger\b/.test(p)) return !!ctx.triggerSynthetic;
    let m = p.match(/^steps\.([A-Za-z0-9_-]+)/);
    if (m) return !!(runState.steps && runState.steps[m[1]] && runState.steps[m[1]].synthesised);
    m = p.match(/^loop\.([A-Za-z0-9_]+)/);
    if (m) return !!(runState._syntheticLoopVars && runState._syntheticLoopVars[m[1]]);
    return false; // vars / secrets are design-time values → real
}

/** Collect every binding path referenced by a step's inputs (ref paths, {{template}} bodies, expr tokens). */
function collectBindingPaths(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) { for (const v of value) collectBindingPaths(v, out); return out; }
    if (typeof value.kind === 'string') {
        if (value.kind === 'ref' && typeof value.path === 'string') out.push(value.path);
        else if ((value.kind === 'template' || value.kind === 'expr') && typeof value.value === 'string') {
            for (const m of value.value.matchAll(/(trigger|steps\.[A-Za-z0-9_-]+|loop\.[A-Za-z0-9_]+)\b/g)) out.push(m[0]);
        }
        return out;
    }
    for (const v of Object.values(value)) collectBindingPaths(v, out);
    return out;
}

/** True when ANY of the step's bound inputs derives from synthesized data. */
function stepInputsSynthetic(step, runState, ctx) {
    return collectBindingPaths(step.inputs || {}).some(p => refIsSynthetic(p, runState, ctx));
}

module.exports = {
    RUNNER_INTERVAL_MS, POLLING_INTERVAL_MS, REAPER_INTERVAL_MS, RETENTION_INTERVAL_MS,
    MAX_CONCURRENT, MAX_LAYER_DEPTH, RUN_HARD_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS,
    REAPER_FLOOR_MS, REAPER_BUFFER_MS, REAPER_MAX_ATTEMPTS,
    APPROVAL_DEFAULT_TTL_MS, APPROVAL_MAX_TTL_MS, resolveApprovalTtlMs,
    COLLECTION_OP_MAX_ITEMS, clampRunTimeout, cloneRunValue, secretValuesFor,
    isEmptyToolResult, isToolErrorResult, isEnvironmentToolError, enrichNextcloudError,
    buildAdjacency, effectiveEdgeLabel, nextEdgesFor,
    BRANCHER_TYPES, TERMINAL_STEP_TYPES, LOOP_ROOT_ID, PARALLEL_ROOT_ID, PII_RESCAN_EXEMPT_TYPES,
    refIsSynthetic, collectBindingPaths, stepInputsSynthetic,
};
