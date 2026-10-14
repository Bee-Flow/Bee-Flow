/**
 * Shapes of the approval rows and responses the Approvals section reads.
 * The server owns them; these describe what the screens rely on.
 */

export interface ApprovalVote {
    name?: string | null;
    by?: string | null;
    decision?: string;
    reason?: string | null;
    stage?: string | null;
}

export interface ApprovalStage {
    key?: string;
    name?: string | null;
    description?: string | null;
    skipped?: boolean;
    state: string;
    rule: string;
    needed: number;
    seatCount: number;
    approvals: number;
    rejects: number;
    votes?: ApprovalVote[] | null;
}

export interface ApprovalField {
    name: string;
    label?: string | null;
    type?: string;
    required?: boolean;
    help?: string | null;
    placeholder?: string | null;
    options?: Array<{ value?: string; label?: string } | string> | null;
}

export interface ApprovalAttachment {
    fileId: string;
    label?: string | null;
    filename?: string | null;
    size?: number | null;
}

export interface ApprovalData {
    id: string;
    status: string;
    prompt?: string | null;
    automationTitle?: string | null;
    source?: string | null;
    context?: Record<string, unknown> | null;
    stage?: string | null;
    stages?: Array<ApprovalStage | null> | null;
    assigneeUserId?: string | null;
    assigneeGroupId?: string | null;
    ownerId?: string | null;
    createdAt?: string | null;
    expiresAt?: string | null;
    decidedAt?: string | null;
    decidedByName?: string | null;
    decisionReason?: string | null;
    detailsMd?: string | null;
    attachments?: ApprovalAttachment[] | null;
    approvers?: unknown[] | null;
    answers?: Record<string, unknown> | null;
    fields?: ApprovalField[] | null;
}

export interface ApprovalPosition {
    index: number;
    total: number;
}

export interface ApprovalProgress {
    kind?: string;
    stage?: string | null;
    rule?: string;
    needed?: number;
    seatCount?: number;
    approvals?: number;
    hasFinalStage?: boolean;
    stages?: ApprovalStage[];
    position?: ApprovalPosition | null;
}

export interface ApprovalAuditEvent {
    id: string;
    ts?: string | null;
    decision?: string;
    source?: string | null;
    comment?: string | null;
    decidedBy?: string | null;
}

export interface ApprovalDetailData {
    approval: ApprovalData;
    audit?: ApprovalAuditEvent[] | null;
    runLink?: string | null;
    canDecide?: boolean;
    canWithdraw?: boolean;
    votes?: ApprovalVote[] | null;
    progress?: ApprovalProgress | null;
}

export interface ApprovalDecideResponse {
    decision?: string;
    stage?: string | null;
    progress?: ApprovalProgress | null;
    approval?: ApprovalData | null;
}

export interface ApprovalWithdrawResponse {
    approval?: ApprovalData | null;
}

export interface ApprovalListResponse {
    approvals?: ApprovalData[] | null;
    nextCursor?: string | null;
}

export interface ApprovalFacets {
    status?: Record<string, number>;
}

export interface ApprovalFacetsResponse {
    facets?: ApprovalFacets | null;
}
