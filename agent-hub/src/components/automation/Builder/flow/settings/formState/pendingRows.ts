// ── Pending rows — added, not yet fillable on the wire ─────────────────
//
// "Add a document" (an approver seat, a stage) seeds an EMPTY row the user is
// about to fill in. buildPatch rightly refuses to persist it — an attachment
// without a binding, a seat naming nobody, a stage with no approvers mean
// nothing to the engine — so the row exists only in the form's local draft.
// That used to make it vanish out from under the user: the debounce saved a
// patch that (correctly) lacked the row, the save's echo came back as fresh
// step content over a seemingly edit-free draft, and the content sync adopted
// it — erasing the input about a second after they clicked Add.
//
// carryPendingRows is the sync's antidote: when adopting incoming step
// content, re-apply the draft rows the wire could not carry. Each predicate
// MIRRORS buildPatch's own filter — a row is pending exactly while buildPatch
// would drop it — so the moment a row becomes persistable (binding filled,
// person picked) it stops being carried here and starts being carried by the
// save itself.

import { cleanApprovalSeat, stageSeats } from './approvalStages';
import type { FormRecord } from './types';

const pendingAttachment = (row: FormRecord | null | undefined): boolean =>
    !!row && typeof row === 'object' && !(typeof row.binding === 'string' && row.binding.trim());
const pendingQuestion = (row: FormRecord | null | undefined): boolean =>
    !!row && typeof row === 'object' && !row.name && !row.label;
const pendingSeat = (seat: FormRecord | null | undefined): boolean => !cleanApprovalSeat(seat);

export function carryPendingRows(incoming: FormRecord, prev: FormRecord | null | undefined): FormRecord {
    if (!prev || typeof prev !== 'object') return incoming;
    let out = incoming;
    const carryList = (field: string, isPending: (row: FormRecord | null | undefined) => boolean) => {
        const rows = Array.isArray(prev[field]) ? prev[field].filter(isPending) : [];
        if (!rows.length) return;
        out = { ...out, [field]: [...(Array.isArray(out[field]) ? out[field] : []), ...rows] };
    };
    carryList('attachments', pendingAttachment);
    carryList('approvalFields', pendingQuestion);
    carryList('approvers', pendingSeat);

    // Stages carry at two levels. A stage with no picked approvers is pending
    // as a WHOLE (sanitizeApprovalStages drops it, name and description
    // included — losing a typed name with it). A persisted stage can also
    // hold a freshly added, still-empty SEAT row; that seat is re-applied to
    // the same stage in the incoming chain, matched by key — the one stage
    // identifier that survives renames and reorders.
    if (Array.isArray(prev.stages) && prev.stages.length) {
        const wholes = prev.stages.filter(st => st && typeof st === 'object' && stageSeats(st).length === 0);
        const pendingSeatsByKey = new Map<string, FormRecord[]>();
        for (const st of prev.stages) {
            if (!st || typeof st !== 'object' || stageSeats(st).length === 0) continue;
            const seats = (Array.isArray(st.approvers) ? st.approvers : []).filter(pendingSeat);
            if (seats.length && typeof st.key === 'string') pendingSeatsByKey.set(st.key, seats);
        }
        if (wholes.length || pendingSeatsByKey.size) {
            const base = Array.isArray(out.stages) ? out.stages : [];
            const merged = base.map(st => {
                const seats = st && pendingSeatsByKey.get(st.key);
                return seats
                    ? { ...st, approvers: [...(Array.isArray(st.approvers) ? st.approvers : []), ...seats] }
                    : st;
            });
            out = { ...out, stages: [...merged, ...wholes] };
        }
    }
    return out;
}
