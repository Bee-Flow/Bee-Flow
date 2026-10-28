import type { ApprovalListRow } from './useApprovals';
import type { ApprovalField } from './ApprovalDecisionControls';
import type useAutomationApi from '@/hooks/useAutomationApi';
import type { TranslateParams } from '@/hooks/useTranslation';
import type React from 'react';

/** One vote on a panel or stage. */
export interface ApprovalVote {
    decision?: string;
    name?: string;
    by?: string;
    stage?: string;
    reason?: string;
}

/** Where a staged row sits in its chain ("stage 2 of 3"). */
export interface StagePosition {
    index: number;
    total: number;
}

/** One stage of a staged chain, with its running tally. */
export interface ApprovalStage {
    key?: string;
    name?: string;
    description?: string;
    state?: string;
    rule?: string;
    needed: number;
    seatCount: number;
    approvals: number;
    rejects: number;
    votes?: ApprovalVote[];
}

/** A staged row's progress: the whole chain. */
export interface StagedProgress {
    kind: 'stages';
    stages?: ApprovalStage[];
    stage?: string;
    position?: StagePosition;
}

/** A panel row's progress: one tally and no `kind`. */
export interface PanelProgressData {
    kind?: undefined;
    rule: string;
    stage: string;
    seatCount: number;
    approvals: number;
    rejects: number;
    needed: number;
    hasFinalStage: boolean;
}

export type ApprovalProgress = StagedProgress | PanelProgressData;

export interface ApprovalAttachment {
    fileId: string;
    label?: string;
    filename?: string;
    size?: number;
}

/** One line of the audit strip. */
export interface AuditEvent {
    id: string | number;
    ts: string | number | Date | null;
    decision?: string;
    source?: string;
    comment?: string | null;
    decidedBy?: string | null;
}

/** The approval row as the detail view reads it. */
export interface ApprovalRecord extends ApprovalListRow {
    approvers?: unknown[];
    detailsMd?: string;
    attachments?: ApprovalAttachment[];
    fields?: ApprovalField[];
    decidedAt?: string | null;
    decisionReason?: string | null;
    answers?: Record<string, unknown> | null;
}

/** GET /approvals/:id. */
export interface ApprovalDetailData {
    approval: ApprovalRecord;
    audit?: AuditEvent[];
    runLink?: string | null;
    canDecide?: boolean;
    canWithdraw?: boolean;
    votes?: ApprovalVote[];
    progress?: ApprovalProgress | null;
}

/** The answer to a decision or a withdrawal. */
export interface ApprovalDecisionResponse {
    decision?: string;
    stage?: string;
    progress: Partial<StagedProgress>;
    approval?: ApprovalRecord;
}

/** The approvals calls of the automation API, with the shapes this view reads. */
export type ApprovalApi = Omit<ReturnType<typeof useAutomationApi>, 'getApproval' | 'decideApproval' | 'withdrawApproval'> & {
    getApproval: (id: string) => Promise<ApprovalDetailData>;
    decideApproval: (id: string, decision: string, reason?: string, answers?: unknown) => Promise<ApprovalDecisionResponse>;
    withdrawApproval: (id: string, reason?: string) => Promise<ApprovalDecisionResponse>;
};

export type TFn = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

/**
 * The approval, as the person deciding it needs to see it: the question, the
 * snapshotted context (details / attachments / extra questions), the deadline,
 * and the decision controls — with the audit strip underneath so "who asked,
 * who decided, when" is always one glance away.
 *
 * Everything renders from the SNAPSHOT on the approval row. Nothing here
 * re-derives from the run: the approver judges what the run showed at pause
 * time, and the record keeps meaning the same thing years later.
 */
export interface ApprovalDetailProps {
    approvalId: string;
    onBack: () => void;
    onDecided: (fresh: ApprovalListRow) => void;
}

/**
 * A block of the approval, separated from the one above it by a hairline
 * rather than wrapped in its own card. The old detail nested three levels of
 * border — page card → progress box → stage row — which is what made a short
 * approval read as a dense form. One rule between sections carries the same
 * "these belong apart" without any of the weight.
 */
export interface SectionProps {
    label?: string;
    aside?: React.ReactNode;
    children?: React.ReactNode;
}

/** Status as a coloured dot and a word — see approvalStatusChip. */
export interface StatusLabelProps {
    status: string | null | undefined;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

/**
 * The panel at a glance: the rule, how far the votes have got, each vote as
 * its own line, and — in the second stage — who holds the final word. Renders
 * from the server's progress/votes payload only, so this view and the vote
 * engine cannot disagree about the arithmetic.
 */
export interface PanelProgressProps {
    progress: PanelProgressData;
    votes?: ApprovalVote[];
    approval: ApprovalRecord;
    t: TFn;
}

/**
 * The chain, as a vertical stepper.
 *
 * Every stage the approval was created with is shown — including the ones it
 * will never reach and the ones its conditions ruled out. "Why did this never
 * get to finance?" is an audit question, and a stage that quietly vanished
 * from the timeline cannot answer it. So the five states each get their own
 * marker and their own sentence:
 *
 *   done          decided, and the chain moved past it
 *   current       the people being asked right now
 *   waiting       still to come
 *   skipped       its condition was not met — deliberately passed over
 *   never_reached the chain stopped (declined / expired / withdrawn) first
 *
 * Rendered from the server's payload only, so this view and the vote engine
 * cannot disagree about the arithmetic.
 */
export interface StageTimelineProps {
    progress: StagedProgress;
    approval: ApprovalRecord;
    t: TFn;
}

/**
 * One stage. The marker column carries a connector line so the chain reads as
 * one sequence rather than five cards; the line stops being solid once the
 * chain does, which is what makes `never_reached` legible at a glance.
 */
export interface StageStepProps {
    stage: ApprovalStage;
    position: StagePosition | null;
    last: boolean;
    t: TFn;
}

export interface BackButtonProps {
    onBack: React.MouseEventHandler<HTMLButtonElement>;
}
