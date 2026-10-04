import type { ApprovalStage, SettingsPart } from './stageSettingsModel';

/**
 * The two shapes of an approval seat binding: an automation holds seat objects
 * (`assignee: {userId}`, `approvers: [...]`), an app's approval step holds flat
 * ids (`assigneeUserId`, `approverUserIds`). The editor works on one edit shape
 * and writes the flavour the part that needs the slot understands.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
export const seatOf = (v: unknown): boolean => isObject(v) && (nonEmpty(v.userId) || nonEmpty(v.groupId));

// ── Seat shapes: the automation flavour and the app flavour ──────────────────

export interface SeatEdit {
    assignee?: Json | null; approvers?: Array<Json | null>; escalateTo?: Json | null; finalApprover?: Json | null;
    stages?: ApprovalStage[]; rule?: string; quorumCount?: number;
}

const APP_PAIRS: Array<[string, string, 'assignee' | 'escalateTo' | 'finalApprover']> = [
    ['assigneeUserId', 'assigneeGroupId', 'assignee'],
    ['escalateToUserId', 'escalateToGroupId', 'escalateTo'],
    ['finalApproverUserId', 'finalApproverGroupId', 'finalApprover'],
];

export type SeatFlavour = 'automation' | 'app';

/** An app's approval step holds flat ids; an automation's holds seat objects. */
export function seatFlavour(value: unknown): SeatFlavour {
    if (!isObject(value)) return 'automation';
    const flat = ['approverUserIds', 'approverGroupIds', ...APP_PAIRS.flatMap(p => [p[0], p[1]])];
    return flat.some(k => k in value) ? 'app' : 'automation';
}

export function toSeatEdit(value: unknown): SeatEdit {
    if (!isObject(value)) return {};
    if (seatFlavour(value) === 'automation') return value as SeatEdit;
    const out: SeatEdit = {};
    for (const [u, g, key] of APP_PAIRS) {
        if (nonEmpty(value[u])) out[key] = { userId: value[u] as string };
        else if (nonEmpty(value[g])) out[key] = { groupId: value[g] as string };
    }
    const users = Array.isArray(value.approverUserIds) ? (value.approverUserIds as unknown[]).filter(nonEmpty).map(userId => ({ userId })) : [];
    const groups = Array.isArray(value.approverGroupIds) ? (value.approverGroupIds as unknown[]).filter(nonEmpty).map(groupId => ({ groupId })) : [];
    if (users.length || groups.length) out.approvers = [...users, ...groups];
    for (const k of ['stages', 'rule', 'quorumCount'] as const) if (value[k] !== undefined) (out as Json)[k] = value[k];
    return out;
}

const cleanSeat = (s: unknown): Json | null => (seatOf(s) ? (nonEmpty((s as Json).userId) ? { userId: (s as Json).userId } : { groupId: (s as Json).groupId }) : null);

/** The edit shape back to what the binding stores: only picked seats, nothing empty. */
export function fromSeatEdit(edit: SeatEdit, flavour: SeatFlavour): Json {
    const out: Json = {};
    const single = (key: 'assignee' | 'escalateTo' | 'finalApprover') => cleanSeat(edit[key]);
    const picked = (Array.isArray(edit.approvers) ? edit.approvers : []).map(cleanSeat).filter((s): s is Json => !!s);
    if (flavour === 'automation') {
        for (const key of ['assignee', 'escalateTo', 'finalApprover'] as const) { const s = single(key); if (s) out[key] = s; }
        if (picked.length) out.approvers = picked;
    } else {
        for (const [u, g, key] of APP_PAIRS) {
            const s = single(key);
            if (s) out[s.userId ? u : g] = s.userId ?? s.groupId;
        }
        const users = picked.filter(s => s.userId).map(s => s.userId);
        const groups = picked.filter(s => s.groupId).map(s => s.groupId);
        if (users.length) out.approverUserIds = users;
        if (groups.length) out.approverGroupIds = groups;
    }
    if (Array.isArray(edit.stages) && edit.stages.length) out.stages = edit.stages;
    if (edit.rule && edit.rule !== 'all') out.rule = edit.rule;
    if (edit.rule === 'quorum' && Number.isFinite(Number(edit.quorumCount))) out.quorumCount = Number(edit.quorumCount);
    return out;
}

/** A stage chain being edited holds empty seat rows; what is sent has only picked seats and no empty stage. */
export function cleanBindingValue(value: unknown): unknown {
    if (!isObject(value) || !Array.isArray(value.stages)) return value;
    const stages = (value.stages as ApprovalStage[])
        .map(st => ({ ...st, approvers: (st.approvers || []).filter(seatOf) }))
        .filter(st => st.approvers.length > 0);
    return { ...value, stages };
}

export function seatShapeHasSeat(value: Json): boolean {
    const edit = toSeatEdit(value);
    if (['assignee', 'escalateTo', 'finalApprover'].some(k => seatOf((edit as Json)[k]))) return true;
    if ((edit.approvers || []).some(seatOf)) return true;
    return (edit.stages || []).some(st => (st.approvers || []).some(seatOf));
}

/**
 * The flavour a slot is written in. The KIND of the part that needs it decides
 * (an app's `request_approval` holds flat ids, an automation's holds seat
 * objects); the shape of the value is only the fallback when no needing part is
 * known, because a suggestion that carries no flat key looks like the other one.
 */
export function slotSeatFlavour(neededBy: string[], parts: Array<Pick<SettingsPart, 'ref' | 'kind'>>, value: unknown): SeatFlavour {
    const kinds = neededBy.map(ref => parts.find(p => p.ref === ref)?.kind).filter((k): k is string => !!k);
    if (kinds.includes('app')) return 'app';
    if (kinds.length > 0) return 'automation';
    return seatFlavour(value);
}
