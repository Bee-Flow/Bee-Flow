// ── Approval stage chain ───────────────────────────────────────────────
//
// Mirrors server/automation/approvalStages.js (the shared rulebook) and
// builderTools.normalizeApprovalConfig, so a hand-built chain and an
// AI-built one are the same object and the editor can never author a chain
// the server would refuse.

import type { FormRecord } from './types';

/** One approver seat: a person or a group, never both. */
export interface ApprovalSeat { userId?: string; groupId?: string }

/** Product cap on the chain's length. */
export const MAX_APPROVAL_STAGES = 5;
/** Seats in ONE stage. */
export const MAX_SEATS_PER_STAGE = 10;
/** Seats across the WHOLE chain — bounds the participant index and fan-out. */
export const MAX_TOTAL_STAGE_SEATS = 30;
export const MAX_STAGE_NAME_LEN = 60;
export const MAX_STAGE_DESCRIPTION_LEN = 200;
export const STAGE_RULES = ['all', 'first', 'quorum'];

/** One seat: exactly one of userId / groupId, or null. */
export function cleanApprovalSeat(raw: FormRecord | null | undefined): ApprovalSeat | null {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.userId === 'string' && raw.userId.trim()) return { userId: raw.userId.trim() };
    if (typeof raw.groupId === 'string' && raw.groupId.trim()) return { groupId: raw.groupId.trim() };
    return null;
}

export function approvalSeatKey(seat: ApprovalSeat): string {
    return seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
}

/** Real (picked) seats of one stage, de-duplicated and capped. */
export function stageSeats(stage: FormRecord | null | undefined): ApprovalSeat[] {
    const seen = new Set<string>();
    const out: ApprovalSeat[] = [];
    for (const raw of Array.isArray(stage?.approvers) ? stage.approvers : []) {
        const seat = cleanApprovalSeat(raw);
        if (!seat) continue;
        const key = approvalSeatKey(seat);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(seat);
        if (out.length >= MAX_SEATS_PER_STAGE) break;
    }
    return out;
}

/** Seats already committed across the chain — the 30-seat budget's numerator. */
export function totalStageSeats(stages: unknown): number {
    return (Array.isArray(stages) ? stages : []).reduce((n, st) => n + stageSeats(st).length, 0);
}

/**
 * A key for a stage the author is adding NOW.
 *
 * Keys are what already-cast votes are filed under, so they must be unique
 * within the chain AND stable for every stage that already exists. Positional
 * keys would satisfy neither: inserting a stage at the front would hand the
 * newcomer the key of the stage that ran yesterday, and the normalizer would
 * then push the old one onto a fresh key — orphaning its votes. So a new
 * stage takes the lowest `sN` nobody in the chain is using.
 */
export function newStageKey(stages: unknown): string {
    const taken = new Set((Array.isArray(stages) ? stages : [])
        .map(st => (typeof st?.key === 'string' ? st.key.trim() : ''))
        .filter(Boolean));
    for (let i = 1; i <= 99; i++) {
        const candidate = `s${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `s${Date.now().toString(36)}`;
}

/**
 * The draft chain → exactly what the server stores.
 *
 * A stage nobody sits in is DROPPED rather than persisted: validate.js treats
 * `approval.stages_invalid` as an integrity problem (it is not in
 * COMPLETENESS_CODES), so a half-picked stage in the payload would 400 the
 * whole automation's save. The editor says so on the row instead of letting the
 * save fail. Author keys are preserved verbatim — only an absent or colliding
 * key is replaced.
 */
export function sanitizeApprovalStages(raw: unknown): FormRecord[] {
    const chain: FormRecord[] = [];
    const usedKeys = new Set<string>();
    let totalSeats = 0;
    for (const src of (Array.isArray(raw) ? raw : []).slice(0, MAX_APPROVAL_STAGES)) {
        if (!src || typeof src !== 'object') continue;
        const seats = stageSeats(src);
        if (!seats.length) continue;
        if (totalSeats + seats.length > MAX_TOTAL_STAGE_SEATS) break;
        totalSeats += seats.length;
        let key = (typeof src.key === 'string' && src.key.trim()) ? src.key.trim().slice(0, 40) : '';
        if (!key || usedKeys.has(key)) key = newStageKey([...usedKeys].map(k => ({ key: k })));
        usedKeys.add(key);
        const rule = STAGE_RULES.includes(src.rule) ? src.rule : 'all';
        chain.push({ key, approvers: seats, rule, ...stageExtras(src, rule, seats.length) });
    }
    return chain;
}

/** A stage's optional half: name, description, quorum, condition. */
function stageExtras(src: FormRecord, rule: string, seatCount: number): FormRecord {
    const out: FormRecord = {};
    const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const name = text(src.name, MAX_STAGE_NAME_LEN);
    if (name) out.name = name;
    const description = text(src.description, MAX_STAGE_DESCRIPTION_LEN);
    if (description) out.description = description;
    if (rule === 'quorum') {
        const n = Math.round(Number(src.quorum));
        out.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), seatCount) : Math.min(2, seatCount);
    }
    const when = text(src.when, 2000);
    if (when) out.when = when;
    return out;
}
