/**
 * Tolerant reading of an app_set_action call — the repairs that are
 * unambiguous, done BEFORE the validator so a small model's near-miss lands
 * instead of costing a round, and the SPECIFIC reason when it still cannot.
 *
 * Measured 2026-09-13 (App Studio builder, Gemma 4, core menu): one turn sent
 * the same two create_record actions four times, each in a different wrong
 * vocabulary — the run_automation shape it had seen in a few-shot
 * (`inputMapping`, `onSuccess.toast`, `{kind:"field", name}`), then a garbled
 * string where the binding object had been, then a formula on `forms.<form>.
 * <field>` (which validates, and writes NULL on the server: only `form` is in
 * scope there). Every refusal carried the same generic `_fixHint`, and none
 * of them said that the tableId it wrote had never been created.
 *
 * Rules (create_record / update_record; delete_record for the effects rule):
 *   • `inputMapping` with no `values` → `values` (the run_automation word).
 *   • values.<k> = {kind:"field", name}       → {kind:"formula", expr:"form.<name>"}
 *   • values.<k> = {kind:"formula", expr:"forms.<f>.<x>…"} → `form.<x>…`
 *   • values.<k> = a bare scalar              → {kind:"static", value}
 *     (a string that IS a scope-root path, `form.total`, becomes a formula)
 *   • a tableId that is not a table but names one uniquely (tableHints)
 *     → that table's id.
 *   • onSuccess/onError on a record action     → a sequence: the step, a
 *     refresh of its table, the toast / navigate the effect asked for. (A bare
 *     record action WITHOUT effects is left as authored — changing an action's
 *     kind when nothing was wrong is not a repair.)
 * Refusals — the ambiguous cases, never guessed:
 *   • {kind:"field"} without a usable name;
 *   • a formula on a client-only root (screen., actions., records., datasets.)
 *     inside a server step — `screen.x → form.x` would be a guess;
 *   • a STRING carrying binding JSON: the call arrived corrupted.
 * Every repair is a note (→ `_hints`): the shape is corrected here, the habit
 * by the note. `describeActionRefusal` turns the validator's records into one
 * "Reject reason: …" the model can act on, plus the mechanical fix as
 * `_suggestedPatch` where there is one.
 *
 * Pure: no draft, no I/O.
 */

'use strict';

const { suggestTableId } = require('./tableHints');
const { parseGemmaArgs } = require('../../core/llm/leakedToolCalls');

const RECORD_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
const VALUE_BEARING = new Set(['create_record', 'update_record']);
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
// What a SERVER step can read (actionExecutor/shared.js buildServerScope):
// `form` is the submitted form; `forms`, `screen`, `actions`, `records`,
// `datasets` exist but are empty there.
const SERVER_ROOT_RE = /^(form|vars|item|value|currentUser|now|today)(\.|$)/;
const CLIENT_ONLY_ROOT_RE = /\b(screen|actions|records|datasets)\./;
const FORMS_ROOT_RE = /\bforms\.[A-Za-z_$][\w$]*\./g;
const FORMS_ROOT_TEST = /\bforms\.[A-Za-z_$][\w$]*\./;
// A binding object that became a string: `{kind:\"field\",name:\"amount\"…`
const GARBLED_BINDING_RE = /\bkind\b\s*\\{0,2}"?\s*:/;
const GARBLED_NAME_RE = /\bname\b\s*\\{0,2}"?\s*:\s*\\{0,2}"?([A-Za-z_$][\w$]*)/;
const MAX_DEPTH = 4;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** `{kind:\"field\",name:\"x\"}\`,email:` — a binding that became a string. */
function looksGarbledBinding(s) {
    return GARBLED_BINDING_RE.test(s) || (/^\s*[{`]/.test(s) && /\bkind\b/.test(s));
}
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

class Refusal extends Error {
    constructor(result) { super(result.error); this.result = result; }
}

function fieldBindingFromName(name) {
    return { kind: 'formula', expr: `form.${name}` };
}

/** One entry of `values` (or a recordId) → a legal binding, a note, or a refusal. */
function repairBinding(value, at, notes) {
    if (isObject(value)) {
        if (value.kind === 'field') {
            const name = typeof value.name === 'string' ? value.name.trim() : '';
            if (!IDENT_RE.test(name)) {
                throw new Refusal({
                    error: `${at} has kind:"field" without a usable name — nothing was created.`,
                    _fixHint: `Reject reason: ${at} has kind:"field" without a usable name. Write {kind:"formula", expr:"form.<the input's props.name>"} — a create/update step reads the submitted form as form.<name>.`,
                });
            }
            notes.push(`${at}: {kind:"field", name:"${name}"} read as {kind:"formula", expr:"form.${name}"} — "field" exists only in run_automation inputMapping; a record step reads the submitted form as form.<name>.`);
            return fieldBindingFromName(name);
        }
        if (value.kind === 'formula') {
            const out = { ...value };
            if (typeof out.expr !== 'string' && typeof out.value === 'string') {
                out.expr = out.value;
                delete out.value;
                notes.push(`${at}: formula "value" read as "expr".`);
            }
            if (typeof out.expr === 'string') {
                if (FORMS_ROOT_TEST.test(out.expr)) {
                    const fixed = out.expr.replace(FORMS_ROOT_RE, 'form.');
                    notes.push(`${at}: "${out.expr}" read as "${fixed}" — a server step sees the submitted form as form.<name> only; forms.<formName> is empty there and would write NULL.`);
                    out.expr = fixed;
                }
                const client = CLIENT_ONLY_ROOT_RE.exec(out.expr);
                if (client) {
                    throw new Refusal({
                        error: `${at} reads ${client[1]}.…, which a server step cannot see — nothing was created.`,
                        _fixHint: `Reject reason: ${at} reads ${client[1]}.…, which a create/update/delete step cannot see (it sees form, vars, item, value, currentUser, now, today). Use {kind:"formula", expr:"form.<inputName>"} for a submitted value.`,
                    });
                }
            }
            return out;
        }
        return value;
    }
    if (typeof value === 'string') {
        if (looksGarbledBinding(value)) {
            const parsed = parseGarbledBinding(value);
            if (parsed) {
                notes.push(`${at} arrived as a string carrying binding JSON — read as the binding {kind:"${parsed.kind}", …}.`);
                return repairBinding(parsed, at, notes);
            }
            const name = GARBLED_NAME_RE.exec(value);
            const patchValue = name ? fieldBindingFromName(name[1]) : null;
            throw new Refusal({
                error: `${at} is a STRING carrying binding JSON — this call arrived corrupted; nothing was created.`,
                _fixHint: `Reject reason: corrupted JSON in ${at}. Resend with ${at} as an object: {kind:"formula", expr:"form.<inputName>"} (or {kind:"static", value}); send fewer actions per call if it is long.`,
                ...(patchValue ? { _suggestedPatch: { ops: [{ op: 'set', path: at, value: patchValue }], why: `${at} named the input "${name[1]}"` } } : {}),
            });
        }
        if (SERVER_ROOT_RE.test(value)) {
            notes.push(`${at}: the string "${value}" read as {kind:"formula", expr:"${value}"}.`);
            return { kind: 'formula', expr: value };
        }
        notes.push(`${at}: the bare string read as {kind:"static", value}.`);
        return { kind: 'static', value };
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        notes.push(`${at}: the bare value read as {kind:"static", value}.`);
        return { kind: 'static', value };
    }
    return value;
}

/** One create/update/delete_record step (as an action or inside a sequence). */
function repairRecordStep(step, at, notes, ctx) {
    // Nulls the model writes for "not set" (measured 2026-09-14).
    for (const k of ['expectedUpdatedAt', 'recordId']) {
        if (step[k] === null || (typeof step[k] === 'string' && looksGarbledBinding(step[k]) && !parseGarbledBinding(step[k]))) {
            if (k === 'recordId' && step.kind !== 'create_record') {
                throw new Refusal({
                    error: `${at}.recordId is ${step[k] === null ? 'null' : 'a corrupted string'} — an ${step.kind} needs the row it changes; nothing was created.`,
                    _fixHint: `Reject reason: ${at}.recordId missing. On a detail screen use {kind:"formula", expr:"screen.params.recordId"} (the id the grid row passed); in a grid row action use {kind:"formula", expr:"item.id"}.`,
                });
            }
            delete step[k];
            notes.push(`${at}.${k} (${step[k] === undefined ? 'null' : 'corrupted'}) dropped.`);
        }
    }
    if (isObject(step.values)) {
        for (const k of Object.keys(step.values)) {
            const v = step.values[k];
            if (isObject(v) && v.literal !== undefined && v.kind === undefined) { step.values[k] = { kind: 'static', value: v.literal }; notes.push(`${at}.values.${k}: {literal} read as {kind:"static", value}.`); }
        }
    }
    if (VALUE_BEARING.has(step.kind)) {
        if (isObject(step.inputMapping)) {
            if (!isObject(step.values)) {
                step.values = step.inputMapping;
                notes.push(`${at}: "inputMapping" read as "values" — inputMapping belongs to run_automation.`);
            } else {
                notes.push(`${at}: "inputMapping" dropped — the step already had "values" (inputMapping belongs to run_automation).`);
            }
            delete step.inputMapping;
        }
        if (isObject(step.values)) {
            for (const k of Object.keys(step.values)) {
                step.values[k] = repairBinding(step.values[k], `${at}.values.${k}`, notes);
            }
        }
    }
    if (step.kind !== 'create_record' && step.recordId !== undefined && step.recordId !== null) {
        step.recordId = repairBinding(step.recordId, `${at}.recordId`, notes);
    }
    if (typeof step.tableId === 'string' && Array.isArray(ctx.tables) && ctx.tables.length
        && !ctx.tables.some((t) => t && t.id === step.tableId)) {
        const hit = suggestTableId(step.tableId, ctx.tables);
        if (hit) {
            notes.push(`${at}.tableId "${step.tableId}" is not a table — read as ${hit.table.id} (key ${hit.table.key}). Use ids from tool results.`);
            step.tableId = hit.table.id;
        }
    }
}

/** The effects a record action carried → the steps that follow it in a sequence. */
function effectSteps(step, at, notes) {
    const out = [];
    if (typeof step.tableId === 'string' && step.tableId) out.push({ kind: 'refresh', tableId: step.tableId });
    const success = isObject(step.onSuccess) ? step.onSuccess : null;
    if (success) {
        const toast = isObject(success.toast) ? success.toast : null;
        if (toast && typeof toast.message === 'string' && toast.message.trim()) {
            out.push({ kind: 'toast', message: toast.message, ...(typeof toast.tone === 'string' ? { tone: toast.tone } : {}) });
        }
        const nav = isObject(success.navigateTo) ? success.navigateTo : (isObject(success.navigate) ? success.navigate : null);
        if (nav && typeof nav.screenId === 'string') {
            out.push({ kind: 'navigate', screenId: nav.screenId, ...(isObject(nav.params) ? { params: nav.params } : {}) });
        }
        const other = Object.keys(success).filter((k) => !['toast', 'navigateTo', 'navigate'].includes(k));
        if (other.length) notes.push(`${at}: onSuccess.${other.join(', onSuccess.')} dropped — effects are a toast and/or a navigate.`);
    }
    if (step.onError !== undefined) notes.push(`${at}: onError dropped — the runner already toasts the real failure.`);
    delete step.onSuccess;
    delete step.onError;
    return out;
}

function walkSteps(list, at, notes, ctx, depth) {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return list;
    const out = [];
    for (const [i, raw] of list.entries()) {
        const stepAt = `${at}[${i}]`;
        if (!isObject(raw)) {
            // A JSON tail that became its own entry (`"resultVar:"`, measured
            // 2026-09-13) is debris, not a step: drop it and say so.
            if (typeof raw === 'string' && /^[\w."'{}:,\s-]{0,40}$/.test(raw)) { notes.push(`${stepAt}: the fragment ${JSON.stringify(raw)} dropped — not a step.`); continue; }
            out.push(raw); continue;
        }
        const step = raw;
        if (RECORD_KINDS.has(step.kind)) {
            repairRecordStep(step, stepAt, notes, ctx);
            const hadEffects = step.onSuccess !== undefined || step.onError !== undefined;
            const extra = hadEffects ? effectSteps(step, stepAt, notes) : [];
            out.push(step);
            if (hadEffects) {
                // Skip a refresh the author already placed right after.
                const next = list[i + 1];
                const filtered = extra.filter((s) => !(s.kind === 'refresh' && isObject(next) && next.kind === 'refresh' && next.tableId === s.tableId));
                out.push(...filtered);
                notes.push(`${stepAt}: onSuccess/onError on a record step read as the steps that follow it (${filtered.map((s) => s.kind).join(', ') || 'none'}).`);
            }
            continue;
        }
        if (step.kind === 'request_approval') repairApprovalStep(step, stepAt, notes);
        if (step.kind === 'navigate') repairNavigate(step, notes);
        if (Array.isArray(step.steps)) step.steps = walkSteps(step.steps, `${stepAt}.steps`, notes, ctx, depth + 1);
        if (Array.isArray(step.then)) step.then = walkSteps(step.then, `${stepAt}.then`, notes, ctx, depth + 1);
        if (Array.isArray(step.else)) step.else = walkSteps(step.else, `${stepAt}.else`, notes, ctx, depth + 1);
        if (Array.isArray(step.cases)) {
            step.cases = step.cases.map((c, j) => (isObject(c) && Array.isArray(c.steps)
                ? { ...c, steps: walkSteps(c.steps, `${stepAt}.cases[${j}].steps`, notes, ctx, depth + 1) }
                : c));
        }
        out.push(step);
    }
    return out;
}

// ── Shape drift measured on the 2026-09-13 playbook runs ───────────────────
// Every repair below is a shape the local model sent more than once and that
// a person can read off the transcript without asking the model anything:
// a wrapper key around legal fields, a field one level too high or low, a
// binding that arrived as a string, an assignee left null.

const NAVIGATE_FIELDS = new Set(['screenId', 'params']);
const WRAPPER_KEYS = ['fields', 'args', 'props', 'config'];

function unwrapStatic(v) {
    return isObject(v) && v.kind === 'static' && v.value !== undefined ? v.value : v;
}

/** `"{kind:\"formula\",expr:\"screen.params.id\"}"` → the binding object, or null. */
function parseGarbledBinding(str) {
    if (typeof str !== 'string' || !looksGarbledBinding(str)) return null;
    const unescaped = str.replace(/\\+"/g, '"');
    let parsed = parseGemmaArgs(unescaped);
    if (!parsed) { try { parsed = JSON.parse(unescaped); } catch { parsed = null; } }
    return isObject(parsed) && typeof parsed.kind === 'string' ? parsed : null;
}

/** The action-level drift every kind shares: an `actionId` inside the action, a wrapper key. */
function repairActionEnvelope(out, notes) {
    if (out.actionId !== undefined) {
        delete out.actionId;
        notes.push('action.actionId dropped — the id lives on the call (actionId), never inside the action.');
    }
    for (const w of WRAPPER_KEYS) {
        const inner = out[w];
        if (!isObject(inner)) continue;
        // navigate {fields:{screenId, params}} — the wrapper holds the legal fields.
        const legal = out.kind === 'navigate' ? NAVIGATE_FIELDS : null;
        const keys = Object.keys(inner);
        if (legal && keys.length && keys.every((k) => legal.has(k))) {
            for (const k of keys) if (out[k] === undefined) out[k] = inner[k];
            delete out[w];
            notes.push(`action.${w} unwrapped — ${keys.join(', ')} belong on the action itself.`);
        } else if (legal && !keys.length) {
            delete out[w];
            notes.push(`action.${w} (empty) dropped.`);
        }
    }
}

/** navigate: screenId hidden in params, or wrapped as a static binding. */
function repairNavigate(out, notes) {
    if (isObject(out.screenId)) {
        const v = unwrapStatic(out.screenId);
        if (typeof v === 'string') { out.screenId = v; notes.push('action.screenId read as the plain screen id — it is not a binding.'); }
    }
    if ((out.screenId === undefined || out.screenId === null) && isObject(out.params) && out.params.screenId !== undefined) {
        const v = unwrapStatic(out.params.screenId);
        if (typeof v === 'string') {
            out.screenId = v;
            delete out.params.screenId;
            if (!Object.keys(out.params).length) delete out.params;
            notes.push('action.params.screenId read as action.screenId — the target screen is a field of navigate, params carry the values the screen receives.');
        }
    }
}

const APPROVAL_ASSIGNEE_KEYS = ['assigneeUserId', 'assigneeGroupId', 'approverUserIds', 'approverGroupIds', 'finalApproverUserId', 'finalApproverGroupId'];

/** request_approval: the seats, the hook and the prompt as the spec reads them. */
function repairApprovalStep(step, at, notes) {
    for (const k of APPROVAL_ASSIGNEE_KEYS) {
        const v = step[k];
        if (v === null || v === '' || (Array.isArray(v) && !v.length)) { delete step[k]; notes.push(`${at}.${k} (empty) dropped.`); }
    }
    if (step.tableId !== undefined) {
        if (isObject(step.onDecided) && step.onDecided.tableId === undefined) { step.onDecided.tableId = step.tableId; notes.push(`${at}.tableId read as ${at}.onDecided.tableId — the table is the hook's.`); }
        else notes.push(`${at}.tableId dropped — a request_approval step has no tableId; the hook (onDecided) names the table.`);
        delete step.tableId;
    }
    if (isObject(step.onDecided)) {
        const hook = step.onDecided;
        if (typeof hook.recordId === 'string') {
            const parsed = parseGarbledBinding(hook.recordId);
            if (parsed) { hook.recordId = parsed; notes.push(`${at}.onDecided.recordId arrived as a string carrying binding JSON — read as the binding {kind:"${parsed.kind}", …}.`); }
            else if (/^(screen|item|vars|form)\./.test(hook.recordId)) { hook.recordId = { kind: 'formula', expr: hook.recordId }; notes.push(`${at}.onDecided.recordId "${hook.recordId.expr}" read as a formula binding.`); }
        }
        if (isObject(hook.set)) {
            for (const [outcome, map] of Object.entries(hook.set)) {
                if (!isObject(map)) continue;
                for (const [col, v] of Object.entries(map)) {
                    if (isObject(v) && v.kind === 'static') { map[col] = v.value; notes.push(`${at}.onDecided.set.${outcome}.${col} read as the plain value — set maps take literals or templates, not bindings.`); }
                    else if (isObject(v) && v.literal !== undefined) { map[col] = v.literal; notes.push(`${at}.onDecided.set.${outcome}.${col}: {literal} read as the plain value.`); }
                }
            }
        }
    }
    if (Array.isArray(step.stages)) {
        const users = Array.isArray(step.approverUserIds) ? step.approverUserIds : [];
        const groups = Array.isArray(step.approverGroupIds) ? step.approverGroupIds : [];
        for (const [i, stage] of step.stages.entries()) {
            if (!isObject(stage)) continue;
            const has = Array.isArray(stage.approvers) && stage.approvers.length;
            if (!has && (users.length || groups.length)) {
                stage.approvers = [...users.map((userId) => ({ userId })), ...groups.map((groupId) => ({ groupId }))];
                notes.push(`${at}.stages[${i}].approvers taken from the step's approverUserIds/approverGroupIds — with stages, the seats live on each stage.`);
            }
            if (!Array.isArray(stage.approvers) && (Array.isArray(stage.approverUserIds) || Array.isArray(stage.approverGroupIds))) {
                stage.approvers = [...(stage.approverUserIds || []).map((userId) => ({ userId })), ...(stage.approverGroupIds || []).map((groupId) => ({ groupId }))];
                delete stage.approverUserIds; delete stage.approverGroupIds;
                notes.push(`${at}.stages[${i}]: approverUserIds/approverGroupIds read as approvers:[{userId}|{groupId}].`);
            }
            if (stage.rule === undefined && typeof step.rule === 'string') stage.rule = step.rule;
        }
        if (step.stages.some((st) => isObject(st) && Array.isArray(st.approvers) && st.approvers.length)) {
            for (const k of ['approverUserIds', 'approverGroupIds']) if (step[k] !== undefined) { delete step[k]; notes.push(`${at}.${k} dropped — the stages carry the seats.`); }
        }
    }
    if (step.prompt === undefined || step.prompt === null || step.prompt === '') {
        step.prompt = { kind: 'static', value: 'Goedkeuren?' };
        notes.push(`${at}.prompt was missing — set to {kind:"static", value:"Goedkeuren?"}; change the wording with app_set_action.`);
    } else if (typeof step.prompt === 'string') {
        step.prompt = { kind: 'static', value: step.prompt };
        notes.push(`${at}.prompt: the bare string read as {kind:"static", value}.`);
    }
}

/**
 * @param {object} action  the model's action object (any shape)
 * @param {{ tables?: Array }} ctx  the app's data-model tables, for the id handle lookup
 * @returns {{ action: object, notes: string[], refusal: object|null }}
 */
function repairAction(action, ctx = {}) {
    const notes = [];
    if (!isObject(action)) return { action, notes, refusal: null };
    let out = clone(action);
    try {
        repairActionEnvelope(out, notes);
        if (out.kind === 'navigate') repairNavigate(out, notes);
        if (out.kind === 'sequence' && typeof out.resultVar === 'string' && Array.isArray(out.steps)) {
            // resultVar is a STEP field; on the sequence it names the one step that produces a result.
            const target = out.steps.find((st) => isObject(st) && st.resultVar === undefined && (st.kind === 'request_approval' || st.kind === 'run_automation' || String(st.kind || '').startsWith('ai_')));
            if (target) { target.resultVar = out.resultVar; notes.push(`action.resultVar read as steps[${out.steps.indexOf(target)}].resultVar — a sequence has no result of its own.`); }
            else notes.push('action.resultVar dropped — a sequence has no result of its own.');
            delete out.resultVar;
        }
        if (out.kind === 'request_approval') repairApprovalStep(out, 'action', notes);
        if (RECORD_KINDS.has(out.kind)) {
            repairRecordStep(out, 'action', notes, ctx);
            if (out.onSuccess !== undefined || out.onError !== undefined) {
                const extra = effectSteps(out, 'action', notes);
                const step = out;
                out = { kind: 'sequence', steps: [step, ...extra] };
                notes.push(`action: a ${step.kind} with onSuccess/onError read as a sequence [${out.steps.map((s) => s.kind).join(', ')}] — effects live on run_automation only; a record step is followed by a refresh of its table.`);
            }
        } else if (out.kind === 'run_automation' && isObject(out.inputMapping)) {
            // Only the corruption check: the mapping vocabulary is legal here.
            for (const k of Object.keys(out.inputMapping)) {
                const v = out.inputMapping[k];
                if (typeof v === 'string' && looksGarbledBinding(v)) {
                    throw new Refusal({
                        error: `action.inputMapping.${k} is a STRING carrying binding JSON — this call arrived corrupted; nothing was created.`,
                        _fixHint: `Reject reason: corrupted JSON in action.inputMapping.${k}. Resend with an object: {kind:"static", value} or {kind:"field", name:"<input props.name>"}.`,
                    });
                }
            }
        } else if (Array.isArray(out.steps)) {
            out.steps = walkSteps(out.steps, 'action.steps', notes, ctx, 1);
        }
    } catch (e) {
        if (e instanceof Refusal) return { action, notes, refusal: { ...e.result, ...(notes.length ? { _hints: notes } : {}) } };
        throw e;
    }
    return { action: out, notes, refusal: null };
}

// ── Refusal wording from the validator's records ────────────────────────────

function getAt(root, path) {
    if (!path) return root;
    const tokens = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = root;
    for (const t of tokens) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[t];
    }
    return cur;
}

function didYouMean(record) {
    const m = /Did you mean "([^"]+)"/.exec(String(record && record.hint || ''));
    return m ? m[1] : null;
}

const CREATE_RECIPE = 'create_record takes only tableId, values, resultVar. To save a form: {kind:"sequence", steps:[{kind:"create_record", tableId, values:{<fieldKey>:{kind:"formula",expr:"form.<inputName>"}}}, {kind:"refresh", tableId}, {kind:"toast", message}]}, then app_bind_action {nodeId:<form id>, event:"onSubmit", actionId}.';

/**
 * The validator's records for ONE action → { _fixHint, _suggestedPatch? }.
 * Paths are rewritten `actions.<id>.X` → `action.X` (the patch path in the
 * single form). The first group that matches wins the sentence; every
 * mechanical fix is merged into one patch.
 */
function describeActionRefusal(errors, { actionId, action, tables } = {}) {
    const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
    const rel = (p) => String(p || '').replace(`actions.${actionId}`, 'action');
    const ops = [];
    const reasons = [];
    const tableList = Array.isArray(tables) ? tables : [];
    const zeroTables = tableList.length === 0;

    for (const e of list) {
        const code = String(e.code || '');
        const path = rel(e.path);
        if (/\.unknown_table$/.test(code)) {
            const m = /references table "([^"]+)"/.exec(String(e.message || ''));
            const bad = m ? m[1] : getAt(action, path.replace(/^action\.?/, ''));
            const dym = didYouMean(e) || (suggestTableId(bad, tableList) || {}).table?.id || null;
            reasons.push(`table ${JSON.stringify(bad)} is not in the app${zeroTables ? ' (it has no tables yet)' : ''}. ${dym ? `Did you mean "${dym}"? ` : ''}Create it first with app_upsert_table {name, fields:[{key,type}]} — or link an existing Studio table with app_link_datatable {name} — and use the tbl_ id from the result; never invent a tbl_ id. Then resend this action unchanged`);
            if (dym) ops.push({ op: 'set', path, value: dym });
            continue;
        }
        if (/^(step|binding)\.unknown_field$/.test(code)) {
            const dym = didYouMean(e);
            const m = /field "([^"]+)" which is not on table "([^"]+)"/.exec(String(e.message || ''));
            const table = m ? tableList.find((t) => t && (t.id === m[2] || t.key === m[2])) : null;
            const keys = table ? (table.fields || []).map((f) => f.key).join(', ') : '';
            reasons.push(`${path} names a field the table does not have${keys ? ` (its keys: ${keys})` : ''}${dym ? ` — did you mean "${dym}"` : ''}`);
            if (dym && /\.values\.[^.]+$/.test(path)) ops.push({ op: 'move', from: path, to: path.replace(/\.values\.[^.]+$/, `.values.${dym}`) });
            continue;
        }
        if (code === 'binding.kind_invalid' || code === 'binding.invalid') {
            const bindingPath = code === 'binding.kind_invalid' ? path.replace(/\.kind$/, '') : path;
            const current = getAt(action, bindingPath.replace(/^action\.?/, ''));
            const name = isObject(current) && typeof current.name === 'string' && IDENT_RE.test(current.name) ? current.name : null;
            reasons.push(`${bindingPath} must be a binding object: {kind:"formula", expr:"form.<inputName>"} for a submitted value, or {kind:"static", value}`);
            if (name) ops.push({ op: 'set', path: bindingPath, value: fieldBindingFromName(name) });
            continue;
        }
        if (code === 'action.unknown_field' || code === 'action.step_unknown_field') {
            reasons.push(`${String(e.message || '').replace(/\.$/, '')}. ${CREATE_RECIPE}`);
            continue;
        }
        if (code === 'action.step_field_required') {
            const m = /missing required `([^`]+)`/.exec(String(e.message || ''));
            const tableId = getAt(action, 'tableId');
            const table = tableList.find((t) => t && t.id === tableId);
            const keys = table ? (table.fields || []).map((f) => f.key).join(', ') : '';
            reasons.push(`${path} is missing ${m ? `\`${m[1]}\`` : 'a required field'}${m && m[1] === 'values' ? ` — values: {<fieldKey>: binding}${keys ? `, keys of ${table.key}: ${keys}` : ''}` : ''}`);
            continue;
        }
        if (code === 'action.navigate_missing') {
            reasons.push(`${path.replace(/\.screenId$/, '')} (navigate) needs screenId at the top level — {kind:"navigate", screenId:"scr_…", params:{…}} — with a scr_ id from the draft state, never a guessed one`);
            continue;
        }
        if (code === 'action.unknown_field' && /has unknown fields for kind/.test(String(e.message || ''))) {
            const m = /unknown fields for kind "([^"]+)": (.+?)\. *$/.exec(String(e.message || ''));
            const fields = m ? m[2].split(',').map((x) => x.trim()) : [];
            reasons.push(`${path} (${m ? m[1] : 'action'}) has fields the kind does not take: ${fields.join(', ')}. ${String(e.hint || '').replace(/\.$/, '')}`);
            for (const f of fields) ops.push({ op: 'remove', path: `${path}.${f}` });
            continue;
        }
        if (code === 'action.step_unknown_field') {
            reasons.push(`${path} is not a field of that step. ${String(e.hint || '').replace(/\.$/, '')}`);
            ops.push({ op: 'remove', path });
            continue;
        }
        if (code === 'action.approval_stages_invalid') {
            reasons.push(`${path}: ${String(e.message || '').replace(/\.$/, '')} — a stage is {key, name, approvers:[{userId:"…"}|{groupId:"…"}], rule:"first"|"all"|"quorum"}`);
            continue;
        }
        if (code === 'action.approval_hook_invalid') {
            reasons.push(`${path}: ${String(e.message || '').replace(/\.$/, '')} — onDecided is {tableId:"tbl_…", recordId:{kind:"formula", expr:"screen.params.recordId"}, set:{approved:{<statusKey>:"…"}, rejected:{<statusKey>:"…"}}}`);
            continue;
        }
        if (code === 'action.navigate_unresolved' || code === 'action.step_navigate_unresolved' || code === 'action.effects_navigate_unresolved') {
            const dym = didYouMean(e);
            reasons.push(`${path} navigates to a screen the app does not have${dym ? ` — did you mean "${dym}"` : ''}; use a scr_ id from the draft state`);
            if (dym) ops.push({ op: 'set', path, value: dym });
            continue;
        }
    }
    const _fixHint = reasons.length
        ? `Reject reason: ${[...new Set(reasons)].join(' | ')}.`
        : 'Fix the fields the errors name and call app_set_action again with the whole action.';
    const out = { _fixHint };
    if (ops.length) out._suggestedPatch = { ops, why: 'the validator named the exact fix' };
    return out;
}

module.exports = {
    repairAction,
    describeActionRefusal,
    CREATE_RECIPE,
    _test: { repairBinding, effectSteps, getAt, RECORD_KINDS },
};
