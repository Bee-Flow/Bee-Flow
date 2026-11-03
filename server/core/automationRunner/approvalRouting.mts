/**
 * approvalRouting.mts: the routing columns of a run approval's row, decided
 * from the run's profile when the run pauses (approvalLifecycle.createApprovalOnPause).
 *
 *   configured  a production run (and a legacy row, whose derived profile is
 *               'configured'): the step's chain, panel or single assignee
 *               through the org gate, the remind / escalate clocks and the
 *               escalation target, exactly as an approval has always been written
 *   tester      a test or dry run (the sandbox seat, D2): one assignee, the
 *               person who started the run (else the owner), who decides alone
 *               for every approver. No stages, no panel, no clocks: nobody else
 *               is ever asked, so there is nobody to remind or escalate to. The
 *               row is marked is_test and keeps the configured routing
 *               (configured_routing) for the "in production this goes to ..."
 *               preview, never to route.
 *
 * Also the one heads-up a live test run sends at an approval (testerBell): a
 * bell to the tester, "Test: approval needed in <automation>". A dry run sends
 * nothing; the author is watching the canvas.
 *
 * Pure: the org gate and the stage helpers arrive as `deps`
 * (approvalSeats.js, automationModel/approvalStages.js), so this file requires
 * nothing (lint:scc-ratchet).
 */

export type Seat = { userId?: string | null; groupId?: string | null };
export type Stage = {
    key?: string;
    name?: string | null;
    rule?: string | null;
    quorum?: number | null;
    skipped?: boolean;
    approvers?: Seat[] | null;
};

/** What the paused approval step asks for (the ApprovalRequiredError's fields this file reads). */
export type PauseRequest = {
    stages?: Stage[] | null;
    approvers?: Seat[] | null;
    assignee?: Seat | null;
    finalApprover?: Seat | null;
    rule?: unknown;
    quorum?: unknown;
    escalateTo?: Seat | null;
    remindAfterHours?: unknown;
    escalateAfterHours?: unknown;
    expiresAt?: string | null;
};

export type RoutingDeps = {
    validateStages: (stages: Stage[] | null, orgId: string | null, ownerId: string) => Promise<Stage[] | null>;
    validatePanel: (approvers: Seat[] | null, orgId: string | null) => Promise<Seat[] | null>;
    validateAssignee: (assignee: Seat | null, orgId: string | null) => Promise<Seat | null>;
    firstStageKey: (stages: Stage[]) => string | null;
    stageByKey: (stages: Stage[], key: string) => Stage | null;
    collectParticipants: (stages: Stage[]) => Seat[];
};

export type Routing = {
    stages: Stage[] | null;
    firstKey: string | null;
    firstStage: Stage | null;
    approvers: Seat[] | null;
    assignee: Seat | null;
    finalApprover: Seat | null;
};

export type ConfiguredRouting = {
    runKind: 'test' | 'dry';
    stages: Array<{ key: string | null; name: string | null; rule: string; quorum: number | null; skipped: boolean; approvers: Seat[] }> | null;
    approvers: Seat[] | null;
    rule: string | null;
    quorum: number | null;
    assignee: Seat | null;
    finalApprover: Seat | null;
};

export type SeatColumns = {
    assigneeUserId: string | null;
    assigneeGroupId: string | null;
    remindAt: string | null;
    escalateAt: string | null;
    escalateToUserId: string | null;
    escalateToGroupId: string | null;
    approvers: Seat[] | null;
    approvalRule: string | null;
    quorumCount: number | null;
    finalApproverUserId: string | null;
    finalApproverGroupId: string | null;
    stages: Stage[] | null;
    stageParticipants: Seat[] | null;
    stageKey: string | null;
    isTest?: boolean;
    sandboxUserId?: string | null;
    configuredRouting?: ConfiguredRouting | null;
};

/** The parts of a run profile (automationModel/runProfile.mts) the seat reads. */
export type SeatProfile = {
    kind: 'production' | 'test' | 'dry';
    approverSeat: { kind: 'configured' } | { kind: 'tester'; userId: string | null };
    notify: { tester: boolean };
};

const RULES: ReadonlySet<string> = new Set(['all', 'first', 'quorum']);

/**
 * Hours-from-now to timestamps, with one rule: a clock that would fire AFTER
 * the deadline is dropped. Reminding someone about an approval that already
 * expired is worse than silence.
 */
export function approvalClocks(
    { remindAfterHours = null, escalateAfterHours = null, expiresAt = null }: { remindAfterHours?: unknown; escalateAfterHours?: unknown; expiresAt?: string | null } = {},
    now: number = Date.now(),
): { remindAt: string | null; escalateAt: string | null } {
    const deadline = expiresAt ? new Date(expiresAt).getTime() : null;
    const at = (hours: unknown): string | null => {
        const h = Number(hours);
        if (!Number.isFinite(h) || h < 1) return null;
        const t = now + Math.min(Math.round(h), 720) * 3_600_000;
        if (deadline && t >= deadline) return null;
        return new Date(t).toISOString();
    };
    return { remindAt: at(remindAfterHours), escalateAt: at(escalateAfterHours) };
}

/**
 * Where the step routes, through the org gate: the chain when the step has
 * one, else the panel, else the single assignee (plus a pre-chain final
 * approver). renderApprovalExtras already resolved the chain against the
 * paused run (names interpolated, conditions decided), so all that is left
 * here is the org gate the single assignee has always passed through.
 */
export async function configuredRouting(deps: RoutingDeps, err: PauseRequest, orgId: string | null, ownerId: string): Promise<Routing> {
    const stages = await deps.validateStages(err.stages || null, orgId, ownerId);
    const firstKey = stages ? deps.firstStageKey(stages) : null;
    const firstStage = stages && firstKey ? deps.stageByKey(stages, firstKey) : null;
    // Panel-era columns. With a chain they are MIRRORS of whichever stage is
    // waiting (advanceApprovalStage re-points them as the chain moves), so every
    // pre-stages reader still addresses the right people.
    let approvers = stages ? (firstStage?.approvers || null) : await deps.validatePanel(err.approvers || null, orgId);
    // With a panel, the single assignee is moot; without one, unchanged.
    let assignee = approvers ? null : await deps.validateAssignee(err.assignee || null, orgId);
    const finalApprover = stages ? null : await deps.validateAssignee(err.finalApprover || null, orgId);
    // Pre-chain rows only: a single approver plus a final approver becomes a
    // one-seat 'first' panel (desugarApprovalStages now makes two real stages).
    if (finalApprover && !approvers) {
        approvers = [assignee || { userId: ownerId }];
        assignee = null;
    }
    return { stages, firstKey, firstStage, approvers, assignee, finalApprover };
}

/** A panel's rule as the row stores it. */
export function panelRule(routing: Routing, err: PauseRequest): string | null {
    if (routing.stages) return routing.firstStage?.rule || 'all';
    if (!routing.approvers) return null;
    return typeof err.rule === 'string' && RULES.has(err.rule) ? err.rule : 'all';
}

/** A panel's quorum as the row stores it (clamped to the seats left). */
export function panelQuorum(routing: Routing, err: PauseRequest): number | null {
    if (routing.stages) {
        const q = routing.firstStage?.quorum;
        return typeof q === 'number' && Number.isFinite(q) ? q : null;
    }
    if (!routing.approvers || err.rule !== 'quorum') return null;
    return Math.min(Math.max(Math.round(Number(err.quorum)) || 1, 1), routing.approvers.length);
}

/** A seat's two id columns, null when there is no seat. */
function seatIds(seat: Seat | null | undefined): { userId: string | null; groupId: string | null } {
    return { userId: seat?.userId || null, groupId: seat?.groupId || null };
}

/**
 * The escalation columns. Panels use the final approver as their takeover
 * mechanism, so escalation only applies to single-assignee rows. The target
 * passes the same org gate as the assignee: silently escalating to a stranger
 * would leak the approval outright.
 */
async function escalationColumns(deps: RoutingDeps, routing: Routing, err: PauseRequest, orgId: string | null, escalateAt: string | null) {
    const escalateTo = escalateAt ? await deps.validateAssignee(err.escalateTo || null, orgId) : null;
    if (routing.approvers || !escalateTo) return { escalateAt: null, escalateToUserId: null, escalateToGroupId: null };
    const to = seatIds(escalateTo);
    return { escalateAt, escalateToUserId: to.userId, escalateToGroupId: to.groupId };
}

/** The routing columns of a PRODUCTION row. */
export async function configuredSeatColumns(deps: RoutingDeps, routing: Routing, err: PauseRequest, orgId: string | null): Promise<SeatColumns> {
    const { stages, firstKey, approvers } = routing;
    const clocks = approvalClocks({
        remindAfterHours: err.remindAfterHours,
        escalateAfterHours: err.escalateAfterHours,
        expiresAt: err.expiresAt || null,
    });
    const single = seatIds(routing.assignee);
    const final = seatIds(routing.finalApprover);
    return {
        assigneeUserId: single.userId,
        assigneeGroupId: single.groupId,
        remindAt: clocks.remindAt,
        ...await escalationColumns(deps, routing, err, orgId, clocks.escalateAt),
        approvers,
        approvalRule: panelRule(routing, err),
        quorumCount: panelQuorum(routing, err),
        finalApproverUserId: final.userId,
        finalApproverGroupId: final.groupId,
        stages,
        stageParticipants: stages ? deps.collectParticipants(stages) : null,
        stageKey: firstKey,
    };
}

/**
 * Where a test approval WOULD have gone in production: stage names, rules and
 * seat ids, never a person's name.
 */
export function routingSnapshot(routing: Routing, err: PauseRequest, runKind: 'test' | 'dry'): ConfiguredRouting {
    const { stages } = routing;
    return {
        runKind,
        stages: stages
            ? stages.map((stage) => ({
                key: stage.key || null,
                name: stage.name || null,
                rule: stage.rule || 'all',
                quorum: typeof stage.quorum === 'number' && Number.isFinite(stage.quorum) ? stage.quorum : null,
                skipped: stage.skipped === true,
                approvers: Array.isArray(stage.approvers) ? stage.approvers : [],
            }))
            : null,
        approvers: stages ? null : routing.approvers,
        rule: stages ? null : panelRule(routing, err),
        quorum: stages ? null : panelQuorum(routing, err),
        assignee: routing.assignee,
        finalApprover: routing.finalApprover,
    };
}

/** The routing columns of a TEST row: the tester alone, no clocks, the configured routing kept. */
export function testerSeatColumns(routing: Routing, err: PauseRequest, tester: string, runKind: 'test' | 'dry'): SeatColumns {
    return {
        assigneeUserId: tester,
        assigneeGroupId: null,
        remindAt: null,
        escalateAt: null,
        escalateToUserId: null,
        escalateToGroupId: null,
        approvers: null,
        approvalRule: null,
        quorumCount: null,
        finalApproverUserId: null,
        finalApproverGroupId: null,
        stages: null,
        stageParticipants: null,
        stageKey: null,
        isTest: true,
        sandboxUserId: tester,
        configuredRouting: routingSnapshot(routing, err, runKind),
    };
}

/** True when the profile puts the tester in the approver's seat. */
export function isSandboxSeat(profile: SeatProfile): boolean {
    return profile.approverSeat.kind === 'tester';
}

/** Who sits in the sandbox seat: the run's starter, else the automation's owner. */
export function testerOf(profile: SeatProfile, ownerId: string): string {
    const seat = profile.approverSeat;
    return (seat.kind === 'tester' && seat.userId) || ownerId;
}

/** The routing columns the run's profile asks for. */
export async function seatColumns(
    deps: RoutingDeps, profile: SeatProfile, err: PauseRequest, orgId: string | null, ownerId: string,
): Promise<SeatColumns> {
    const routing = await configuredRouting(deps, err, orgId, ownerId);
    if (!isSandboxSeat(profile)) return configuredSeatColumns(deps, routing, err, orgId);
    return testerSeatColumns(routing, err, testerOf(profile, ownerId), profile.kind === 'dry' ? 'dry' : 'test');
}

/**
 * The bell a LIVE test run sends its tester when it pauses at an approval, or
 * null (a dry run, a production run, a profile that does not notify the tester).
 */
export function testerBell(
    { profile, automationTitle, ownerId, prompt = '', sandboxUserId = null }:
    { profile: SeatProfile; automationTitle?: string | null; ownerId: string; prompt?: string | null; sandboxUserId?: string | null },
): { userId: string; category: 'heads_up'; title: string; message: string } | null {
    if (profile.kind !== 'test' || !profile.notify.tester) return null;
    const userId = sandboxUserId || testerOf(profile, ownerId);
    if (!userId) return null;
    return {
        userId,
        category: 'heads_up',
        title: `Test: approval needed in ${automationTitle || 'your automation'}`,
        message: prompt || '',
    };
}
