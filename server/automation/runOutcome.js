'use strict';

/**
 * The one-sentence outcome of a run (handoff 5, Runs tab).
 *
 * Written ONCE, when a run finishes or pauses, into automation_runs.outcome_json
 * as `{ code, params, text }`:
 *
 *   code    what happened, from a closed vocabulary the UI translates:
 *           'success' | 'stopped_at' | 'waiting_approval' | 'waiting_form'
 *           | 'waiting_confirm' | 'cancelled'
 *   params  the facts the sentence needs (step label, a count, a folder, ...)
 *   text    the same sentence in English, for a client that does not know the
 *           code yet. Never the only carrier of meaning.
 *
 * Deterministic and pure: no model, no store. The inputs are the rows the run
 * already RECORDED (automation_run_steps, which hold the redacted outputs the
 * owner sees in the run detail) and the definition that ran. So the sentence
 * can only ever say what the run detail already shows to the same people; it
 * never reads the live, unredacted run state.
 *
 * `resolveRunOutcome` is the async wrapper the runner calls: it reads the step
 * rows and the approvers' names through injected lookups, then calls
 * `buildRunOutcome`. Every failure in there degrades to a smaller sentence;
 * an outcome must never take a run down.
 */

const OUTCOME_CODES = Object.freeze([
    'success', 'stopped_at', 'waiting_approval', 'waiting_form', 'waiting_confirm', 'cancelled',
]);

/** Step types that never answer "what did this run do". */
const QUIET_TYPES = new Set(['wait', 'note', 'sticky', 'sticky_note', 'comment', 'trigger']);

/** A step row that finished and produced something a person can read. */
const DONE_STATUSES = new Set(['success', 'pinned']);

const MAX_TEXT = 80;
const MAX_WHERE = 120;
const MAX_FIELDS = 2;
const MAX_WHO = 3;

/** One line, trimmed, capped. Null for anything that is not a usable scalar. */
function clip(value, max = MAX_TEXT) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    if (typeof value !== 'string') return null;
    const s = value.replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function humanize(id) {
    const s = String(id || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/**
 * Every node in a definition by id: the triggers, the top-level steps and
 * anything nested (loop bodies, layers, parallel branches). Generic on
 * purpose: a new container type is found without this file learning it.
 */
function indexDefinition(definition) {
    const byId = new Map();
    const triggerIds = new Set();
    const seen = new Set();
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
        if (typeof node.id === 'string' && (typeof node.type === 'string' || typeof node.kind === 'string')) {
            if (!byId.has(node.id)) byId.set(node.id, node);
        }
        for (const [k, v] of Object.entries(node)) {
            // Values that are data, not nodes: skip them so a pinned sample
            // shaped like a step cannot pose as one.
            if (k === 'pinnedOutput' || k === 'inputs' || k === 'sample' || k === 'vars') continue;
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    };
    const def = definition && typeof definition === 'object' ? definition : {};
    if (def.trigger?.id) triggerIds.add(def.trigger.id);
    for (const t of Array.isArray(def.triggers) ? def.triggers : []) if (t?.id) triggerIds.add(t.id);
    walk(def, 0);
    return { byId, triggerIds };
}

/**
 * The label a person gave a step, else a readable stand-in. Recorded ids of
 * layer sub-steps carry a `parent/child` prefix; the last segment is the node.
 */
function stepLabel(index, stepId, stepType = null) {
    if (!stepId) return null;
    const node = index.byId.get(stepId) || index.byId.get(String(stepId).split('/').pop());
    const named = clip(node?.label) || clip(node?.name) || clip(node?.title);
    if (named) return named;
    if (node?.tool) return humanize(String(node.tool).replace(/^[a-z]+_/, ''));
    return humanize(node?.type || stepType || stepId);
}

/** The last row per step id (the final attempt), in the order steps started. */
function finalRows(steps) {
    const order = [];
    const last = new Map();
    for (const s of Array.isArray(steps) ? steps : []) {
        if (!s || !s.stepId) continue;
        if (!last.has(s.stepId)) order.push(s.stepId);
        const prev = last.get(s.stepId);
        if (!prev || (Number(s.attempts) || 1) >= (Number(prev.attempts) || 1)) last.set(s.stepId, s);
    }
    return order.map(id => last.get(id));
}

const LIST_KEYS = ['files', 'items', 'rows', 'results', 'records', 'entries', 'messages', 'emails', 'mails', 'events', 'cards', 'tasks', 'contacts', 'documents', 'list', 'data'];
const FIELD_KEYS = ['title', 'name', 'subject', 'filename', 'fileName', 'number', 'invoiceNumber', 'reference', 'total', 'amount', 'status'];
const FILE_NAME_KEYS = ['filename', 'fileName', 'name', 'basename'];
const FILE_HINT_KEYS = ['mimeType', 'mimetype', 'mime', 'size', 'path', 'fileId', 'url', 'downloadUrl', 'contentType'];
const WHERE_KEYS = ['path', 'folder', 'folderPath', 'dir', 'directory', 'targetFolder', 'destination'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isTruncated = (v) => isPlainObject(v) && v.__truncated__ === true;

function looksLikeFile(o) {
    if (!isPlainObject(o)) return false;
    const name = FILE_NAME_KEYS.map(k => o[k]).find(v => typeof v === 'string' && v.trim());
    return !!name && FILE_HINT_KEYS.some(k => o[k] != null);
}

function fileNameOf(o) {
    const name = FILE_NAME_KEYS.map(k => o[k]).find(v => typeof v === 'string' && v.trim());
    return clip(String(name).split('/').filter(Boolean).pop() || name);
}

/** What the items of a list are, in one plural English word. */
function nounForItems(items, key = null) {
    const sample = items.find(x => x != null);
    if (isPlainObject(sample)) {
        if (looksLikeFile(sample) || sample.type === 'file' || sample.type === 'folder') return 'files';
        if (sample.subject != null && (sample.from != null || sample.sender != null)) return 'emails';
    }
    if (key && /^[a-z][a-z_]*s$/i.test(key) && key !== 'results' && key !== 'data') return key.toLowerCase();
    return 'items';
}

/**
 * The shape of one step's recorded output, reduced to what a sentence can say.
 *   { kind: 'list', count, noun } | { kind: 'file', name } | { kind: 'record', fields }
 *   | { kind: 'text' } | { kind: 'none' }
 * Only counts, a file name and at most two short title-like values travel; a
 * free-text answer (an AI reply) is 'text' and its content never does.
 */
function describeOutput(output) {
    if (output == null || isTruncated(output)) return { kind: 'none' };
    if (typeof output === 'string') return output.trim() ? { kind: 'text' } : { kind: 'none' };
    if (Array.isArray(output)) return { kind: 'list', count: output.length, noun: nounForItems(output) };
    if (!isPlainObject(output)) return { kind: 'none' };
    if (output.disabled === true) return { kind: 'none' };

    if (looksLikeFile(output)) return { kind: 'file', name: fileNameOf(output) };
    if (isPlainObject(output.file) && looksLikeFile(output.file)) return { kind: 'file', name: fileNameOf(output.file) };

    const arrays = Object.entries(output).filter(([, v]) => Array.isArray(v));
    const listEntry = LIST_KEYS.map(k => [k, output[k]]).find(([, v]) => Array.isArray(v))
        || (arrays.length === 1 ? arrays[0] : null);
    if (listEntry) {
        const [key, items] = listEntry;
        const declared = [output.total, output.count].find(n => Number.isInteger(n) && n >= items.length);
        return { kind: 'list', count: declared ?? items.length, noun: nounForItems(items, key) };
    }

    const fields = [];
    for (const k of FIELD_KEYS) {
        if (fields.length >= MAX_FIELDS) break;
        const v = clip(output[k], 60);
        if (v && !fields.includes(v)) fields.push(v);
    }
    if (fields.length) return { kind: 'record', fields };
    return { kind: 'none' };
}

/** A folder or path the step worked in, read off its recorded input. */
function whereOf(row) {
    const input = row?.input;
    if (!isPlainObject(input)) return null;
    for (const k of WHERE_KEYS) {
        const v = input[k];
        if (typeof v === 'string' && v.trim()) return clip(v, MAX_WHERE);
        // A binding recorded before it resolved: { kind:'literal', value }.
        if (isPlainObject(v) && typeof v.value === 'string' && v.value.trim()) return clip(v.value, MAX_WHERE);
    }
    return null;
}

// nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- /s$/ is one literal at the end: linear
const singular = (noun, n) => (n === 1 && /s$/.test(noun) ? noun.replace(/s$/, '') : noun);

// ── Why a run stopped, in plain words ───────────────────────────────────
//
// The reason is the classifier's verdict (core/automationErrors.js, the
// Nextcloud classifier's code, the step's own errorInfo when the step wrote
// one), never the raw upstream text: that can quote a response body.

const REASONS = Object.freeze({
    no_access: 'no access',
    not_connected: 'the account is not connected',
    session_expired: 'the sign-in has expired',
    app_disabled: 'the app is not enabled for this account',
    not_found: 'the file, board or room was not found',
    target_conflict: 'the target location is missing or already exists',
    missing_input: 'a required field is empty or invalid',
    timed_out: 'the service did not answer in time',
    unreachable: 'the service could not be reached',
    temporarily_unavailable: 'the service was temporarily unavailable',
    rate_limited: 'the service is limiting requests',
    app_refused: 'the connected app refused the request',
    approval_expired: 'nobody decided the approval in time',
    run_timeout: 'the run took longer than its time limit',
    blocked_by_privacy: 'the Privacy Shield blocked it',
    cancelled: 'it was cancelled',
    unexpected: 'something unexpected went wrong',
});

const NC_REASON = Object.freeze({
    NOT_CONNECTED: 'not_connected',
    SESSION_EXPIRED: 'session_expired',
    CONNECTOR_UNREACHABLE: 'unreachable',
    THROTTLED: 'rate_limited',
    TIMEOUT: 'timed_out',
    PARENT_MISSING: 'target_conflict',
    APP_DISABLED: 'app_disabled',
    NOT_FOUND: 'not_found',
    MISSING_FIELD: 'missing_input',
});

const CLASS_REASON = Object.freeze({
    PermissionError: 'no_access',
    TimeoutError: 'timed_out',
    TransientError: 'temporarily_unavailable',
    ValidationError: 'missing_input',
    IntegrationError: 'app_refused',
    ApprovalExpired: 'approval_expired',
    UserCanceledError: 'cancelled',
    guardrail_blocked: 'blocked_by_privacy',
});

/**
 * `{ reasonCode, reason }` for a failure.
 * @param {{ message?: string|null, errorClass?: string|null, ncCode?: string|null, errorInfo?: any }} err
 * @param {string|null} where  the folder/path the failing step worked in
 */
function reasonFor(err = {}, where = null) {
    const info = err.errorInfo;
    if (isPlainObject(info) && typeof info.code === 'string' && clip(info.title)) {
        return { reasonCode: info.code, reason: lowerFirst(stripDot(clip(info.title, 120))) };
    }
    let code = null;
    if (err.ncCode && NC_REASON[err.ncCode]) code = NC_REASON[err.ncCode];
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a fixed, anchored phrase: linear
    if (!code && /^run hard timeout$/i.test(String(err.message || '').trim())) code = 'run_timeout';
    if (!code && err.errorClass && CLASS_REASON[err.errorClass]) code = CLASS_REASON[err.errorClass];
    if (!code) code = 'unexpected';
    let reason = REASONS[code];
    if (where && code === 'no_access') reason = `no access to ${where}`;
    if (where && code === 'not_found') reason = `${where} was not found`;
    return { reasonCode: code, reason };
}

function stripDot(s) { return s ? s.replace(/[.\s]+$/, '') : s; }
function lowerFirst(s) { return s && /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

/** "Anna", "Anna, Bas and Cor", "Anna, Bas, Cor and 2 more". */
function joinNames(names) {
    const list = (names || []).map(n => clip(n, 60)).filter(Boolean);
    const unique = [...new Set(list)];
    if (!unique.length) return null;
    if (unique.length === 1) return unique[0];
    const head = unique.slice(0, MAX_WHO);
    const rest = unique.length - head.length;
    if (rest > 0) return `${head.join(', ')} and ${rest} more`;
    return `${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`;
}

const outcome = (code, params, text) => ({ code, params, text });

/**
 * @param {{
 *   status: string,                       the run's final status
 *   definition?: object|null,             the copy that ran
 *   steps?: Array<object>,                this leg's recorded step rows (rowToRunStep shape)
 *   error?: { message?: string|null, errorClass?: string|null, ncCode?: string|null } | null,
 *   awaitingStepId?: string|null,
 *   waitingOn?: string[],                 display names of who must decide an approval
 *   cancelReason?: 'already_running'|null,
 *   handledErrorCount?: number,
 * }} input
 * @returns {{ code: string, params: Record<string, any>, text: string }}
 */
function buildRunOutcome(input = {}) {
    const status = String(input.status || '');
    const index = indexDefinition(input.definition);
    const rows = finalRows(input.steps).filter(r => r && !r.parentStepId && !index.triggerIds.has(r.stepId));

    if (status === 'awaiting_approval') {
        const stepId = input.awaitingStepId || null;
        const step = stepLabel(index, stepId);
        const names = (input.waitingOn || []).filter(Boolean);
        const who = joinNames(names);
        const params = { step, stepId, who, whoCount: names.length || null };
        return outcome('waiting_approval', params, who ? `Waiting for approval from ${who}` : 'Waiting for approval');
    }
    if (status === 'awaiting_form') {
        const stepId = input.awaitingStepId || null;
        return outcome('waiting_form', { step: stepLabel(index, stepId), stepId }, 'Waiting for the next form page to be filled in');
    }
    if (status === 'awaiting_confirm') {
        return outcome('waiting_confirm', {}, 'Waiting for someone to confirm the first run');
    }
    if (status === 'cancelled') {
        if (input.cancelReason === 'already_running') {
            return outcome('cancelled', { reasonCode: 'already_running' }, 'Skipped because the automation was already running');
        }
        return outcome('cancelled', { reasonCode: 'cancelled' }, 'Stopped before it finished');
    }
    if (status === 'error') {
        // The step that failed: the last top-level row still in 'error' (an
        // on_error branch flips a handled one to 'handled_error'). A failure
        // with no failed row (a timeout between steps, a blocked trigger
        // payload) names no step.
        const failed = [...rows].reverse().find(r => r.status === 'error') || null;
        const stepId = failed ? String(failed.stepId).split('/').pop() : null;
        const step = failed ? stepLabel(index, failed.stepId, failed.stepType) : null;
        const where = failed ? whereOf(failed) : null;
        const err = input.error || {};
        const { reasonCode, reason } = reasonFor({
            ...err,
            errorClass: err.errorClass || failed?.errorClass || null,
            errorInfo: failed?.errorInfo || null,
        }, where);
        const params = { step, stepId, reasonCode, reason, where };
        return outcome('stopped_at', params, step ? `Stopped at "${step}": ${reason}` : `Stopped: ${reason}`);
    }

    // success (and anything else that finished without failing).
    const handled = Number(input.handledErrorCount) || 0;
    const withHandled = (text) => (handled > 0 ? `${text} (${handled} step error${handled === 1 ? '' : 's'} handled)` : text);
    const meaningful = rows.filter(r => DONE_STATUSES.has(r.status) && !QUIET_TYPES.has(r.stepType));
    let chosen = null;
    let shape = null;
    // The newest step that produced something countable or nameable says
    // what the run did; a trailing "send a message" step does not.
    for (let i = meaningful.length - 1; i >= 0; i--) {
        const d = describeOutput(meaningful[i].output);
        if (d.kind === 'list' || d.kind === 'file' || d.kind === 'record') { chosen = meaningful[i]; shape = d; break; }
    }
    if (!chosen && meaningful.length) { chosen = meaningful[meaningful.length - 1]; shape = describeOutput(chosen.output); }
    if (!chosen) return outcome('success', { kind: 'none', ...(handled ? { handled } : {}) }, withHandled('Finished'));

    const step = stepLabel(index, chosen.stepId, chosen.stepType);
    const stepId = String(chosen.stepId).split('/').pop();
    const base = { step, stepId, kind: shape.kind, ...(handled ? { handled } : {}) };
    if (shape.kind === 'list') {
        const where = whereOf(chosen);
        const noun = shape.noun;
        const found = `${shape.count} ${singular(noun, shape.count)} found${where ? ` in ${where}` : ''}`;
        return outcome('success', { ...base, count: shape.count, noun, where }, withHandled(`${step}: ${found}`));
    }
    if (shape.kind === 'file') {
        return outcome('success', { ...base, name: shape.name }, withHandled(`${step}: ${shape.name}`));
    }
    if (shape.kind === 'record') {
        return outcome('success', { ...base, fields: shape.fields }, withHandled(`${step}: ${shape.fields.join(' · ')}`));
    }
    return outcome('success', base, withHandled(`Finished with "${step}"`));
}

/**
 * Who an approval waits on, as seat references: the panel/stage seats, else
 * the single assignee (user or group), else the owner (an unassigned approval
 * goes to the owner).
 */
function approvalSeats(approval, ownerId) {
    if (approval && Array.isArray(approval.approvers) && approval.approvers.length) {
        return approval.approvers.filter(s => s && (s.userId || s.groupId));
    }
    if (approval?.assigneeUserId) return [{ userId: approval.assigneeUserId }];
    if (approval?.assigneeGroupId) return [{ groupId: approval.assigneeGroupId }];
    return ownerId ? [{ userId: ownerId }] : [];
}

/**
 * The runner's entry point. Never throws.
 *
 * @param {{
 *   runId: string, status: string, definition?: object|null,
 *   error?: object|null, awaitingStepId?: string|null, approval?: object|null,
 *   ownerId?: string|null, cancelReason?: string|null, handledErrorCount?: number,
 * }} input
 * @param {{
 *   getRunSteps?: (runId: string) => Promise<Array<object>>,
 *   nameOfUser?: (id: string) => Promise<string|null>,
 *   nameOfGroup?: (id: string) => Promise<string|null>,
 * }} deps
 */
async function resolveRunOutcome(input, deps = {}) {
    let steps = [];
    try {
        if (typeof deps.getRunSteps === 'function' && input.runId) steps = await deps.getRunSteps(input.runId) || [];
    } catch (_) { steps = []; }
    let waitingOn = [];
    if (input.status === 'awaiting_approval') {
        const seats = approvalSeats(input.approval, input.ownerId);
        for (const seat of seats.slice(0, 10)) {
            try {
                const name = seat.userId
                    ? (deps.nameOfUser ? await deps.nameOfUser(seat.userId) : null)
                    : (deps.nameOfGroup ? await deps.nameOfGroup(seat.groupId) : null);
                if (name) waitingOn.push(name);
            } catch (_) { /* a name we cannot read is left out, not guessed */ }
        }
    }
    try {
        return buildRunOutcome({ ...input, steps, waitingOn });
    } catch (_) {
        return buildRunOutcome({ status: input.status });
    }
}

/**
 * The outcome as the ORGANISATION-wide run log may carry it: the code and the
 * params that name steps, counts and reasons, but no folder, file name,
 * record value or English text. That log is somebody else's runs
 * (stores/automationStore/runs.js rowToOrgRunRow), and those params are
 * read off their data.
 */
const ORG_PARAMS = ['step', 'stepId', 'kind', 'count', 'noun', 'reasonCode', 'reason', 'who', 'whoCount', 'handled'];
function outcomeForOrgRow(o) {
    if (!o || typeof o !== 'object' || typeof o.code !== 'string') return null;
    const params = {};
    for (const k of ORG_PARAMS) {
        if (o.params && o.params[k] !== undefined) params[k] = o.params[k];
    }
    // The reason can name the folder it had no access to; the code cannot.
    if (params.reasonCode && REASONS[params.reasonCode]) params.reason = REASONS[params.reasonCode];
    else delete params.reason;
    return { code: o.code, params, text: null };
}

/**
 * The production lookups for resolveRunOutcome. Lazy: the user store is only
 * loaded when a paused approval needs a name.
 * @param {{ getRunSteps?: Function }} automationStore
 */
function storeOutcomeDeps(automationStore) {
    const displayName = (u) => (u ? (u.displayName || u.username || null) : null);
    return {
        getRunSteps: typeof automationStore?.getRunSteps === 'function'
            ? (id) => automationStore.getRunSteps(id) : undefined,
        nameOfUser: async (id) => displayName(await require('../stores/userStore').getUser(id)),
        nameOfGroup: async (id) => {
            const groups = await require('../stores/userStore').getAllGroups();
            const g = (groups || []).find(x => String(x.id) === String(id));
            return g ? (g.name || null) : null;
        },
    };
}

module.exports = {
    OUTCOME_CODES,
    storeOutcomeDeps,
    outcomeForOrgRow,
    REASONS,
    buildRunOutcome,
    resolveRunOutcome,
    describeOutput,
    reasonFor,
    indexDefinition,
    stepLabel,
    finalRows,
    approvalSeats,
    joinNames,
    QUIET_TYPES,
};
