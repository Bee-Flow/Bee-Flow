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
 * Rebuild — never merge — the approval config object. A model reaching for
 * an approval routinely invents keys (`reminderHours`, `approvers`, `cc`);
 * the engine reads none of them, and a configured-looking control that does
 * nothing is the worst outcome for a step a person relies on. Everything the
 * engine DOES read is normalized here to the exact shape the editor writes.
 */
function normalizeApprovalConfig(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = { expiresInHours: clampApprovalHours(src.expiresInHours) };
    const a = src.assignee;
    if (a && typeof a === 'object') {
        if (typeof a.userId === 'string' && a.userId.trim()) out.assignee = { userId: a.userId.trim() };
        else if (typeof a.groupId === 'string' && a.groupId.trim()) out.assignee = { groupId: a.groupId.trim() };
    }
    if (typeof src.details === 'string' && src.details.trim()) out.details = src.details;
    // Panel (multiple approvers). Seats are cleaned like the assignee —
    // exactly one of userId/groupId per seat — deduped and capped at 10. A
    // panel present means the single assignee is dropped (validation refuses
    // the combination; the normalizer keeps the object self-consistent).
    const cleanSeat = (s) => {
        if (!s || typeof s !== 'object') return null;
        if (typeof s.userId === 'string' && s.userId.trim()) return { userId: s.userId.trim() };
        if (typeof s.groupId === 'string' && s.groupId.trim()) return { groupId: s.groupId.trim() };
        return null;
    };
    if (Array.isArray(src.approvers)) {
        const seen = new Set();
        const seats = [];
        for (const raw of src.approvers) {
            const seat = cleanSeat(raw);
            if (!seat) continue;
            const key = seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            seats.push(seat);
            if (seats.length >= 10) break;
        }
        if (seats.length) {
            out.approvers = seats;
            delete out.assignee;
            out.rule = ['all', 'first', 'quorum'].includes(src.rule) ? src.rule : 'all';
            if (out.rule === 'quorum') {
                const n = Math.round(Number(src.quorum));
                out.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seats.length) : Math.min(2, seats.length);
            }
        }
    }
    // ── Stages (sequential approvals) ────────────────────────────────
    // The modern shape, and the one that supersedes every legacy field: an
    // ordered chain of up to five named steps. Normalized here to exactly
    // what the editor writes, so an AI-built chain and a hand-built one are
    // the same object. A model that invents `stages` AND `approvers` gets the
    // chain and loses the panel — validation refuses the combination outright,
    // and the normalizer keeps the object self-consistent either way.
    if (Array.isArray(src.stages) && src.stages.length) {
        const chain = [];
        const usedKeys = new Set();
        for (const raw of src.stages.slice(0, MAX_APPROVAL_STAGES)) {
            if (!raw || typeof raw !== 'object') continue;
            const seen = new Set();
            const seats = [];
            for (const s of Array.isArray(raw.approvers) ? raw.approvers : []) {
                const seat = cleanSeat(s);
                if (!seat) continue;
                const k = seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
                if (seen.has(k)) continue;
                seen.add(k);
                seats.push(seat);
                if (seats.length >= MAX_SEATS_PER_STAGE) break;
            }
            if (!seats.length) continue;           // a stage nobody sits in can never be decided
            const rule = STAGE_RULES.includes(raw.rule) ? raw.rule : 'all';
            // Keys are what already-cast votes are filed under, so an
            // author-supplied one is preserved verbatim: re-saving an automation
            // mid-approval must not orphan the votes of a stage that already
            // ran. Only a collision or an absence gets a fresh positional key.
            let key = (typeof raw.key === 'string' && raw.key.trim()) ? raw.key.trim().slice(0, 40) : '';
            if (!key || usedKeys.has(key)) key = `s${chain.length + 1}`;
            while (usedKeys.has(key)) key = `${key}_${usedKeys.size}`;
            usedKeys.add(key);
            const stage = { key, approvers: seats, rule };
            if (typeof raw.name === 'string' && raw.name.trim()) stage.name = raw.name.trim().slice(0, MAX_STAGE_NAME_LEN);
            if (typeof raw.description === 'string' && raw.description.trim()) stage.description = raw.description.trim().slice(0, MAX_STAGE_DESCRIPTION_LEN);
            if (rule === 'quorum') {
                const n = Math.round(Number(raw.quorum));
                stage.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seats.length) : Math.min(2, seats.length);
            }
            if (typeof raw.when === 'string' && raw.when.trim()) stage.when = raw.when.trim();
            chain.push(stage);
        }
        if (chain.length) {
            out.stages = chain;
            // Legacy approver fields are dropped whole — see above: a control
            // that looks configured and is never asked is the worst outcome.
            delete out.assignee;
            delete out.approvers;
            delete out.rule;
            delete out.quorum;
        }
    }
    const finalApprover = cleanSeat(src.finalApprover);
    if (finalApprover && !out.stages) out.finalApprover = finalApprover;
    // Reminder + escalation clocks (v2). Whole hours 1..720; the escalation
    // needs BOTH a target and a delay — half a config is dropped whole rather
    // than persisted as a control that silently does nothing.
    const hours = (v) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= 1 ? Math.min(n, APPROVAL_MAX_EXPIRY_HOURS) : null;
    };
    const remind = hours(src.remindAfterHours);
    if (remind) out.remindAfterHours = remind;
    const et = src.escalateTo;
    const escTarget = (et && typeof et === 'object')
        ? (typeof et.userId === 'string' && et.userId.trim() ? { userId: et.userId.trim() }
            : (typeof et.groupId === 'string' && et.groupId.trim() ? { groupId: et.groupId.trim() } : null))
        : null;
    const escAfter = hours(src.escalateAfterHours);
    // Escalation and a panel are mutually exclusive (the final approver is
    // the panel's takeover mechanism) — with a panel present the escalation
    // is dropped whole, keeping the object self-consistent.
    if (escTarget && escAfter && !out.approvers && !out.stages) {
        out.escalateTo = escTarget;
        out.escalateAfterHours = escAfter;
    }
    if (Array.isArray(src.attachments)) {
        const atts = src.attachments
            .filter(x => x && typeof x === 'object' && typeof x.binding === 'string' && x.binding.trim())
            .slice(0, APPROVAL_MAX_ATTACHMENTS)
            .map(x => ({ binding: x.binding, ...(typeof x.label === 'string' && x.label.trim() ? { label: x.label } : {}) }));
        if (atts.length) out.attachments = atts;
    }
    if (Array.isArray(src.fields) && src.fields.length) {
        // Shape is validate.js's job (validateFormDeclaration); the normalizer
        // only bounds the count and drops the types approvals refuse — an
        // upload and an app picker, neither of which the decision card renders.
        const REFUSED = new Set(['file', 'app_pick']);
        const fields = src.fields.filter(f => f && typeof f === 'object' && !REFUSED.has(f.type)).slice(0, APPROVAL_MAX_FIELDS);
        if (fields.length) out.fields = fields;
    }
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
