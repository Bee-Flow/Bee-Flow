import { API_BASE, authFetch } from '../../../../../../utils/helpers';
import type { ApiResult, StageKey } from '../stagesApi';
import {
    readDecls, readRequirements, readSettings, readValues,
    type ApprovalPolicy, type RemoveMode, type StageSettings, type VariableDecl, type VariableValue,
} from './stageSettingsModel';

/**
 * The settings page's wire: typed fetchers over authFetch for the stage routes of
 * design section 8 that stagesApi.ts does not cover (requirements, bindings,
 * variables, parts, the gate, removal).
 *
 * Same contract as stagesApi.ts: an answer is an ApiResult, never a thrown error
 * and never a bare `null`; "the server said no, here is the code" and "the
 * request never arrived" stay different (`network`). Only PATCH of the stage and
 * PUT of the bindings take `settingsVersion`: the other routes validate closed
 * bodies and refuse the key.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const enc = encodeURIComponent;

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
    try {
        const res = await authFetch(`${API_BASE}${path}`, {
            method: init.method || 'GET',
            ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
        });
        const body: unknown = await res.json().catch(() => null);
        if (res.ok) return { ok: true, status: res.status, data: body as T };
        const obj = isObject(body) ? body : null;
        return {
            ok: false, status: res.status,
            code: obj && typeof obj.code === 'string' ? obj.code : null,
            message: obj && typeof obj.error === 'string' ? obj.error : null,
            body: obj,
        };
    } catch {
        return { ok: false, status: 0, code: 'network', message: null, body: null };
    }
}

const stagePath = (solutionId: string, stage: StageKey) => `/api/projects/${enc(solutionId)}/stages/${enc(stage)}`;

/** Maps a successful body through a reader; a body that is not what we expect is a failed read, not an empty one. */
function read<T, R>(res: ApiResult<T>, reader: (body: unknown) => R | null): ApiResult<R> {
    if (!res.ok) return res;
    const data = reader(res.data);
    return data === null ? { ok: false, status: res.status, code: 'unreadable', message: null, body: null } : { ...res, data };
}

export const getSettings = async (solutionId: string, stage: StageKey) =>
    read(await call<unknown>(stagePath(solutionId, stage)), readSettings);

/** `releaseId` = the release the stage runs; without one the server answers for the latest cut release. */
export const getRequirements = async (solutionId: string, stage: StageKey, releaseId?: string | null) =>
    read(await call<unknown>(`${stagePath(solutionId, stage)}/requirements${releaseId ? `?releaseId=${enc(releaseId)}` : ''}`), readRequirements);

export interface VariablesRead { decls: VariableDecl[]; values: VariableValue[] }
export const getVariables = async (solutionId: string, stage: StageKey) =>
    read(await call<unknown>(`${stagePath(solutionId, stage)}/variables`), (b): VariablesRead | null =>
        (isObject(b) ? { decls: readDecls(b.variables), values: readValues(b.values) } : null));

export const getDevVariables = async (solutionId: string) =>
    read(await call<unknown>(`/api/projects/${enc(solutionId)}/variables`), (b): VariableDecl[] | null =>
        (isObject(b) && Array.isArray(b.variables) ? readDecls(b.variables) : null));

export type DeclBody = Array<{ name: string; type: string; choices: string[] | null; description: string; required: boolean; steering: boolean }>;
export const putDevVariables = async (solutionId: string, variables: DeclBody) =>
    read(await call<unknown>(`/api/projects/${enc(solutionId)}/variables`, { method: 'PUT', body: { variables } }), (b): VariableDecl[] | null =>
        (isObject(b) ? readDecls(b.variables) : null));

export const putValues = (solutionId: string, stage: StageKey, values: Record<string, string | number | boolean | null>) =>
    call<{ written?: string[]; pending?: boolean; bindingsPending?: boolean }>(`${stagePath(solutionId, stage)}/variables`, { method: 'PUT', body: { values } });

export const putBindings = (solutionId: string, stage: StageKey, settingsVersion: number, bindings: Array<{ slot: string; value: unknown }>) =>
    call<{ ignored?: string[]; bindingsPending?: boolean; settingsVersion?: number }>(`${stagePath(solutionId, stage)}/bindings`, {
        method: 'PUT', body: { settingsVersion, bindings },
    });

export interface GatePatch { requiresApproval?: boolean; approvalPolicy?: ApprovalPolicy | null; rollbackNeedsApproval?: boolean; newPartsActive?: boolean }
export const patchStage = (solutionId: string, stage: StageKey, settingsVersion: number, patch: GatePatch) =>
    call<Json>(stagePath(solutionId, stage), { method: 'PATCH', body: { settingsVersion, ...patch } });

/** A 200 settings view merged onto what we hold (the view carries no parts or addresses). */
export function mergeSettings(prev: StageSettings, view: unknown): StageSettings {
    const o = isObject(view) ? view : {};
    return {
        ...prev,
        settingsVersion: typeof o.settingsVersion === 'number' ? o.settingsVersion : prev.settingsVersion,
        enabled: typeof o.enabled === 'boolean' ? o.enabled : prev.enabled,
        paused: typeof o.paused === 'boolean' ? o.paused : prev.paused,
        newPartsActive: typeof o.newPartsActive === 'boolean' ? o.newPartsActive : prev.newPartsActive,
        requiresApproval: typeof o.requiresApproval === 'boolean' ? o.requiresApproval : prev.requiresApproval,
        approvalPolicy: 'approvalPolicy' in o ? ((isObject(o.approvalPolicy) && Array.isArray(o.approvalPolicy.stages) ? o.approvalPolicy : null) as ApprovalPolicy | null) : prev.approvalPolicy,
        rollbackNeedsApproval: typeof o.rollbackNeedsApproval === 'boolean' ? o.rollbackNeedsApproval : prev.rollbackNeedsApproval,
        bindingsPending: typeof o.bindingsPending === 'boolean' ? o.bindingsPending : prev.bindingsPending,
    };
}

export const patchPart = (solutionId: string, stage: StageKey, ref: string, active: boolean) =>
    call<{ ref: string; isActive?: boolean; isPublished?: boolean }>(`${stagePath(solutionId, stage)}/parts/${enc(ref)}`, { method: 'PATCH', body: { active } });

export const pauseStage = (solutionId: string, stage: StageKey, pause: boolean) =>
    call<{ paused: boolean; changed: boolean; count: number; failed: Array<{ id: string; code: string }>; settingsVersion?: number }>(
        `${stagePath(solutionId, stage)}/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: {} });

export const removeStage = (solutionId: string, stage: StageKey, body: { confirm: string; mode: RemoveMode; deleteData?: boolean }) =>
    call<{ detached?: boolean; deployment?: { id: string; status: string } }>(stagePath(solutionId, stage), { method: 'DELETE', body });

// ── People and connections the pickers offer ─────────────────────────────────

export interface Directory { members: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }> }
export interface ConnectionOption { id: string; label: string; kind?: string }

const named = (list: unknown): Array<{ id: string; name: string }> =>
    (Array.isArray(list) ? list : []).filter(isObject).filter(x => typeof x.id === 'string')
        .map(x => ({ id: x.id as string, name: typeof x.name === 'string' && x.name ? x.name : (x.id as string) }));

export const getDirectory = async (): Promise<ApiResult<Directory>> => {
    const res = await call<unknown>('/api/automation/approvals/directory');
    if (!res.ok) return res;
    const o = isObject(res.data) ? res.data : {};
    return { ...res, data: { members: named(o.members), groups: named(o.groups) } };
};

export const getConnections = async (): Promise<ApiResult<ConnectionOption[]>> => {
    const res = await call<unknown>('/api/integrations/connections?provider=http&includeShared=1');
    if (!res.ok) return res;
    const list = isObject(res.data) && Array.isArray(res.data.connections) ? res.data.connections : [];
    return {
        ...res,
        data: list.filter(isObject).filter(c => typeof c.id === 'string')
            .map(c => ({ id: c.id as string, label: typeof c.label === 'string' && c.label ? c.label : (c.id as string), kind: typeof c.kind === 'string' ? c.kind : undefined })),
    };
};
