/**
 * dryPause.mts: how an approval or a form page behaves in a run that is not a
 * production run, and what a dry run tells the author about it.
 *
 * A run's profile (automationModel/runProfile.mts) says how its pauses go:
 *
 *   real        the step pauses for a person, also in a dry run (the web
 *               builder's Dry run asks for it, D1). The resume keeps the dry
 *               mode, so the writes after the answer stay simulated.
 *   harness     a form scenario, a golden replay or "restart with my answers"
 *               supplies the answers (core/automationRunner/testHarness.js). A
 *               step it has no answers for is synthesised and the run says so
 *               (scenario_missing).
 *   synthesise  a headless dry run (MCP, the AI builder, mobile, the API):
 *               nobody is asked. An approval is auto-approved with blank
 *               answers, a form page answered with blanks; both are MARKED
 *               (dryRunSynthesised, so reads that bind them synthesise too) and
 *               WARNED (one run warning per step, the wording below).
 *
 * In every dry-run flavour an approval also leaves a preview of what a live run
 * would do: the rendered question and details, the approver questions, which
 * attachments resolved, and per stage how many seats reach a member of the
 * organisation. Names-free: counts, never a person. A route nobody in the
 * organisation can take is a warning (a live run falls back to the owner).
 *
 * A test or dry pause waits at most profile.pauseTtlMs (env
 * AUTOMATION_TEST_PAUSE_TTL_MS, default 24 h, 0 = the step's own deadline), so
 * the reaper ends a pause the author walked away from.
 *
 * The lookups (licence, seats) are injected (setPauseDepsForTests); the
 * defaults require their modules at call time.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type PauseHandling = 'real' | 'synthesise' | 'harness';
export type DryFallback = 'auto_approved' | 'form_blank';

type ProfileLike = { kind?: unknown; pauses?: unknown; pauseTtlMs?: unknown } | null | undefined;
type PauseCtxLike = { profile?: ProfileLike; testHarness?: unknown } | null | undefined;

export type Seat = { userId?: string; groupId?: string };
export type StageLike = { name?: unknown; skipped?: unknown; approvers?: unknown };

export interface PauseDeps {
    hasCapability: (capId: string, ctx: { userId?: string; orgId?: string; session?: unknown }) => Promise<boolean>;
    /** The seat as the org gate keeps it, or null when it is outside the organisation. */
    validateAssignee: (seat: Seat, orgId: string) => Promise<Seat | null>;
    /** How many people a group seat reaches. */
    groupMemberTotal: (groupId: string) => Promise<number>;
}

function defaultDeps(): PauseDeps {
    return {
        hasCapability: (capId, ctx) => nodeRequire('../entitlements/entitlements').hasCapability(capId, ctx),
        validateAssignee: (seat, orgId) => nodeRequire('./approvalSeats').validateAssignee(seat, orgId),
        groupMemberTotal: async (groupId) => (await nodeRequire('./approvalSeats').groupMemberIds(groupId)).total,
    };
}

let deps: PauseDeps = defaultDeps();

/** The lookups in use. */
export function pauseDeps(): PauseDeps {
    return deps;
}

/** Test seam: replace some lookups; no argument restores the real ones. */
export function setPauseDepsForTests(over: Partial<PauseDeps> | null = null): void {
    deps = { ...defaultDeps(), ...(over || {}) };
}

/**
 * How this step's pause goes. Outside a dry run a pause is always real. A dry
 * run follows its profile; a context without one (a direct executor call, a
 * legacy row) synthesises, or plays its harness when it has one.
 */
export function pauseHandlingOf(ctx: PauseCtxLike, mode: string): PauseHandling {
    if (mode !== 'dry_run') return 'real';
    const p = ctx?.profile?.pauses;
    if (p === 'real' || p === 'synthesise' || p === 'harness') return p;
    return ctx?.testHarness ? 'harness' : 'synthesise';
}

/**
 * The deadline of a pause, ISO, or null for none. A test or dry run waits at
 * most its profile's pauseTtlMs: the earlier of that and the step's own.
 */
export function pauseExpiresAt(stepTtlMs: number | null | undefined, profile: ProfileLike, now: number = Date.now()): string | null {
    const step = typeof stepTtlMs === 'number' && Number.isFinite(stepTtlMs) && stepTtlMs > 0 ? stepTtlMs : null;
    const ttl = profile && profile.kind !== 'production' && typeof profile.pauseTtlMs === 'number'
        && Number.isFinite(profile.pauseTtlMs) && profile.pauseTtlMs > 0 ? profile.pauseTtlMs : null;
    const ms = step !== null && ttl !== null ? Math.min(step, ttl) : (step ?? ttl);
    return ms === null ? null : new Date(now + ms).toISOString();
}

/** How a step is named in a warning: its title, else its id. Never a value from the run. */
export function stepLabel(step: { id?: unknown; title?: unknown } | null | undefined): string {
    const title = typeof step?.title === 'string' ? step.title.trim() : '';
    if (title) return title.slice(0, 80);
    return typeof step?.id === 'string' && step.id ? step.id : 'step';
}

export type WarningKind = 'auto_approved' | 'form_blank' | 'approval_scenario_missing' | 'page_scenario_missing';

/** The run warning for a step a dry run answered without a person. One wording for the runner and the routes. */
export function dryFallbackWarning(kind: WarningKind, label: string): string {
    switch (kind) {
        case 'auto_approved':
            return `Approval "${label}" was auto-approved (simulated): nobody was asked, and its answers are blank.`;
        case 'form_blank':
            return `Form page "${label}" was answered with blanks (simulated): nobody filled it in.`;
        case 'approval_scenario_missing':
            return `Approval "${label}" has no decision in the saved answers (scenario_missing), so it was auto-approved with blank answers.`;
        case 'page_scenario_missing':
            return `Form page "${label}" has no saved answers (scenario_missing), so it was answered with blanks.`;
    }
}

/** The message of the licence refusal: a live run fails on it, a dry run says it would. */
export function licenceMessage(mode: string): string {
    const base = 'Approvals are an Enterprise feature — this automation cannot ask for one on the current plan.';
    return mode === 'dry_run' ? `${base} A live run would fail here.` : base;
}

export type StagePreview = { name: string; skipped: boolean; seatCount: number };
export type AttachmentPreview = { label: string; resolved: boolean };
export type ApprovalPreview = {
    prompt: string;
    detailsMd: string | null;
    fields: unknown[] | null;
    attachments: AttachmentPreview[];
    /** Who a live run asks: a stage chain, one assignee, or the owner. */
    route: 'stages' | 'assignee' | 'owner';
    stages: StagePreview[] | null;
    /** Seats of the assignee that reach a member: 0 or 1; null without an assignee. */
    assigneeSeatCount: number | null;
    warnings: string[];
};

const isSeat = (x: unknown): x is Seat => !!x && typeof x === 'object'
    && (typeof (x as Seat).userId === 'string' || typeof (x as Seat).groupId === 'string');

/** 1 when the seat reaches at least one member of the organisation, else 0. A failed lookup counts as reached. */
async function seatReaches(seat: Seat, orgId: string, d: PauseDeps): Promise<number> {
    try {
        const kept = await d.validateAssignee(seat, orgId);
        if (!kept) return 0;
        if (kept.groupId) return (await d.groupMemberTotal(kept.groupId)) > 0 ? 1 : 0;
        return 1;
    } catch {
        // A preview never fails a dry run; the live run validates again.
        return 1;
    }
}

async function seatsReaching(seats: unknown, orgId: string, d: PauseDeps): Promise<number> {
    let n = 0;
    for (const seat of Array.isArray(seats) ? seats : []) {
        if (isSeat(seat)) n += await seatReaches(seat, orgId, d);
    }
    return n;
}

export type PreviewInput = {
    label: string;
    prompt: string;
    extras: { detailsMd?: unknown; fields?: unknown; assignee?: unknown; stages?: unknown };
    attachments: AttachmentPreview[];
    orgId: string | null | undefined;
};

/** What a live run of this approval would ask, and of whom (counts only). */
export async function approvalPreview(input: PreviewInput, d: PauseDeps = deps): Promise<ApprovalPreview> {
    const { label, prompt, extras, attachments } = input;
    const orgId = typeof input.orgId === 'string' ? input.orgId : '';
    const warnings: string[] = [];
    let stages: StagePreview[] | null = null;
    let assigneeSeatCount: number | null = null;
    let route: ApprovalPreview['route'] = 'owner';

    if (Array.isArray(extras.stages) && extras.stages.length) {
        route = 'stages';
        stages = [];
        for (const raw of extras.stages as StageLike[]) {
            const name = typeof raw?.name === 'string' ? raw.name : 'Stage';
            const skipped = raw?.skipped === true;
            const seatCount = await seatsReaching(raw?.approvers, orgId, d);
            stages.push({ name, skipped, seatCount });
            if (!skipped && seatCount === 0) {
                warnings.push(`Approval "${label}", stage "${name}": no approver is a member of this organisation, so a live run asks the owner instead.`);
            }
        }
    } else if (isSeat(extras.assignee)) {
        route = 'assignee';
        assigneeSeatCount = await seatReaches(extras.assignee, orgId, d);
        if (assigneeSeatCount === 0) {
            warnings.push(`Approval "${label}": the assignee is not a member of this organisation, so a live run asks the owner instead.`);
        }
    }
    for (const att of attachments) {
        if (!att.resolved) warnings.push(`Approval "${label}": attachment "${att.label}" resolved to nothing.`);
    }
    return {
        prompt,
        detailsMd: typeof extras.detailsMd === 'string' ? extras.detailsMd : null,
        fields: Array.isArray(extras.fields) ? extras.fields : null,
        attachments,
        route,
        stages,
        assigneeSeatCount,
        warnings,
    };
}

// ── The dry-run results of a pause step (execApproval.js) ───────────────────

type RunStateLike = { _templateWarnings?: unknown; [k: string]: unknown };
type PauseStep = { id?: string; title?: string; form?: unknown; approval?: { fields?: unknown; attachments?: unknown } | null };
type Saved = { decision: 'approve' | 'reject'; answers?: unknown };
type Forms = {
    emptyFormValues: (form: unknown) => Record<string, unknown>;
    scenarioPageValues: (form: unknown, answers: unknown) => { values: Record<string, unknown>; invalidLabels: string[] };
};

const forms = (): Forms => (nodeRequire('./featurePorts') as { runnerPort: (n: string) => Forms }).runnerPort('forms');
const approvalOutputOf = (d: Record<string, unknown>): Record<string, unknown> =>
    (nodeRequire('../automationModel/approvalOutput.mts') as { approvalOutput: (d: Record<string, unknown>) => Record<string, unknown> }).approvalOutput(d);

/** One line per warning on the run's warnings (runWarnings.js), each once. */
export function noteWarnings(runState: RunStateLike, lines: string[]): void {
    const { noteRunWarning } = nodeRequire('./runWarnings') as { noteRunWarning: (rs: RunStateLike, line: string) => void };
    for (const line of lines) noteRunWarning(runState, line);
}

/**
 * Approvals are an Enterprise capability, and the gate belongs in the step,
 * before the run pauses, not after. Checking it in createApprovalOnPause would
 * leave a run parked in awaiting_approval with no record and nobody able to
 * list it: the worst of both outcomes. Failing the step instead stops the run
 * with something a person can read and act on. A dry run is checked too: it
 * fails where a live run would (errorClass license_required) instead of
 * auto-approving a flow the organisation cannot run (studio F7).
 *
 * Not gated: an approval already pending keeps its detail page, its decide
 * route and its withdraw route. A licence that lapses must let the work
 * already in flight finish, never strand it.
 */
export async function assertApprovalsLicensed(ctx: { userId?: string; orgId?: string; session?: unknown }, mode: string): Promise<void> {
    const licensed = await deps.hasCapability('approvals', { userId: ctx.userId, orgId: ctx.orgId, session: ctx.session });
    if (!licensed) throw Object.assign(new Error(licenceMessage(mode)), { errorClass: 'license_required' });
}

/** Each authored attachment: its label, and whether its binding resolved to anything (secrets stripped). */
export function attachmentPreview(step: PauseStep, runState: RunStateLike): AttachmentPreview[] {
    const list = Array.isArray(step?.approval?.attachments) ? step.approval.attachments as Array<{ binding?: unknown; label?: unknown } | null> : [];
    const { interpolateTemplate } = nodeRequire('../automationModel/bind') as { interpolateTemplate: (s: string, st: unknown, o: object) => unknown };
    const safeState = { ...runState, secrets: {} };
    return list.map((att, i) => {
        const raw = att && typeof att.binding === 'string' ? String(interpolateTemplate(att.binding, safeState, { listAsMarkdown: true }) ?? '').trim() : '';
        const label = typeof att?.label === 'string' && att.label.trim() ? att.label.trim() : `Attachment ${i + 1}`;
        return { label, resolved: !!raw };
    });
}

/** True when the step has an edge that runs on a rejection ('on_rejected'). */
export function hasRejectedEdge(ctx: { definition?: { edges?: unknown } } | null | undefined, stepId: string | undefined): boolean {
    const edges = Array.isArray(ctx?.definition?.edges) ? ctx.definition.edges as Array<{ from?: unknown; label?: unknown } | null> : [];
    return edges.some((e) => !!e && e.from === stepId && e.label === 'on_rejected');
}

/**
 * A dry run that decides the approval from saved answers (a scenario, a golden
 * replay, "restart with my answers"). Answers go through the same coercion as a
 * person's; on approve a question that does not pass fails the step by LABEL
 * (never an answer), like a form page. A rejection follows the 'on_rejected'
 * edge when one is wired and otherwise ends the run as a live rejection does
 * (ApprovalRejected).
 */
export function harnessApproval(step: PauseStep, ctx: { definition?: { edges?: unknown } }, extras: { fields?: unknown }, saved: Saved, preview: ApprovalPreview | null) {
    const approved = saved.decision === 'approve';
    let answers: Record<string, unknown> = {};
    if (extras.fields) {
        const { values, invalidLabels } = forms().scenarioPageValues({ fields: extras.fields }, saved.answers);
        if (approved && invalidLabels.length) {
            throw Object.assign(
                new Error(`The saved answers no longer fit the approval "${stepLabel(step)}": check ${invalidLabels.join(', ')}.`),
                { errorClass: 'scenario_answers_invalid' },
            );
        }
        answers = values;
    }
    if (!approved && !hasRejectedEdge(ctx, step.id)) {
        throw Object.assign(new Error('Approval rejected: the saved answers reject this approval.'), { errorClass: 'ApprovalRejected' });
    }
    return { output: { ...approvalOutputOf({ approved, by: 'dry_run', answers }), _dryRun: true, _fromScenario: true, _preview: preview } };
}

/**
 * A dry run nobody answers: auto-approved with blank answers (keyed by the
 * approver questions, so a downstream binding resolves to blank instead of
 * failing), marked as synthesised so reads that bind it synthesise too, and
 * named in the run's warnings (RM-4, tests-and-docs F7).
 */
export function synthesisedApproval(step: PauseStep, runState: RunStateLike, extras: { fields?: unknown }, preview: ApprovalPreview | null, missing: boolean) {
    const answers = extras.fields ? forms().emptyFormValues({ fields: step.approval?.fields }) : {};
    noteWarnings(runState, [dryFallbackWarning(missing ? 'approval_scenario_missing' : 'auto_approved', stepLabel(step))]);
    return {
        output: { ...approvalOutputOf({ approved: true, by: 'dry_run', answers }), _dryRun: true, ...(missing ? { _scenarioMissing: true } : {}), _preview: preview },
        dryRunSynthesised: true,
        dryRunFallback: 'auto_approved' as const,
    };
}

/**
 * A form page nobody answers: blank answers keyed by the AUTHORED field names
 * (a multiselect or a per-item group is an empty list), so downstream bindings
 * resolve in a preview rather than pausing a run nobody is watching. Marked as
 * synthesised and named in the run's warnings (RM-4, pauses F12).
 */
export function synthesisedPage(step: PauseStep, runState: RunStateLike, missing: boolean) {
    noteWarnings(runState, [dryFallbackWarning(missing ? 'page_scenario_missing' : 'form_blank', stepLabel(step))]);
    return {
        output: { ...forms().emptyFormValues(step.form), _dryRun: true, ...(missing ? { _scenarioMissing: true } : {}) },
        dryRunSynthesised: true,
        dryRunFallback: 'form_blank' as const,
    };
}
