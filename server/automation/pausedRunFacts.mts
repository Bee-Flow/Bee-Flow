/**
 * What a run read adds for a run that is paused, or that a person tests:
 * GET /runs/:id and GET /runs/:runId/form (routes/automation/webhooksAndRunOps.js).
 *
 *   pendingApproval  the approval the journey waits on, as the approver sees it:
 *                    the prompt, the details and the fields of the approval row's
 *                    SNAPSHOT (never the working copy's step), whether the caller
 *                    may decide it (approvalRulebook.canDecide) and who it waits on
 *   profile          how the run runs: the stored run_profile when the row has one,
 *                    else derived from mode / is_test as today's rules do
 *   versionBehind    a test run of a version the working copy has moved past
 *
 * The approval row is read, never created: a GET does not backfill
 * (approvalService.ensureApprovalForRun is for the routes that decide).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
export type ProfileKind = 'production' | 'test' | 'dry';
export interface ProfileView {
    kind: ProfileKind;
    effects: string;
    pauses: string;
    approverSeat: { kind: string };
    stopAfterStepId: string | null;
}
export interface WaitingOn { stageName: string | null; seatCount: number }
export interface PendingApproval {
    approvalId: string;
    prompt: string;
    detailsMd: string | null;
    fields: unknown[];
    canDecide: boolean;
    waitingOn: WaitingOn;
    isTest: boolean;
}
export interface ApprovalViewer {
    userId: string;
    groupIds: string[];
    isOrgAdminOfOrg: (orgId: string) => boolean;
}
type ApprovalStore = { getApprovalForRunStep?: (runId: string, stepId: string, opts: { pendingOnly: boolean }) => Promise<Row | null> };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The profile a run row stored (WI-01's run_profile), as the row mapper exposes it, or null. */
function storedProfile(run: Row): Row | null {
    const p = run.runProfile ?? run.profile;
    return p && typeof p === 'object' ? p as Row : null;
}

/** Legacy rows: the kind today's isTestRun gives (a dry run, a test, or production). */
function derivedKind(run: Row): ProfileKind {
    if (run.mode === 'dry_run') return 'dry';
    const { isTestRun } = nodeRequire('../core/automationRunner/definitionForRun') as { isTestRun: (r: Row) => boolean };
    return isTestRun({ mode: run.mode ?? 'live', triggerKind: run.triggerKind ?? null, isTest: !!run.isTest }) ? 'test' : 'production';
}

/**
 * How this run runs, in the five facts the clients read (kind, effects, pauses,
 * approverSeat.kind, stopAfterStepId): the same shape whether the row stored a
 * profile or predates profiles.
 */
export function profileView(run: Row | null | undefined): ProfileView | null {
    if (!run) return null;
    const p = storedProfile(run);
    const seat = p?.approverSeat as Row | undefined;
    const kind: ProfileKind = p?.kind === 'production' || p?.kind === 'test' || p?.kind === 'dry' ? p.kind : derivedKind(run);
    return {
        kind,
        effects: str(p?.effects) ?? (kind === 'dry' ? 'simulated' : 'real'),
        // Before profiles a dry run synthesised its pauses; every other run paused for real.
        pauses: str(p?.pauses) ?? (kind === 'dry' ? 'synthesise' : 'real'),
        // The seat's KIND only: who the tester is stays on the run row.
        approverSeat: { kind: str(seat?.kind) ?? 'configured' },
        stopAfterStepId: str(p?.stopAfterStepId),
    };
}

/** A test (or dry) run of a version the working copy has moved past: "you have changed it since". */
export function versionBehind(run: Row | null | undefined, automation: Row | null | undefined, profile: ProfileView | null = profileView(run)): boolean {
    if (!run || !automation || !profile || profile.kind === 'production') return false;
    const working = Number(automation.version);
    const ran = Number(run.version);
    return Number.isFinite(working) && Number.isFinite(ran) && working > ran;
}

/** Who a pending approval waits on: the current stage's name and seats, a panel's seats, or one person. */
export function waitingOnOf(approval: Row): WaitingOn {
    const { hasStages, currentStage, hasPanel } = nodeRequire('./approvalRulebook') as {
        hasStages: (a: Row) => boolean; currentStage: (a: Row) => Row | null; hasPanel: (a: Row) => boolean;
    };
    if (hasStages(approval)) {
        const stage = currentStage(approval);
        const seats = Array.isArray(stage?.approvers) ? stage.approvers.length : 0;
        return { stageName: str(stage?.name) ?? str(stage?.key), seatCount: seats };
    }
    if (hasPanel(approval)) {
        return { stageName: null, seatCount: Array.isArray(approval.approvers) ? approval.approvers.length : 0 };
    }
    return { stageName: null, seatCount: 1 };
}

/**
 * The caller as approvalRulebook.canDecide reads them: their groups and whether
 * they administer an organisation. Read from the users table, not the session,
 * as routes/automation/approvals.js does.
 */
export async function approvalViewerFor(session: { user?: { id?: string; isAdmin?: boolean } } | null | undefined): Promise<ApprovalViewer | null> {
    const userId = session?.user?.id;
    if (!userId) return null;
    const userStore = nodeRequire('../stores/userStore') as { getUser: (id: string) => Promise<Row | null> };
    const user = await userStore.getUser(userId).catch(() => null);
    const { parseGroupIds } = nodeRequire('../auth/orgMembership') as { parseGroupIds: (u: Row) => unknown[] };
    const { isOrgAdminRole } = nodeRequire('../auth/permissions') as { isOrgAdminRole: (r: unknown) => boolean };
    const orgId = str(user?.organizationId);
    const isOrgAdmin = !!(user && (isOrgAdminRole(user.orgRole) || session?.user?.isAdmin));
    return {
        userId,
        groupIds: user ? parseGroupIds(user).map(String) : [],
        isOrgAdminOfOrg: (target: string) => !!(isOrgAdmin && orgId && String(target) === orgId),
    };
}

/**
 * The approval `run` (the journey's actionable leg) waits on, as the caller may
 * act on it; null when the run is not waiting on one or has no row.
 */
export async function pendingApprovalFor(run: Row | null | undefined, viewer: ApprovalViewer | null, store: ApprovalStore): Promise<PendingApproval | null> {
    const runId = str(run?.id);
    const stepId = str(run?.awaitingStepId);
    if (!run || run.status !== 'awaiting_approval' || !runId || !stepId || typeof store.getApprovalForRunStep !== 'function') return null;
    const approval = await store.getApprovalForRunStep(runId, stepId, { pendingOnly: true });
    if (!approval) return null;
    const { canDecide } = nodeRequire('./approvalRulebook') as { canDecide: (a: Row, v: ApprovalViewer | null) => boolean };
    const profile = profileView(run);
    return {
        approvalId: String(approval.id),
        prompt: typeof approval.prompt === 'string' ? approval.prompt : '',
        detailsMd: str(approval.detailsMd),
        fields: Array.isArray(approval.fields) ? approval.fields : [],
        canDecide: !!viewer && canDecide(approval, viewer),
        waitingOn: waitingOnOf(approval),
        isTest: typeof approval.isTest === 'boolean' ? approval.isTest : profile?.kind !== 'production',
    };
}
