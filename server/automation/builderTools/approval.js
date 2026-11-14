// @typecheck
/**
 * Builder tools — approval authoring: the config normalizer (single
 * assignee / panel / sequential stages / v2 clocks) and the
 * builder_add_approval applier. Required from within
 * automation/builderTools/ and the ../builderTools facade.
 */

const { newId, appendAfter } = require('./draftGraph');

/**
 * Hours an approval may sit before the run is closed as expired.
 *
 * Bounds mirror validate.js's APPROVAL_MAX_EXPIRY_HOURS and the builder UI's
 * formState, so an AI-built approval and a hand-built one are the same object.
 * `0` is meaningful, not falsy-empty: it means "no deadline", which the engine
 * honours by returning a null TTL. Default 168 (7 days).
 */
const APPROVAL_MAX_EXPIRY_HOURS = 720;
/**
 * @param {string | null | undefined} v
 */
function clampApprovalHours(v) {
    // null / undefined / '' mean "not specified" and must fall through to the
    // default — NOT to 0, which is the meaningful value "no deadline". They
    // are separated explicitly because Number(null) and Number('') are both
    // 0 and both finite, so a model that omitted the field by passing null
    // would otherwise have silently created an approval that never expires.
    if (v === null || v === undefined || v === '') return 168;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(APPROVAL_MAX_EXPIRY_HOURS, Math.round(n))) : 168;
}

// Caps mirrored from validate.js — a model that invents 40 attachments gets
// the first 5, loudly capped rather than silently persisted.
const APPROVAL_MAX_ATTACHMENTS = 5;
const APPROVAL_MAX_FIELDS = 20;
// Stage-chain caps from the shared rulebook — imported, never restated, so
// the normalizer and the runtime cannot drift apart.
const {
    MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE,
    MAX_STAGE_NAME_LEN, MAX_STAGE_DESCRIPTION_LEN, STAGE_RULES,
} = require('../approvalStages');

/**
 * @param s a seat as written
 * @returns {Seat | null}
 */
function cleanSeat(s) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.userId === 'string' && s.userId.trim()) return { userId: s.userId.trim() };
    if (typeof s.groupId === 'string' && s.groupId.trim()) return { groupId: s.groupId.trim() };
    return null;
}

/**
 * Seats cleaned like the assignee (exactly one of userId/groupId), deduped and
 * capped at `cap`.
 * @param {any[]} list
 * @param {number} cap
 * @returns {Seat[]}
 */
function cleanSeats(list, cap) {
    const seen = new Set();
    /** @type {Seat[]} */
    const seats = [];
    for (const raw of list) {
        const seat = cleanSeat(raw);
        if (!seat) continue;
        const key = seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seats.push(seat);
        if (seats.length >= cap) break;
    }
    return seats;
}

/**
 * N of M: rounded, at least 1 and at most the seat count; 2 (or every seat,
 * when fewer) when it is not a number.
 * @param raw untrusted input (the model wrote it)
 * @param {number} seatCount
 */
function clampQuorum(raw, seatCount) {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), seatCount) : Math.min(2, seatCount);
}

/**
 * Whole hours 1..720, or null.
 * @param {unknown} v
 */
function clockHours(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, APPROVAL_MAX_EXPIRY_HOURS) : null;
}

/** @param v */
const nonBlank = (v) => typeof v === 'string' && !!v.trim();

/**
 * Panel (multiple approvers): seats deduped and capped at 10. A panel present
 * means the single assignee is dropped (validation refuses the combination;
 * the normalizer keeps the object self-consistent).
 * @param {ApprovalConfig} out
 * @param {ApprovalInput} src
 */
function normalizePanel(out, src) {
    if (!Array.isArray(src.approvers)) return;
    const seats = cleanSeats(src.approvers, 10);
    if (!seats.length) return;
    out.approvers = seats;
    delete out.assignee;
    out.rule = ['all', 'first', 'quorum'].includes(src.rule) ? src.rule : 'all';
    if (out.rule === 'quorum') out.quorum = clampQuorum(src.quorum, seats.length);
}

/**
 * One stage of the chain, or null for a stage nobody sits in (it could never
 * be decided). Keys are what already-cast votes are filed under, so an
 * author-supplied one is preserved verbatim: re-saving an automation
 * mid-approval must not orphan the votes of a stage that already ran. Only a
 * collision or an absence gets a fresh positional key.
 * @param raw untrusted input (the model wrote it)
 * @param {number} position the number of stages already in the chain
 * @param {Set<string>} usedKeys
 * @returns {Stage | null}
 */
function normalizeStage(raw, position, usedKeys) {
    if (!raw || typeof raw !== 'object') return null;
    const seats = cleanSeats(Array.isArray(raw.approvers) ? raw.approvers : [], MAX_SEATS_PER_STAGE);
    if (!seats.length) return null;
    const rule = STAGE_RULES.includes(raw.rule) ? raw.rule : 'all';
    let key = nonBlank(raw.key) ? raw.key.trim().slice(0, 40) : '';
    if (!key || usedKeys.has(key)) key = `s${position + 1}`;
    while (usedKeys.has(key)) key = `${key}_${usedKeys.size}`;
    usedKeys.add(key);
    /** @type {Stage} */
    const stage = { key, approvers: seats, rule };
    if (nonBlank(raw.name)) stage.name = raw.name.trim().slice(0, MAX_STAGE_NAME_LEN);
    if (nonBlank(raw.description)) stage.description = raw.description.trim().slice(0, MAX_STAGE_DESCRIPTION_LEN);
    if (rule === 'quorum') stage.quorum = clampQuorum(raw.quorum, seats.length);
    if (nonBlank(raw.when)) stage.when = raw.when.trim();
    return stage;
}

/**
 * Stages (sequential approvals): the modern shape, and the one that supersedes
 * every legacy field: an ordered chain of up to five named steps. Normalized
 * to exactly what the editor writes, so an AI-built chain and a hand-built one
 * are the same object. A model that invents `stages` AND `approvers` gets the
 * chain and loses the panel — validation refuses the combination outright, and
 * the normalizer keeps the object self-consistent either way.
 * @param {ApprovalConfig} out
 * @param {ApprovalInput} src
 */
function normalizeStages(out, src) {
    if (!Array.isArray(src.stages) || !src.stages.length) return;
    /** @type {Stage[]} */
    const chain = [];
    const usedKeys = new Set();
    for (const raw of src.stages.slice(0, MAX_APPROVAL_STAGES)) {
        const stage = normalizeStage(raw, chain.length, usedKeys);
        if (stage) chain.push(stage);
    }
    if (!chain.length) return;
    out.stages = chain;
    // Legacy approver fields are dropped whole: a control that looks
    // configured and is never asked is the worst outcome.
    delete out.assignee;
    delete out.approvers;
    delete out.rule;
    delete out.quorum;
}

/**
 * Reminder + escalation clocks: the escalation needs BOTH a target and a
 * delay — half a config is dropped whole rather than persisted as a control
 * that silently does nothing. Escalation and a panel are mutually exclusive
 * (the final approver is the panel's takeover mechanism), so with a panel or
 * a chain present the escalation is dropped whole too.
 * @param {ApprovalConfig} out
 * @param {ApprovalInput} src
 */
function normalizeClocks(out, src) {
    const remind = clockHours(src.remindAfterHours);
    if (remind) out.remindAfterHours = remind;
    const escTarget = cleanSeat(src.escalateTo);
    const escAfter = clockHours(src.escalateAfterHours);
    if (escTarget && escAfter && !out.approvers && !out.stages) {
        out.escalateTo = escTarget;
        out.escalateAfterHours = escAfter;
    }
}

/**
 * What the approver is shown and asked. Attachments need a binding; the
 * question fields' shape is validate.js's job (validateFormDeclaration), the
 * normalizer only bounds the count and drops the types approvals refuse — an
 * upload and an app picker, neither of which the decision card renders.
 * @param {ApprovalConfig} out
 * @param {ApprovalInput} src
 */
function normalizeShown(out, src) {
    if (Array.isArray(src.attachments)) {
        const atts = src.attachments
            .filter((x) => x && typeof x === 'object' && nonBlank(x.binding))
            .slice(0, APPROVAL_MAX_ATTACHMENTS)
            .map((x) => ({ binding: x.binding, ...(nonBlank(x.label) ? { label: x.label } : {}) }));
        if (atts.length) out.attachments = atts;
    }
    if (Array.isArray(src.fields) && src.fields.length) {
        const fields = src.fields.filter((f) => f && typeof f === 'object' && !REFUSED_FIELD_TYPES.has(f.type)).slice(0, APPROVAL_MAX_FIELDS);
        if (fields.length) out.fields = fields;
    }
}

const REFUSED_FIELD_TYPES = new Set(['file', 'app_pick']);

/**
 * Rebuild — never merge — the approval config object. A model reaching for
 * an approval routinely invents keys (`reminderHours`, `approvers`, `cc`);
 * the engine reads none of them, and a configured-looking control that does
 * nothing is the worst outcome for a step a person relies on. Everything the
 * engine DOES read is normalized here to the exact shape the editor writes,
 * part by part and in this order (the key order of the stored object).
 * @param raw untrusted input (the model wrote it)
 * @returns {ApprovalConfig}
 */
function normalizeApprovalConfig(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    /** @type {ApprovalConfig} */
    const out = { expiresInHours: clampApprovalHours(src.expiresInHours) };
    const assignee = cleanSeat(src.assignee);
    if (assignee) out.assignee = assignee;
    if (nonBlank(src.details)) out.details = src.details;
    normalizePanel(out, src);
    normalizeStages(out, src);
    const finalApprover = cleanSeat(src.finalApprover);
    if (finalApprover && !out.stages) out.finalApprover = finalApprover;
    normalizeClocks(out, src);
    normalizeShown(out, src);
    return out;
}

function applyAddApproval(draft, args) {
    const step = {
        id: newId('appr'),
        type: 'approval',
        prompt: typeof args.prompt === 'string' ? args.prompt : '',
        approval: normalizeApprovalConfig(args),
        label: args.label || 'Approval',
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

module.exports = {
    normalizeApprovalConfig,
    applyAddApproval,
};

/**
 * @typedef {import('./draftGraph').DraftGraph} DraftGraph
 * @typedef {{ userId?: string, groupId?: string }} Seat
 * @typedef {{ key?: string, approvers?: Seat[], rule?: string, name?: string, description?: string,
 *   quorum?: number | string, when?: string }} StageInput
 * @typedef {{ key: string, approvers: Seat[], rule: string, name?: string, description?: string,
 *   quorum?: number, when?: string }} Stage
 * @typedef {{ expiresInHours?: string | number | null, assignee?: Seat, details?: string, approvers?: Seat[],
 *   rule?: string, quorum?: number | string, stages?: StageInput[], finalApprover?: Seat,
 *   remindAfterHours?: number | string, escalateTo?: Seat, escalateAfterHours?: number | string,
 *   attachments?: { binding?: string, label?: string }[], fields?: { type?: string }[] }} ApprovalInput
 * @typedef {{ expiresInHours: number, assignee?: Seat, details?: string, approvers?: Seat[], rule?: string,
 *   quorum?: number, stages?: Stage[], finalApprover?: Seat, remindAfterHours?: number, escalateTo?: Seat,
 *   escalateAfterHours?: number, attachments?: { binding: string, label?: string }[],
 *   fields?: { type?: string }[] }} ApprovalConfig
 */
