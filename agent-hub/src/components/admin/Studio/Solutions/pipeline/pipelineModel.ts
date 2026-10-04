import { isActive, isTerminal } from './stagesApi';
import type {
    ApiResult, DeploymentKind, DeploymentStatus, DeploymentSummary, Pipeline, PipelineRelease, PipelineStage,
    Plan, PlanAck, StageKey, StageName,
} from './stagesApi';

/**
 * The pipeline's decisions, pure: which column is in which state, the ONE primary
 * action each state offers, what an error code means, and when the deploy dialog
 * may submit. No React, no fetch, no sentences — every function returns a STATE
 * and the component turns it into words through t() (the contract
 * solutionOverviewModel.js keeps: a helper that returned prose would put copy
 * where no translator can reach it).
 *
 * The rule that shapes it: UNKNOWN IS NOT EMPTY. A pipeline that could not be
 * read is `unreadable`, never "no stages", and a column whose release is
 * unknown offers no action instead of a guess. The server decides eligibility
 * (design 6.2); this file only decides what to OFFER, and a refusal comes back
 * as a code that errorKind() names.
 */

// ── Statuses ─────────────────────────────────────────────────────────────────



export type Phase = 'awaiting' | 'preparing' | 'switching' | 'finishing' | 'done' | 'stopped';

/** The three steps the progress bar shows: Preparing → Switching → Finishing. */
export const PROGRESS_STEPS: readonly Phase[] = ['preparing', 'switching', 'finishing'];

export function phaseOf(status?: string | null): Phase {
    switch (status) {
        case 'awaiting_approval': return 'awaiting';
        case 'queued': case 'approved': case 'preparing': case 'compensating': return 'preparing';
        case 'committing': return 'switching';
        case 'converging': return 'finishing';
        case 'succeeded': case 'succeeded_with_warnings': return 'done';
        default: return 'stopped';
    }
}

/**
 * The status word the shared StatusActionPill can paint. It has no error tone,
 * so a failure wears the warning one (`stale`) and the label says "Failed".
 */
export function pillStatusOf(status?: string | null): 'published' | 'stale' | 'paused' | 'draft' {
    switch (status) {
        case 'succeeded': return 'published';
        case 'succeeded_with_warnings': case 'failed': return 'stale';
        case 'cancelled': case 'rejected': return 'paused';
        default: return 'draft';
    }
}

/** What the rows of the history may do next. */
export type RowAction = 'retry' | 'cancel' | null;
export function rowActionOf(d: Pick<DeploymentSummary, 'status' | 'kind'>): RowAction {
    if (d.status === 'awaiting_approval' || d.status === 'queued') return 'cancel';
    if (d.status === 'failed' && d.kind !== 'settings' && d.kind !== 'remove') return 'retry';
    if (d.status === 'succeeded_with_warnings') return 'retry';
    return null;
}

/**
 * A 202 from a route that starts a deployment (a `settings` change of the PRD
 * gate, a `remove`). Both ride the same machine as a deploy, so the caller
 * shows the same progress; an `awaiting_approval` one waits for a decision.
 */
export function followUp(body: unknown): { track: boolean; awaitingApproval: boolean; deploymentId: string | null; kind: DeploymentKind | null } {
    const d = body && typeof body === 'object' ? (body as { deployment?: Partial<DeploymentSummary> }).deployment : undefined;
    if (!d || typeof d.id !== 'string') return { track: false, awaitingApproval: false, deploymentId: null, kind: null };
    return {
        track: !isTerminal(d.status),
        awaitingApproval: d.status === 'awaiting_approval',
        deploymentId: d.id,
        kind: (d.kind as DeploymentKind) || null,
    };
}

// ── Columns ──────────────────────────────────────────────────────────────────

export type ActionId =
    | 'setup' | 'release_deploy_uat' | 'deploy' | 'promote' | 'request_approval'
    | 'apply_settings' | 'rollback' | 'cancel_request' | 'retry_converge';

export interface ColumnAction {
    id: ActionId;
    stage?: StageKey;
    deployKind?: DeploymentKind;
    releaseId?: string | null;
    releaseSeq?: number | null;
    deploymentId?: string | null;
}

export type DevState = 'no_stages' | 'blocked' | 'no_release' | 'ahead' | 'in_sync';
export type StageState = 'not_set_up' | 'waiting' | 'empty' | 'behind' | 'promote' | 'current' | 'running' | 'awaiting_approval';
export type Attention = 'failed' | 'warnings' | null;

export interface Column {
    stage: 'dev' | StageKey;
    state: DevState | StageState;
    primary: ColumnAction | null;
    secondary: ColumnAction[];
    attention: Attention;
    /** The release this column runs (stages) or is ahead of (Dev). */
    releaseSeq: number | null;
    blockedCount?: number;
    ahead?: { changed: number; added: number; removed: number } | null;
    lastDeployment: DeploymentSummary | null;
    pending: DeploymentSummary | null;
    bindingsPending: boolean;
    projectId?: string;
    enabled?: boolean;
}

const seqOf = (r: { seq?: number | null } | null | undefined): number | null =>
    r && typeof r.seq === 'number' ? r.seq : null;

/** The newest release the UAT stage may receive (gate clean). */
export function latestEligible(releases: PipelineRelease[] | null | undefined): PipelineRelease | null {
    let best: PipelineRelease | null = null;
    for (const r of Array.isArray(releases) ? releases : []) {
        if (!r || typeof r.seq !== 'number' || r.gate?.blocked === true) continue;
        if (!best || r.seq > best.seq) best = r;
    }
    return best;
}

const releaseBySeq = (releases: PipelineRelease[] | null | undefined, seq: number | null): PipelineRelease | null =>
    (seq === null ? null : (Array.isArray(releases) ? releases : []).find(r => r && r.seq === seq) || null);

/** Which attention a stage's newest deployment asks for. */
function attentionOf(d: DeploymentSummary | null): Attention {
    if (!d) return null;
    if (d.status === 'failed') return 'failed';
    if (d.status === 'succeeded_with_warnings') return 'warnings';
    return null;
}

interface StageCtx {
    col: Column; row: PipelineStage; stage: StageKey; pipeline: Pipeline; uatRow: PipelineStage | undefined;
    current: number | null; retry: ColumnAction[]; applySettings: ColumnAction[];
}

function uatColumn({ col, row, stage, pipeline, current, retry, applySettings }: StageCtx): Column {
    const latest = latestEligible(pipeline.releases);
    const deployLatest: ColumnAction | null = latest
        ? { id: 'deploy', stage, deployKind: 'deploy', releaseId: latest.id, releaseSeq: latest.seq } : null;
    if (current === null) return { ...col, state: latest ? 'empty' : 'waiting', primary: deployLatest, secondary: retry };
    if (latest && current < latest.seq) return { ...col, state: 'behind', primary: deployLatest, secondary: [...applySettings, ...retry] };
    return { ...col, state: 'current', primary: applySettings[0] || null, secondary: retry };
}

/** The release Production would receive: what UAT runs, once UAT has settled on it. */
function promotionOf(uatRow: PipelineStage | undefined, releases: PipelineRelease[] | null): { id: string | null; seq: number } | null {
    const seq = seqOf(uatRow?.currentRelease);
    if (!uatRow || seq === null) return null;
    const settled = !isActive(uatRow.lastDeployment?.status) && uatRow.lastDeployment?.status !== 'failed';
    if (!settled) return null;
    return { id: uatRow.currentRelease?.id || releaseBySeq(releases, seq)?.id || null, seq };
}

/**
 * The rollback a Production column offers. The server sends the target as an id
 * only (`seq: null`): the number comes from the release list when it is there,
 * and the action stays on offer without one.
 */
function rollbackOf(row: PipelineStage, stage: StageKey, pipeline: Pipeline, current: number | null): ColumnAction[] {
    const ref = row.previousRelease;
    if (current === null || !ref) return [];
    const releases = Array.isArray(pipeline.releases) ? pipeline.releases : [];
    const seq = seqOf(ref) ?? (ref.id ? seqOf(releases.find(r => r && r.id === ref.id)) : null);
    if (!ref.id && seq === null) return [];
    return [{ id: 'rollback', stage, deployKind: 'rollback', releaseId: ref.id ?? releaseBySeq(releases, seq)?.id ?? null, releaseSeq: seq }];
}

function prdColumn({ col, row, stage, pipeline, uatRow, current, retry, applySettings }: StageCtx): Column {
    const target = promotionOf(uatRow, pipeline.releases);
    const promote: ColumnAction | null = target
        ? { id: row.requiresApproval === true ? 'request_approval' : 'promote', stage, deployKind: 'deploy', releaseId: target.id, releaseSeq: target.seq }
        : null;
    const rollback = rollbackOf(row, stage, pipeline, current);
    if (current === null) return { ...col, state: promote ? 'empty' : 'waiting', primary: promote, secondary: retry };
    if (promote && target && current < target.seq) {
        return { ...col, state: 'promote', primary: promote, secondary: [...applySettings, ...rollback, ...retry] };
    }
    return { ...col, state: 'current', primary: applySettings[0] || null, secondary: [...rollback, ...retry] };
}

/** The states that offer nothing: a request waiting for approval, a deployment in flight. */
function busyColumn(col: Column, row: PipelineStage, stage: StageKey, owner: boolean): Column | null {
    if (row.pending?.status === 'awaiting_approval') {
        return { ...col, state: 'awaiting_approval', attention: null, secondary: owner ? [{ id: 'cancel_request', stage, deploymentId: row.pending.id }] : [] };
    }
    return isActive(row.lastDeployment?.status) ? { ...col, state: 'running', attention: null } : null;
}

function stageColumn(
    row: PipelineStage | undefined, stage: StageKey, pipeline: Pipeline, uatRow: PipelineStage | undefined, owner: boolean,
): Column {
    const base: Column = {
        stage, state: 'not_set_up', primary: null, secondary: [], attention: null, releaseSeq: null,
        lastDeployment: null, pending: null, bindingsPending: false,
    };
    if (!row) return base;
    const current = seqOf(row.currentRelease);
    const col: Column = {
        ...base, releaseSeq: current, lastDeployment: row.lastDeployment || null, pending: row.pending || null,
        bindingsPending: row.bindingsPending === true, projectId: row.projectId, enabled: row.enabled,
        attention: attentionOf(row.lastDeployment || null),
    };
    const busy = busyColumn(col, row, stage, owner);
    if (busy) return busy;
    if (!owner) return { ...col, state: current === null ? 'empty' : 'current' };

    const retry: ColumnAction[] = col.attention === 'warnings' && row.lastDeployment
        ? [{ id: 'retry_converge', stage, deploymentId: row.lastDeployment.id }] : [];
    const applySettings: ColumnAction[] = col.bindingsPending && current !== null
        ? [{ id: 'apply_settings', stage, deployKind: 'redeploy', releaseId: row.currentRelease?.id ?? null, releaseSeq: current }] : [];
    const ctx: StageCtx = { col, row, stage, pipeline, uatRow, current, retry, applySettings };
    return stage === 'uat' ? uatColumn(ctx) : prdColumn(ctx);
}

const hasChange = (a: { changed: number; added: number; removed: number } | null | undefined): boolean =>
    !!a && a.changed + a.added + a.removed > 0;

function aheadOfDev(dev: NonNullable<Pipeline['dev']>): NonNullable<Column['ahead']> | null {
    const a = dev.aheadOf;
    return a ? { changed: a.changed || 0, added: a.added || 0, removed: a.removed || 0 } : null;
}

function devColumn(pipeline: Pipeline, owner: boolean): Column | null {
    const dev = pipeline.dev;
    if (!dev) return null;
    const uat = pipeline.stages.find(s => s.stage === 'uat');
    const base: Column = {
        stage: 'dev', state: 'in_sync', primary: null, secondary: [], attention: null, releaseSeq: null,
        lastDeployment: null, pending: null, bindingsPending: false, blockedCount: dev.checks?.count ?? 0,
    };
    if (pipeline.stages.length === 0) return { ...base, state: 'no_stages', primary: owner ? { id: 'setup' } : null };
    const ahead = aheadOfDev(dev);
    const uatBusy = isActive(uat?.lastDeployment?.status) || uat?.pending?.status === 'awaiting_approval';
    const offer: ColumnAction | null = owner && uat && !uatBusy ? { id: 'release_deploy_uat', stage: 'uat', deployKind: 'deploy' } : null;
    const known = { ...base, releaseSeq: seqOf(dev.aheadOf), ahead };
    if (dev.checks?.blocked === true) return { ...known, state: 'blocked' };
    if (pipeline.releases?.length === 0 && !dev.aheadOf) return { ...base, state: 'no_release', primary: offer };
    return hasChange(ahead) ? { ...known, state: 'ahead', primary: offer } : known;
}

/** The three columns, in order. A stage-only operator gets only the columns they hold. */
export function buildColumns(pipeline: Pipeline, { owner }: { owner: boolean }): Column[] {
    const uatRow = pipeline.stages.find(s => s.stage === 'uat');
    const prdRow = pipeline.stages.find(s => s.stage === 'prd');
    const out: Column[] = [];
    const dev = devColumn(pipeline, owner);
    if (dev) out.push(dev);
    if (pipeline.dev || uatRow) out.push(stageColumn(uatRow, 'uat', pipeline, uatRow, owner));
    if (pipeline.dev || prdRow) out.push(stageColumn(prdRow, 'prd', pipeline, uatRow, owner));
    return out;
}

// ── Reading the pipeline ─────────────────────────────────────────────────────

export type PipelineReadState = 'ok' | 'no_licence' | 'not_a_solution' | 'forbidden' | 'unreadable';

/** What a failed pipeline read means. Never "no stages": that is `ok` with an empty list. */
export function readStateOf(res: { ok: boolean; status: number; code?: string | null } | null | undefined): PipelineReadState {
    if (!res) return 'unreadable';
    if (res.ok) return 'ok';
    const code = (res as { code?: string | null }).code || '';
    if (res.status === 402 || /licen|feature_not|not_licensed/i.test(code)) return 'no_licence';
    if (res.status === 404) return 'not_a_solution';
    if (res.status === 403) return 'forbidden';
    return 'unreadable';
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ErrorKind =
    | 'plan_stale' | 'acknowledgement_missing' | 'stage_busy' | 'approval_pending' | 'release_not_in_uat'
    | 'release_blocked' | 'rollback_target_invalid' | 'plan_blocked' | 'solution_owner_only' | 'run_as_mismatch'
    | 'stage_not_found' | 'stages_need_org' | 'capture_raced' | 'no_licence' | 'forbidden' | 'network' | 'unknown';

const KNOWN: Readonly<Record<string, ErrorKind>> = {
    plan_stale: 'plan_stale',
    plan_stale_after_approval: 'plan_stale',
    acknowledgement_missing: 'acknowledgement_missing',
    stage_busy: 'stage_busy',
    approval_pending: 'approval_pending',
    release_not_in_uat: 'release_not_in_uat',
    release_blocked: 'release_blocked',
    rollback_target_invalid: 'rollback_target_invalid',
    plan_blocked: 'plan_blocked',
    solution_owner_only: 'solution_owner_only',
    run_as_mismatch: 'run_as_mismatch',
    stage_not_found: 'stage_not_found',
    stages_need_org: 'stages_need_org',
    capture_raced: 'capture_raced',
};

export function errorKind(res: Pick<Extract<ApiResult<unknown>, { ok: false }>, 'status' | 'code'>): ErrorKind {
    if (res.status === 0 || res.code === 'network') return 'network';
    if (res.code && KNOWN[res.code]) return KNOWN[res.code];
    if (res.status === 402 || (res.code && /licen|not_licensed/i.test(res.code))) return 'no_licence';
    if (res.status === 403) return 'forbidden';
    return 'unknown';
}

/** An error the user can fix by asking again after re-reading the plan. */
export const isRetryable = (kind: ErrorKind): boolean => kind === 'plan_stale' || kind === 'network' || kind === 'capture_raced';

// ── The deploy dialog ────────────────────────────────────────────────────────

export const ackKey = (a: { code: string; ref?: string | null; docRef?: string | null }): string =>
    `${a.code}:${a.ref ?? ''}:${a.docRef ?? ''}`;

/** PRD asks for the Solution's name, whatever is being done to it (design 9). */
export const needsNameConfirm = (stage: StageKey): boolean => stage === 'prd';

export type Outcome = 'deploy_uat' | 'deploy_prd' | 'promote' | 'request_approval' | 'rollback' | 'redeploy' | 'apply_settings';

/** The footer button names what pressing it does. */
export function outcomeOf(plan: Plan | null, stage: StageKey, kind: DeploymentKind): Outcome {
    if (plan?.gates?.approval === 'required' && stage === 'prd') return 'request_approval';
    if (kind === 'rollback') return 'rollback';
    if (kind === 'redeploy') return plan?.release && plan.from && plan.release.id === plan.from.releaseId ? 'apply_settings' : 'redeploy';
    return stage === 'uat' ? 'deploy_uat' : 'promote';
}

export type SubmitBlock =
    | 'no_plan' | 'blocking' | 'bindings_missing' | 'variables_missing' | 'variables_invalid' | 'ack_missing' | 'name_mismatch';

/** Why the footer button is still off. Empty = it may submit. Order = what the dialog says first. */
export function submitBlocks(input: {
    plan: Plan | null; acked: ReadonlySet<string>; typedName: string; solutionName: string; stage: StageKey;
}): SubmitBlock[] {
    const { plan, acked, typedName, solutionName, stage } = input;
    if (!plan) return ['no_plan'];
    const out: SubmitBlock[] = [];
    if (plan.blocking.length > 0) out.push('blocking');
    if (plan.bindings.missing.length > 0) out.push('bindings_missing');
    if (plan.variables.missing.length > 0) out.push('variables_missing');
    if (plan.variables.invalid.length > 0) out.push('variables_invalid');
    if (plan.acknowledgementsRequired.some(a => !acked.has(ackKey(a)))) out.push('ack_missing');
    if (needsNameConfirm(stage) && typedName.trim() !== solutionName.trim()) out.push('name_mismatch');
    return out;
}

/** How many parts the plan does each thing to; `unchanged` parts are not "changes". */
export function summarizeParts(plan: Plan | null): Record<'create' | 'replace' | 'retire' | 'revive' | 'unchanged' | 'remove', number> {
    const out = { create: 0, replace: 0, retire: 0, revive: 0, unchanged: 0, remove: 0 };
    for (const p of plan?.parts || []) if (p.action in out) out[p.action] += 1;
    return out;
}

/** True when the plan changes nothing at all (every part unchanged, no schema, rows or knowledge). */
export function isNoop(plan: Plan | null): boolean {
    if (!plan) return false;
    const c = summarizeParts(plan);
    const schema = plan.data.some(d => d.create || d.add.length || d.rename.length || d.retire.length || d.unretire.length);
    const rows = plan.referenceRows.some(r => r.insert || r.update || r.delete);
    const kb = plan.knowledge.some(k => k.copy || k.remove);
    return c.create + c.replace + c.retire + c.revive + c.remove === 0 && !schema && !rows && !kb;
}

/** The acknowledgement a checkbox belongs to, in the order the plan lists them. */
export function acksOf(plan: Plan | null): PlanAck[] {
    return plan ? plan.acknowledgementsRequired.filter(a => a && typeof a.code === 'string') : [];
}

/** The settings link a missing binding needs: it opens the stage's Settings tab. */
export const settingsLinkFor = (stage: StageKey): string => `?stage=${stage}&tab=settings`;

/**
 * Which stage the screen shows. The wish (from `?stage=` or a click) is only
 * honoured when the pipeline lists it; a failed read means Dev, and a caller
 * without a Dev role gets the first stage they hold. Nothing is guessed before
 * the read has landed (`status: 'loading'` keeps the wish, so the caller can wait).
 */
export function effectiveStage(wanted: StageName, read: { status: 'loading' | 'ok' | 'error'; stages: Array<{ stage: StageKey }>; hasDev: boolean }): StageName {
    if (read.status === 'error') return 'dev';
    if (read.status === 'loading') return wanted;
    const listed = (name: StageName) => read.stages.some(s => s.stage === name);
    if (wanted !== 'dev' && listed(wanted)) return wanted;
    if (read.hasDev) return 'dev';
    return read.stages[0]?.stage || 'dev';
}
