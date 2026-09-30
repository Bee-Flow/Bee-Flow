/**
 * The approval step's draft and patch. The draft flattens `step.approval`; the
 * patch re-nests it in exactly the shape normalizeApprovalConfig
 * (server/automation/builderTools.js) produces, so a hand-built approval and an
 * AI-built one are the same object. A stage chain SUPERSEDES every legacy
 * approver field. From agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { approvalSeatKey, cleanApprovalSeat, sanitizeApprovalStages, type Seat } from './approvalStages';
import { clamp, get, num, objOr, oneOf, or } from './read';
import type { Extractor, FormDraft, Patcher } from './types';
import { arr, isObj } from '../bindings/json';

const RULES = ['all', 'first', 'quorum'];

/** The nested value first, the legacy top-level one second — the engine's own order. */
function expiresDraft(step: Record<string, unknown>): unknown {
    const nested = get(step.approval, 'expiresInHours');
    if (typeof nested === 'number') return nested;
    return num(step.expiresInHours, 168);
}

export const extractApproval: Extractor = (step, base) => {
    const a = objOr(step.approval, {}) as Record<string, unknown>;
    return {
        ...base,
        prompt: or(step.prompt, ''),
        expiresInHours: expiresDraft(step),
        assignee: objOr(a.assignee, null),
        details: or(a.details, ''),
        attachments: Array.isArray(a.attachments) ? a.attachments : [],
        approvalFields: Array.isArray(a.fields) ? a.fields : [],
        // v2 clocks: '' = off.
        remindAfterHours: num(a.remindAfterHours, ''),
        escalateTo: objOr(a.escalateTo, null),
        escalateAfterHours: num(a.escalateAfterHours, ''),
        approvers: Array.isArray(a.approvers) ? a.approvers : [],
        rule: oneOf(a.rule, RULES, 'all'),
        quorum: num(a.quorum, 2),
        finalApprover: objOr(a.finalApprover, null),
        // The persisted chain as-is: each stage's `key` is what cast votes are filed under.
        stages: Array.isArray(a.stages) ? a.stages : [],
    };
};

/** Absent → the 7-day default; 0 is the meaningful "no deadline". */
function expiresPatch(raw: unknown): number {
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) return 168;
    return clamp(Math.round(Number(raw)), 0, 720);
}

/** Whole hours 1..720, or null. */
function hoursOrNull(v: unknown): number | null {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 720) : null;
}

function attachmentsPatch(raw: unknown): unknown[] {
    return arr(raw)
        .filter((x) => isObj(x) && typeof x.binding === 'string' && x.binding.trim())
        .slice(0, 5)
        .map((x) => {
            const row = x as Record<string, unknown>;
            const label = row.label;
            return { binding: row.binding, ...(typeof label === 'string' && label.trim() ? { label } : {}) };
        });
}

function questionsPatch(raw: unknown): unknown[] {
    return arr(raw)
        .filter((f) => f && typeof f === 'object' && ((f as FormDraft).name || (f as FormDraft).label))
        .slice(0, 20);
}

/** Panel seats: cleaned, de-duplicated, capped at 10. */
function panelSeats(raw: unknown): Seat[] {
    const seen = new Set<string>();
    const out: Seat[] = [];
    for (const seat of arr(raw).map(cleanApprovalSeat)) {
        if (!seat || seen.has(approvalSeatKey(seat))) continue;
        seen.add(approvalSeatKey(seat));
        out.push(seat);
    }
    return out.slice(0, 10);
}

/** A panel drops the single assignee; the final approver is the panel's takeover. */
function applyPanel(cfg: Record<string, unknown>, seats: Seat[], draft: FormDraft): void {
    if (!seats.length) return;
    cfg.approvers = seats;
    delete cfg.assignee;
    cfg.rule = oneOf(draft.rule, RULES, 'all');
    if (cfg.rule !== 'quorum') return;
    const n = Math.round(Number(draft.quorum));
    cfg.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seats.length) : Math.min(2, seats.length);
}

/** Escalation is a target AND a delay or nothing, and never beside a panel or chain. */
function applyClocks(cfg: Record<string, unknown>, draft: FormDraft, chained: boolean): void {
    const remind = hoursOrNull(draft.remindAfterHours);
    if (remind) cfg.remindAfterHours = remind;
    const target = isObj(draft.escalateTo) ? cleanApprovalSeat(draft.escalateTo) : null;
    const after = hoursOrNull(draft.escalateAfterHours);
    if (target && after && !cfg.approvers && !chained) {
        cfg.escalateTo = target;
        cfg.escalateAfterHours = after;
    }
}

function legacyApprovers(cfg: Record<string, unknown>, draft: FormDraft): void {
    const assignee = cleanApprovalSeat(draft.assignee);
    if (assignee) cfg.assignee = assignee;
    applyPanel(cfg, panelSeats(draft.approvers), draft);
    const final = cleanApprovalSeat(draft.finalApprover);
    if (final) cfg.finalApprover = final;
}

function approvalConfig(draft: FormDraft): Record<string, unknown> {
    const cfg: Record<string, unknown> = { expiresInHours: expiresPatch(draft.expiresInHours) };
    const chain = sanitizeApprovalStages(draft.stages);
    if (chain.length) cfg.stages = chain;
    else legacyApprovers(cfg, draft);
    if (typeof draft.details === 'string' && draft.details.trim()) cfg.details = draft.details;
    const atts = attachmentsPatch(draft.attachments);
    if (atts.length) cfg.attachments = atts;
    const qs = questionsPatch(draft.approvalFields);
    if (qs.length) cfg.fields = qs;
    applyClocks(cfg, draft, chain.length > 0);
    return cfg;
}

export const patchApproval: Patcher = (patch, _step, draft) => {
    patch.prompt = or(draft.prompt, '');
    patch.approval = approvalConfig(draft);
    // One field owns the deadline: the legacy top-level one is removed.
    patch.expiresInHours = undefined;
};
