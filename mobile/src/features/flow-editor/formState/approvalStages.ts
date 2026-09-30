/**
 * The approval stage chain, mirroring server/automation/approvalStages.js and
 * builderTools.normalizeApprovalConfig, so a hand-built chain and an AI-built
 * one are the same object and the editor can never author a chain the server
 * refuses. From agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { arr, isObj } from '../bindings/json';

/** Product cap on the chain's length. */
export const MAX_APPROVAL_STAGES = 5;
/** Seats in ONE stage. */
export const MAX_SEATS_PER_STAGE = 10;
/** Seats across the WHOLE chain. */
export const MAX_TOTAL_STAGE_SEATS = 30;
export const MAX_STAGE_NAME_LEN = 60;
export const MAX_STAGE_DESCRIPTION_LEN = 200;
export const STAGE_RULES: readonly string[] = ['all', 'first', 'quorum'];

export type Seat = { userId: string } | { groupId: string };

/** One seat: exactly one of userId / groupId, or null. */
export function cleanApprovalSeat(raw: unknown): Seat | null {
    if (!isObj(raw)) return null;
    if (typeof raw.userId === 'string' && raw.userId.trim()) return { userId: raw.userId.trim() };
    if (typeof raw.groupId === 'string' && raw.groupId.trim()) return { groupId: raw.groupId.trim() };
    return null;
}

export function approvalSeatKey(seat: Seat): string {
    return 'userId' in seat && seat.userId ? `u:${seat.userId}` : `g:${(seat as { groupId: string }).groupId}`;
}

/** Real (picked) seats of one stage, de-duplicated and capped. */
export function stageSeats(stage: unknown): Seat[] {
    const seen = new Set<string>();
    const out: Seat[] = [];
    for (const raw of arr(isObj(stage) ? stage.approvers : null)) {
        const seat = cleanApprovalSeat(raw);
        if (!seat || seen.has(approvalSeatKey(seat))) continue;
        seen.add(approvalSeatKey(seat));
        out.push(seat);
        if (out.length >= MAX_SEATS_PER_STAGE) break;
    }
    return out;
}

/** Seats already committed across the chain. */
export function totalStageSeats(stages: unknown): number {
    return arr(stages).reduce<number>((n, st) => n + stageSeats(st).length, 0);
}

/**
 * A key for a stage added NOW: the lowest `sN` nobody uses — never positional,
 * or a reorder would hand a newcomer the key yesterday's votes are filed under.
 */
export function newStageKey(stages: unknown): string {
    const taken = new Set(
        arr(stages)
            .map((st) => (isObj(st) && typeof st.key === 'string' ? st.key.trim() : ''))
            .filter(Boolean),
    );
    for (let i = 1; i <= 99; i++) {
        const candidate = `s${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `s${Date.now().toString(36)}`;
}

function text(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** A stage's optional half: name, description, quorum, condition. */
function stageExtras(src: Record<string, unknown>, rule: string, seatCount: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
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

function stageKey(src: Record<string, unknown>, usedKeys: Set<string>): string {
    const own = typeof src.key === 'string' && src.key.trim() ? src.key.trim().slice(0, 40) : '';
    if (own && !usedKeys.has(own)) return own;
    return newStageKey([...usedKeys].map((k) => ({ key: k })));
}

/**
 * The draft chain → exactly what the server stores. A stage nobody sits in is
 * DROPPED (it would 400 the save); author keys are kept verbatim.
 */
export function sanitizeApprovalStages(raw: unknown): Record<string, unknown>[] {
    const chain: Record<string, unknown>[] = [];
    const usedKeys = new Set<string>();
    let totalSeats = 0;
    for (const src of arr(raw).slice(0, MAX_APPROVAL_STAGES)) {
        if (!isObj(src)) continue;
        const seats = stageSeats(src);
        if (!seats.length) continue;
        if (totalSeats + seats.length > MAX_TOTAL_STAGE_SEATS) break;
        totalSeats += seats.length;
        const key = stageKey(src, usedKeys);
        usedKeys.add(key);
        const rule = STAGE_RULES.includes(src.rule as string) ? (src.rule as string) : 'all';
        chain.push({ key, approvers: seats, rule, ...stageExtras(src, rule, seats.length) });
    }
    return chain;
}
