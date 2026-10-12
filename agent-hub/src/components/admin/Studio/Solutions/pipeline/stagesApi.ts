import { API_BASE, authFetch } from '../../../../../utils/helpers';

/**
 * The pipeline's wire: typed fetchers over authFetch for the stage routes of
 * design section 8. Nothing here decides anything; pipelineModel.ts reads these
 * shapes and the components render what it says.
 *
 * Two rules the whole feature leans on:
 *
 *  - Every answer is an ApiResult, never a thrown error and never a bare
 *    `null`. "The server said no, here is the code" and "the request never
 *    arrived" are different sentences on screen, so both stay visible as
 *    `ok: false` with a `code` (`network` for the second).
 *  - Every POST that changes something carries a `requestKey`. The caller
 *    generates it ONCE per dialog open (newRequestKey) and reuses it for a
 *    retry, so a double click or a lost response replays the same deployment
 *    instead of starting a second one.
 *
 * `:id` is always the Dev Solution; a stage project id there answers 404.
 */

export type StageKey = 'uat' | 'prd';
export type StageName = 'dev' | StageKey;
export type DeploymentKind = 'deploy' | 'rollback' | 'redeploy' | 'settings' | 'remove';
export type DeploymentStatus =
    | 'awaiting_approval' | 'approved' | 'rejected' | 'queued' | 'preparing' | 'committing'
    | 'converging' | 'compensating' | 'succeeded' | 'succeeded_with_warnings' | 'failed' | 'cancelled';

export const ACTIVE_STATUSES: readonly DeploymentStatus[] = ['queued', 'approved', 'preparing', 'committing', 'converging', 'compensating'];
export const TERMINAL_STATUSES: readonly DeploymentStatus[] = ['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'rejected'];
export const isActive = (status?: string | null): boolean => ACTIVE_STATUSES.includes(status as DeploymentStatus);
export const isTerminal = (status?: string | null): boolean => TERMINAL_STATUSES.includes(status as DeploymentStatus);

export interface ReleaseRef { id?: string | null; seq: number | null }

export interface DeploymentError { code?: string | null; message?: string | null; ref?: string | null }

export interface DeploymentSummary {
    id: string;
    status: DeploymentStatus;
    kind: DeploymentKind;
    stage?: StageKey;
    releaseId?: string | null;
    releaseSeq?: number | null;
    createdAt?: string | null;
    finishedAt?: string | null;
    requestedBy?: string | null;
    error?: DeploymentError | null;
}

export interface PipelineStage {
    stage: StageKey;
    projectId: string;
    currentRelease: ReleaseRef | null;
    previousRelease?: ReleaseRef | null;
    lastDeployment: DeploymentSummary | null;
    pending: DeploymentSummary | null;
    bindingsPending: boolean;
    enabled: boolean;
    role: string;
    requiresApproval?: boolean;
}

export interface PipelineRelease {
    id: string;
    seq: number;
    createdAt?: string | null;
    notes?: { summary?: string | null; changed?: number; added?: number; removed?: number } | null;
    gate?: { blocked?: boolean } | null;
    deployedTo?: StageKey[];
}

export interface PipelineDev {
    aheadOf: { seq: number | null; changed: number; added: number; removed: number } | null;
    checks: { blocked: boolean; count: number };
}

export interface Pipeline {
    dev: PipelineDev | null;
    stages: PipelineStage[];
    releases: PipelineRelease[] | null;
}

export interface PlanFinding {
    code: string;
    severity?: string;
    message?: string | null;
    ref?: string | null;
    slot?: string | null;
    name?: string | null;
}

export interface PlanPart {
    ref: string; kind: string; name?: string | null;
    action: 'create' | 'replace' | 'unchanged' | 'retire' | 'revive' | 'remove';
    drift?: boolean; goesLive?: boolean; summary?: string | null;
}

export interface PlanRetire { key: string; relaxes?: { notNull?: boolean; unique?: boolean; fk?: boolean } }

export interface PlanData {
    ref: string; name?: string | null;
    create?: boolean;
    add: string[]; rename: Array<{ from: string; to: string }>; retire: PlanRetire[]; unretire: string[];
    blocked: Array<{ code: string; key?: string }>;
    preflight?: string;
}

export interface PlanAck { code: string; ref?: string | null; docRef?: string | null }

export interface Plan {
    kind: DeploymentKind;
    stage: StageKey;
    release: { id: string; seq: number | null } | null;
    from: { releaseId: string | null; seq: number | null } | null;
    parts: PlanPart[];
    data: PlanData[];
    referenceRows: Array<{ ref: string; insert: number; update: number; delete: number }>;
    knowledge: Array<{ ref: string; copy: number; remove: number; unchanged: number; personalDataFlagged: number; sourceStage?: string }>;
    bindings: { missing: Array<{ slot: string; label?: string; neededBy?: string[] }>; orphaned: string[] };
    variables: { missing: string[]; invalid: string[]; steeringPending: string[] };
    readiness: PlanFinding[];
    blocking: PlanFinding[];
    gates: { releaseClean?: boolean; testedInUat?: boolean | null; approval: 'not_required' | 'required' | 'approved' };
    differsFromUat: Array<{ kind: string; label: string; uat: unknown; prd: unknown }>;
    acknowledgementsRequired: PlanAck[];
    planHash: string;
    settingsVersion?: number;
}

export interface DeploymentStep { seq: number; phase: string; ref?: string | null; kind?: string | null; action: string; status: string }

export interface DeploymentDetail {
    deployment: DeploymentSummary;
    steps?: DeploymentStep[];
    approval?: { id: string; status: string } | null;
}

export interface InboundAddress { kind: string; label: string; url: string }

/** What the Status tab reads of GET /:id/stages/:stage (the rest belongs to the settings page). */
export interface StageSettingsSummary {
    enabled: boolean;
    bindingsPending: boolean;
    requiresApproval?: boolean;
    inbound: InboundAddress[];
}

export type ApiResult<T> =
    | { ok: true; status: number; data: T }
    | { ok: false; status: number; code: string | null; message: string | null; body: Record<string, unknown> | null };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One id per dialog open: a retry of the same intent replays, a new intent gets a new key. */
export function newRequestKey(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a client-side request key for de-duplication, not a secret or a token
    return `rk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
    try {
        const res = await authFetch(`${API_BASE}/api/projects${path}`, {
            method: init.method || 'GET',
            ...(init.body !== undefined
                ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
                : {}),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.ok) return { ok: true, status: res.status, data: body as T };
        const obj = isObject(body) ? body : null;
        return {
            ok: false,
            status: res.status,
            code: obj && typeof obj.code === 'string' ? obj.code : null,
            message: obj && typeof obj.error === 'string' ? obj.error : null,
            body: obj,
        };
    } catch {
        return { ok: false, status: 0, code: 'network', message: null, body: null };
    }
}

const enc = encodeURIComponent;

// ── Reading ──────────────────────────────────────────────────────────────────

/** Tolerant reader: a body that is not a pipeline reads as "no stages", never as a crash. */
export function readPipeline(body: unknown): Pipeline {
    const o = isObject(body) ? body : {};
    return {
        dev: isObject(o.dev) ? (o.dev as unknown as PipelineDev) : null,
        stages: Array.isArray(o.stages) ? (o.stages as PipelineStage[]).filter(s => isObject(s) && (s.stage === 'uat' || s.stage === 'prd')) : [],
        releases: Array.isArray(o.releases) ? (o.releases as PipelineRelease[]) : null,
    };
}

export async function getPipeline(solutionId: string): Promise<ApiResult<Pipeline>> {
    const res = await call<unknown>(`/${enc(solutionId)}/pipeline`);
    return res.ok ? { ...res, data: readPipeline(res.data) } : res;
}

export async function getStage(solutionId: string, stage: StageKey): Promise<ApiResult<StageSettingsSummary>> {
    const res = await call<unknown>(`/${enc(solutionId)}/stages/${enc(stage)}`);
    if (!res.ok) return res;
    const o = isObject(res.data) ? res.data : {};
    return {
        ...res,
        data: {
            enabled: o.enabled !== false,
            bindingsPending: o.bindingsPending === true,
            requiresApproval: o.requiresApproval === true,
            inbound: Array.isArray(o.inbound)
                ? (o.inbound as InboundAddress[]).filter(a => isObject(a) && typeof a.url === 'string')
                : [],
        },
    };
}

export function listDeployments(solutionId: string, stage: StageKey, cursor?: string | null) {
    const q = `stage=${enc(stage)}${cursor ? `&cursor=${enc(cursor)}` : ''}`;
    return call<{ deployments: DeploymentSummary[]; nextCursor?: string | null }>(`/${enc(solutionId)}/deployments?${q}`);
}

export function getDeployment(solutionId: string, deploymentId: string) {
    return call<DeploymentDetail>(`/${enc(solutionId)}/deployments/${enc(deploymentId)}`);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function createStages(solutionId: string, stages: StageKey[], requestKey: string) {
    return call<{ stages: PipelineStage[] }>(`/${enc(solutionId)}/stages`, { method: 'POST', body: { stages, requestKey } });
}

export function cutRelease(solutionId: string, requestKey: string, notes?: string) {
    return call<{ release: PipelineRelease }>(`/${enc(solutionId)}/releases`, {
        method: 'POST', body: { requestKey, ...(notes ? { notes } : {}) },
    });
}

export function planDeployment(solutionId: string, stage: StageKey, releaseId: string | null, kind?: DeploymentKind) {
    return call<Plan>(`/${enc(solutionId)}/stages/${enc(stage)}/plan`, {
        method: 'POST', body: { releaseId, ...(kind ? { kind } : {}) },
    });
}

export interface DeployBody {
    releaseId: string | null;
    kind: DeploymentKind;
    planHash: string;
    requestKey: string;
    acknowledgements: PlanAck[];
    note?: string;
}

export function deploy(solutionId: string, stage: StageKey, body: DeployBody) {
    return call<{ deployment: DeploymentSummary }>(`/${enc(solutionId)}/stages/${enc(stage)}/deployments`, { method: 'POST', body });
}

export function cancelDeployment(solutionId: string, deploymentId: string) {
    return call<{ deployment?: DeploymentSummary }>(`/${enc(solutionId)}/deployments/${enc(deploymentId)}/cancel`, { method: 'POST', body: {} });
}

export function retryDeployment(solutionId: string, deploymentId: string) {
    return call<{ deployment?: DeploymentSummary }>(`/${enc(solutionId)}/deployments/${enc(deploymentId)}/retry`, { method: 'POST', body: {} });
}

/** The plan a 409 carries (`plan_stale`), wherever the route put it. */
export function planFromError(res: ApiResult<unknown>): Plan | null {
    if (res.ok || !res.body) return null;
    const details = isObject(res.body.details) ? res.body.details : null;
    const plan = (details && details.plan) || res.body.plan;
    return isObject(plan) && typeof plan.planHash === 'string' ? (plan as unknown as Plan) : null;
}

/** Findings a 409 (`release_blocked`, `plan_blocked`) carries. */
export function findingsFromError(res: ApiResult<unknown>): PlanFinding[] {
    if (res.ok || !res.body) return [];
    const details = isObject(res.body.details) ? res.body.details : null;
    const list = (details && details.findings) || res.body.findings;
    return Array.isArray(list) ? (list as PlanFinding[]).filter(isObject) : [];
}

/** The acknowledgements a 409 `acknowledgement_missing` names. */
export function missingFromError(res: ApiResult<unknown>): PlanAck[] {
    if (res.ok || !res.body) return [];
    const details = isObject(res.body.details) ? res.body.details : null;
    const list = (details && details.missing) || res.body.missing;
    return Array.isArray(list) ? (list as PlanAck[]).filter(a => isObject(a) && typeof a.code === 'string') : [];
}

// ── What GET /api/projects/summary sends about stages ────────────────────────

export type StripTone = 'ok' | 'warning' | 'error' | 'busy' | 'none';

export interface StripStage {
    stage: StageKey;
    projectId: string | null;
    seq: number | null;
    tone: StripTone;
}

/**
 * `/summary` sends, per Solution, `stages:[{stage, projectId, currentReleaseSeq,
 * lastDeploymentStatus, pending}]`. The card draws `Dev · UAT R7 · PRD R6` from
 * it with a dot per stage. A stage with no deployment gets no dot colour ("none"),
 * never a green one: nothing was deployed, so nothing is healthy.
 */
function toneOf(status: string | null, pending: unknown): StripTone {
    if (status === 'failed') return 'error';
    if (pending || status === 'succeeded_with_warnings' || status === 'awaiting_approval') return 'warning';
    if (isActive(status)) return 'busy';
    return status === 'succeeded' ? 'ok' : 'none';
}

export function stripOf(stages: unknown): StripStage[] {
    if (!Array.isArray(stages)) return [];
    const out: StripStage[] = [];
    for (const raw of stages) {
        const s = (raw && typeof raw === 'object' ? raw : {}) as { stage?: string; projectId?: string; currentReleaseSeq?: number | null; lastDeploymentStatus?: string | null; pending?: unknown };
        if (s.stage !== 'uat' && s.stage !== 'prd') continue;
        out.push({
            stage: s.stage,
            projectId: typeof s.projectId === 'string' ? s.projectId : null,
            seq: typeof s.currentReleaseSeq === 'number' ? s.currentReleaseSeq : null,
            tone: toneOf(s.lastDeploymentStatus || null, s.pending),
        });
    }
    return out.sort((a, b) => (a.stage === b.stage ? 0 : a.stage === 'uat' ? -1 : 1));
}

export interface OperatedStage { solutionId: string; solutionName: string; stage: StageKey; projectId: string; role: string }

/** `operatedStages` from `/summary`: stage rows whose Dev the caller cannot see. */
export function operatedStagesOf(list: unknown): OperatedStage[] {
    if (!Array.isArray(list)) return [];
    const out: OperatedStage[] = [];
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const o = raw as Partial<OperatedStage>;
        if (typeof o.solutionId !== 'string' || typeof o.projectId !== 'string' || (o.stage !== 'uat' && o.stage !== 'prd')) continue;
        out.push({ solutionId: o.solutionId, solutionName: typeof o.solutionName === 'string' ? o.solutionName : '', stage: o.stage, projectId: o.projectId, role: typeof o.role === 'string' ? o.role : 'viewer' });
    }
    return out;
}

/** `?stage=` from a query string; anything but uat/prd is Dev. */
export function stageFromSearch(search: string | null | undefined): StageName {
    try {
        const v = new URLSearchParams(search || '').get('stage');
        return v === 'uat' || v === 'prd' ? v : 'dev';
    } catch { return 'dev'; }
}
