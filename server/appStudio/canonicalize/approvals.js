/**
 * App Studio canonicalizer — the request_approval step's own blocks: approver
 * questions, the stage chain, and the on_decided record-write hook.
 */

'use strict';

const { isObject } = require('./shared');
const { cleanBinding } = require('./bindings');

// Approver questions on a request_approval step. The form-contract vocabulary,
// same caps as automation approvals (20 questions, no `file` — attachments are
// the download channel; approver uploads are out of scope by design).
const APPROVAL_QUESTION_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'select', 'checkbox']);
function cleanApprovalQuestions(v, path, push) {
    if (!Array.isArray(v)) return [];
    const out = [];
    const seen = new Set();
    for (const f of v) {
        if (!isObject(f) || typeof f.name !== 'string' || !f.name || seen.has(f.name)) continue;
        seen.add(f.name);
        const q = { name: f.name.slice(0, 60), type: APPROVAL_QUESTION_TYPES.has(f.type) ? f.type : 'text' };
        if (f.type === 'file' && typeof push === 'function') {
            push('approval.question_file_dropped', `${path}.${f.name}`,
                `Approver question "${f.name}" asked for a file upload — coerced to text (approvers download, they don't upload).`);
        }
        if (typeof f.label === 'string' && f.label) q.label = f.label.slice(0, 120);
        if (typeof f.help === 'string' && f.help) q.help = f.help.slice(0, 300);
        if (typeof f.placeholder === 'string' && f.placeholder) q.placeholder = f.placeholder.slice(0, 120);
        if (f.required === true) q.required = true;
        if (q.type === 'select' && Array.isArray(f.options)) {
            q.options = f.options.slice(0, 25).map((o) => {
                if (typeof o === 'string') return o.slice(0, 120);
                if (isObject(o) && (typeof o.value === 'string' || typeof o.label === 'string')) {
                    return { value: String(o.value ?? o.label).slice(0, 120), label: String(o.label ?? o.value).slice(0, 120) };
                }
                return null;
            }).filter(Boolean);
        }
        out.push(q);
        if (out.length >= 20) {
            if (v.length > 20 && typeof push === 'function') {
                push('approval.questions_truncated', path, `More than 20 approver questions — kept the first 20.`);
            }
            break;
        }
    }
    return out;
}

// The stage chain on a request_approval step. An ordered list of up to five
// named steps, each with its own approvers and its own rule — the shared
// rulebook in automation/approvalStages.js owns the caps, so the app path and
// the automation path cannot drift. Names and descriptions may be plain strings
// or bindings (App Studio's own idiom for a dynamic value); both survive here
// and the executor resolves a binding just before the request goes out.
const { MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE, MAX_TOTAL_SEATS,
    MAX_STAGE_NAME_LEN, MAX_STAGE_DESCRIPTION_LEN, STAGE_RULES } = require('../../automation/approvalStages');
function cleanApprovalStages(v, path, push) {
    if (!Array.isArray(v)) return [];
    const out = [];
    const usedKeys = new Set();
    let totalSeats = 0;
    for (const raw of v) {
        if (!isObject(raw)) continue;
        const seen = new Set();
        const seats = [];
        for (const seat of Array.isArray(raw.approvers) ? raw.approvers : []) {
            if (!isObject(seat)) continue;
            const one = (typeof seat.userId === 'string' && seat.userId.trim())
                ? { userId: seat.userId.trim().slice(0, 80) }
                : ((typeof seat.groupId === 'string' && seat.groupId.trim())
                    ? { groupId: seat.groupId.trim().slice(0, 80) } : null);
            if (!one) continue;
            const k = one.userId ? `u:${one.userId}` : `g:${one.groupId}`;
            if (seen.has(k)) continue;
            seen.add(k);
            seats.push(one);
            if (seats.length >= MAX_SEATS_PER_STAGE) break;
        }
        if (!seats.length) {
            if (typeof push === 'function') {
                push('approval.stage_empty_dropped', path,
                    `An approval stage named nobody to decide it — dropped (a stage with no approvers can never pass).`);
            }
            continue;
        }
        if (totalSeats + seats.length > MAX_TOTAL_SEATS) {
            if (typeof push === 'function') {
                push('approval.stages_truncated', path,
                    `The approval stages have more than ${MAX_TOTAL_SEATS} approvers between them — kept the first ${out.length} stage(s).`);
            }
            break;
        }
        totalSeats += seats.length;

        const rule = STAGE_RULES.includes(raw.rule) ? raw.rule : 'all';
        // The key is what already-cast votes are filed under, so an authored
        // one survives verbatim; only an absent or colliding key is replaced.
        let key = (typeof raw.key === 'string' && raw.key.trim()) ? raw.key.trim().slice(0, 40) : '';
        if (!key || usedKeys.has(key)) key = `s${out.length + 1}`;
        while (usedKeys.has(key)) key = `${key}_${usedKeys.size}`;
        usedKeys.add(key);

        const stage = { key, approvers: seats, rule };
        const text = (val, max) => {
            if (typeof val === 'string' && val.trim()) return val.trim().slice(0, max);
            if (isObject(val)) return cleanBinding(val, `${path}.${key}`, push);
            return undefined;
        };
        const name = text(raw.name, MAX_STAGE_NAME_LEN);
        if (name !== undefined) stage.name = name;
        const description = text(raw.description, MAX_STAGE_DESCRIPTION_LEN);
        if (description !== undefined) stage.description = description;
        if (rule === 'quorum') {
            const n = Math.round(Number(raw.quorum));
            stage.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seats.length) : Math.min(2, seats.length);
        }
        if (typeof raw.when === 'string' && raw.when.trim()) stage.when = raw.when.trim().slice(0, 2000);
        out.push(stage);
        if (out.length >= MAX_APPROVAL_STAGES) {
            if (v.length > MAX_APPROVAL_STAGES && typeof push === 'function') {
                push('approval.stages_truncated', path, `More than ${MAX_APPROVAL_STAGES} approval stages — kept the first ${MAX_APPROVAL_STAGES}.`);
            }
            break;
        }
    }
    return out;
}

// The on_decided record-write hook: which row flips, and what each outcome
// writes. `recordId` is a binding (resolved at REQUEST time); the per-outcome
// `set` maps are column → template STRING resolved at DECISION time
// ({{answers.<q>}}, {{reason}}, {{decidedByName}}, {{context.<key>}}, …) or a
// plain literal. Scalar literals pass through unchanged.
const APPROVAL_HOOK_OUTCOMES = ['approved', 'rejected', 'expired', 'cancelled'];
function cleanApprovalOnDecided(v, path, push) {
    if (!isObject(v)) return undefined;
    const out = {};
    if (typeof v.tableId === 'string' && v.tableId) out.tableId = v.tableId;
    if (v.recordId !== undefined) out.recordId = cleanBinding(v.recordId, `${path}.recordId`, push);
    if (isObject(v.set)) {
        const set = {};
        for (const outcome of APPROVAL_HOOK_OUTCOMES) {
            const m = v.set[outcome];
            if (!isObject(m)) continue;
            const cols = {};
            let n = 0;
            for (const [col, val] of Object.entries(m)) {
                if (n >= 20) break;
                if (typeof col !== 'string' || !col) continue;
                if (typeof val === 'string') cols[col] = val.slice(0, 2000);
                else if (val === null || typeof val === 'number' || typeof val === 'boolean') cols[col] = val;
                n += 1;
            }
            if (Object.keys(cols).length) set[outcome] = cols;
        }
        if (Object.keys(set).length) out.set = set;
    }
    const unknown = Object.keys(v).filter((k) => !['tableId', 'recordId', 'set'].includes(k));
    if (unknown.length && typeof push === 'function') {
        push('approval.hook_unknown_field', path, `Dropped unknown onDecided fields: ${unknown.join(', ')}. Legal: tableId, recordId, set.`);
    }
    return Object.keys(out).length ? out : undefined;
}

module.exports = { cleanApprovalQuestions, cleanApprovalStages, cleanApprovalOnDecided };
