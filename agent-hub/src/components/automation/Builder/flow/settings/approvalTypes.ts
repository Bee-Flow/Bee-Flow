// The shapes the approval editor's sections share. The editor itself is
// JavaScript and hands its draft down untyped; these name the members each
// section actually reads.
import type { ApprovalSeat } from './formState/approvalStages';

/** A seat the author has picked, or null for a seat still to be picked. */
export type SeatSlot = ApprovalSeat | null;

/** `set('field', value)` on the step's draft. */
export type SetDraft = (key: string, value: unknown) => void;

export interface DirectoryEntry { id: string; name: string }

/** The org directory that feeds the approver pickers. */
export interface ApprovalDirectory { members: DirectoryEntry[]; groups: DirectoryEntry[] }

/** One "Documents to show" row. */
export interface ApprovalAttachmentRow { binding?: string; label?: string }

/** One extra question collected with the decision. */
export interface ApprovalQuestionRow {
    name?: string;
    label?: string;
    type?: string;
    required?: boolean;
    options?: unknown;
}

/** The members of the step draft the approval editor reads. */
export interface ApprovalDraft {
    prompt?: string;
    details?: string;
    expiresInHours?: unknown;
    remindAfterHours?: unknown;
    escalateAfterHours?: unknown;
    assignee?: SeatSlot;
    approvers?: SeatSlot[];
    finalApprover?: SeatSlot;
    escalateTo?: SeatSlot;
    rule?: string;
    quorum?: unknown;
    stages?: unknown[];
    attachments?: ApprovalAttachmentRow[];
    approvalFields?: ApprovalQuestionRow[];
}

/** A seat as the value one <select> encodes: '' (none), 'u:<id>', 'g:<id>'. */
export function seatSelectValue(seat: SeatSlot | undefined): string {
    if (seat?.userId) return `u:${seat.userId}`;
    if (seat?.groupId) return `g:${seat.groupId}`;
    return '';
}

/** The reverse of `seatSelectValue`: the persisted { userId } | { groupId }, or null for ''. */
export function seatFromSelectValue(encoded: string): SeatSlot {
    if (!encoded) return null;
    return encoded.slice(0, 1) === 'u' ? { userId: encoded.slice(2) } : { groupId: encoded.slice(2) };
}
