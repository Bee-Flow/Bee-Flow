import type { OrgUser } from './accessAuditLabels';
import type { SetHeaderActions } from './audits/useHeaderPrimary';

export interface ObligationDraft {
    kind: string;
    subject: string;
    title: string;
    due_at: string;
    recur_months: string;
    owner_user_id: string;
}

/** One member of the personnel list. */
export interface Person {
    id?: string | null;
    user_id: string;
    displayName?: string | null;
    email?: string | null;
    policy_acks?: number | null;
    policy_total?: number | null;
    learning_done?: number | null;
    attested_at?: string | null;
    attested_note?: string | null;
}

/** One row of the obligation clock. */
export interface Obligation {
    id: number | string;
    kind?: string | null;
    subject?: string | null;
    title: string;
    due_at: string;
    completed_at?: string | null;
    recur_months?: number | null;
    owner_user_id?: string | null;
}

export interface TrainingState {
    personnel?: Person[] | null;
    obligations?: Obligation[] | null;
    busyId?: string | number | null;
    attest?: (userId: string, note: string | undefined) => unknown;
    createObligation?: (fields: {
        kind: string;
        subject: string | undefined;
        title: string;
        due_at: string;
        recur_months: number | undefined;
        owner_user_id: string | undefined;
    }) => unknown;
    completeObligation?: (id: number | string) => unknown;
}

export interface TrainingPageArgs {
    data?: { training?: TrainingState; orgUsers?: OrgUser[] | null } | undefined;
    isMobile?: boolean | undefined;
    setHeaderActions?: SetHeaderActions;
}
