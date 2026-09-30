/**
 * Pending rows — added, not yet fillable on the wire. "Add a document", an
 * approver seat, a stage: the row exists only in the draft until it holds
 * something buildPatch will persist. When the editor adopts fresh step content
 * after a save, `carryPendingRows` re-applies those rows so they don't vanish
 * a second after the user tapped Add. Each predicate MIRRORS buildPatch's own
 * filter. From agent-hub `Builder/flow/settings/formState.js`.
 */

import { cleanApprovalSeat, stageSeats } from './approvalStages';
import type { FormDraft } from './types';
import { arr, isObj, isObjectLike } from '../bindings/json';

// `typeof row === 'object'`, arrays included, exactly as the web reads it.
const valueAt = (row: unknown, key: string) => (row as Record<string, unknown>)[key];
const pendingAttachment = (row: unknown) => {
    const binding = isObjectLike(row) ? valueAt(row, 'binding') : undefined;
    return isObjectLike(row) && !(typeof binding === 'string' && binding.trim());
};
const pendingQuestion = (row: unknown) => isObjectLike(row) && !valueAt(row, 'name') && !valueAt(row, 'label');
const pendingSeat = (seat: unknown) => !cleanApprovalSeat(seat);

function carryList(out: FormDraft, prev: FormDraft, field: string, isPending: (row: unknown) => boolean): FormDraft {
    const rows = arr(prev[field]).filter(isPending);
    if (!rows.length) return out;
    return { ...out, [field]: [...arr(out[field]), ...rows] };
}

/** Stages carry at two levels: a whole stage with no seats, or a fresh empty seat inside a kept one. */
function carryStages(out: FormDraft, prevStages: unknown[]): FormDraft {
    const wholes = prevStages.filter((st) => isObjectLike(st) && stageSeats(st).length === 0);
    const pendingSeatsByKey = new Map<unknown, unknown[]>();
    for (const st of prevStages) {
        if (!isObj(st) || stageSeats(st).length === 0) continue;
        const seats = arr(st.approvers).filter(pendingSeat);
        if (seats.length && typeof st.key === 'string') pendingSeatsByKey.set(st.key, seats);
    }
    if (!wholes.length && !pendingSeatsByKey.size) return out;
    const merged = arr(out.stages).map((st) => {
        const seats = isObj(st) ? pendingSeatsByKey.get(st.key) : undefined;
        return seats ? { ...(st as object), approvers: [...arr((st as FormDraft).approvers), ...seats] } : st;
    });
    return { ...out, stages: [...merged, ...wholes] };
}

export function carryPendingRows(incoming: FormDraft, prev: FormDraft | null | undefined): FormDraft {
    if (!prev || typeof prev !== 'object') return incoming;
    let out = carryList(incoming, prev, 'attachments', pendingAttachment);
    out = carryList(out, prev, 'approvalFields', pendingQuestion);
    out = carryList(out, prev, 'approvers', pendingSeat);
    const stages = arr(prev.stages);
    return stages.length ? carryStages(out, stages) : out;
}
