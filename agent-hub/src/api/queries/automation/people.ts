// Who can do what with one routine: the ONLY place that knows the wire
// contract of the sharing endpoints (GET/PUT /:id/shares,
// POST /:id/transfer-owner) and of the people/group search the dialogs use
// (GET /:id/principals).
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// callers render a failure as a sentence, and the tests mock `authFetch`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';

const BASE = `${API_BASE}/api/automation`;

export type ShareRole = 'run' | 'view' | 'edit';
export type PrincipalType = 'user' | 'group';

export interface Share {
    principalType: PrincipalType;
    principalId: string;
    name: string;
    memberCount: number | null;
    role: ShareRole;
    /** The person or group no longer exists; left out of the next save. */
    missing?: boolean;
}

export interface AutomationShares {
    owner: { userId: string; name: string } | null;
    shares: Share[];
    runsAs: { userId: string; name: string } | null;
    /** The viewer may change the list (the owner). null = the server did not say. */
    canManage: boolean | null;
    /** The plan includes sharing. null = the server did not say. */
    sharingAvailable: boolean | null;
}

/** One hit of the people/group search. */
export interface Principal {
    type: PrincipalType;
    id: string;
    name: string;
    detail: string | null;
    memberCount: number | null;
}

export const ROLES: readonly ShareRole[] = ['run', 'view', 'edit'];

export const automationPeopleKeys = {
    shares: (id: string) => ['automation-people', 'shares', id] as const,
    directory: (id: string) => ['automation-people', 'directory', id] as const,
};

/** A failed call that carries the server's error code (`feature_locked`, …). */
export class PeopleRequestError extends Error {
    status: number;
    code: string | null;
    /** The server's own sentence (HttpError messages are written for the user). */
    serverMessage: string | null;
    constructor(status: number, code: string | null, serverMessage: string | null = null) {
        super(code || `request failed (${status})`);
        this.status = status;
        this.code = code;
        this.serverMessage = serverMessage;
    }
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '');
}
function count(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
function obj(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function person(v: unknown): { userId: string; name: string } | null {
    const o = obj(v);
    const userId = str(o.userId ?? o.id);
    if (!userId) return null;
    return { userId, name: str(o.name) || userId };
}

/** Normalise GET /:id/shares. Exported for the test; tolerant of junk. */
export function parseShares(body: unknown): AutomationShares {
    const raw = obj(body);
    const shares: Share[] = [];
    for (const s of Array.isArray(raw.shares) ? raw.shares : []) {
        const o = obj(s);
        const principalType = o.principalType === 'group' ? 'group' : (o.principalType === 'user' ? 'user' : null);
        const principalId = str(o.principalId);
        const role = ROLES.includes(o.role as ShareRole) ? o.role as ShareRole : null;
        if (!principalType || !principalId || !role) continue;
        shares.push({
            principalType, principalId, role, name: str(o.name) || principalId, memberCount: count(o.memberCount),
            ...(o.missing === true ? { missing: true } : {}),
        });
    }
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
    return {
        owner: person(raw.owner), shares, runsAs: person(raw.runsAs),
        canManage: flag(raw.canManage), sharingAvailable: flag(raw.sharingAvailable),
    };
}

async function failure(res: { status: number; json: () => Promise<unknown> }): Promise<PeopleRequestError> {
    let code: string | null = null;
    let message: string | null = null;
    try {
        const body = obj(await res.json());
        const error = str(body.error);
        // An HttpError carries `code` + a sentence in `error`; the licence gate
        // sends the code itself in `error` ('feature_locked', 'feature_disabled').
        code = str(body.code) || (/^[a-z_]+$/.test(error) ? error : null);
        message = body.code ? error || null : null;
    } catch { /* no body */ }
    return new PeopleRequestError(res.status, code, message);
}

export async function fetchShares(id: string, signal?: AbortSignal): Promise<AutomationShares> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/shares`, { signal });
    if (!res.ok) throw await failure(res);
    return parseShares(await res.json());
}

export async function saveShares(id: string, shares: Share[]): Promise<AutomationShares> {
    // A person or group that no longer exists would make the server refuse
    // the whole list (share_user_unknown), so every later change would fail.
    const body = shares
        .filter(s => !s.missing)
        .map(s => ({ principalType: s.principalType, principalId: s.principalId, role: s.role }));
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/shares`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shares: body }),
    });
    if (!res.ok) throw await failure(res);
    return parseShares(await res.json());
}

export interface TransferResult {
    /** The routine as the caller now sees it (the old owner is an editor). */
    automation: Record<string, unknown> | null;
    /** English sentences of what did not go through (e.g. the event trigger). */
    warnings: string[];
}

export async function transferOwner(id: string, userId: string): Promise<TransferResult> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/transfer-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw await failure(res);
    const body = obj(await res.json().catch(() => null));
    const automation = obj(body.automation);
    const warnings = (Array.isArray(body.warnings) ? body.warnings : [])
        .map(w => str(obj(w).message) || str(w))
        .filter(Boolean);
    return { automation: Object.keys(automation).length ? automation : null, warnings };
}

export function useAutomationShares(id: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: automationPeopleKeys.shares(id || ''),
        queryFn: ({ signal }) => fetchShares(id as string, signal),
        enabled: !!id && enabled,
        staleTime: 30_000,
        retry: false,
    });
}

export function useSaveShares(id: string) {
    const qc = useQueryClient();
    return useMutation<AutomationShares, PeopleRequestError, Share[]>({
        mutationFn: (shares) => saveShares(id, shares),
        onSuccess: (data) => { qc.setQueryData(automationPeopleKeys.shares(id), data); },
    });
}

export function useTransferOwner(id: string, { onDone }: { onDone?: (result: TransferResult) => void } = {}) {
    const qc = useQueryClient();
    return useMutation<TransferResult, PeopleRequestError, string>({
        mutationFn: (userId) => transferOwner(id, userId),
        onSuccess: (result) => {
            void qc.invalidateQueries({ queryKey: automationPeopleKeys.shares(id) });
            onDone?.(result);
        },
    });
}

// ── People and groups to pick from ─────────────────────────────────────────
//
// The directory is read ONCE and filtered on the client: an org has tens to
// hundreds of members, and a picker that waits on the network per keystroke
// feels broken. `GET /api/automation/:id/principals` is the routine-scoped
// list (the routine's organisation, `{ users: [{ id, name }], groups: [{ id,
// name, memberCount }] }`) anyone who may view the routine can read. A server
// without it answers 404; then `GET /api/automation/approvals/directory` (the
// caller's organisation, behind the approvals licence) and finally the admin
// lists (`/auth/users`, `/auth/groups`, admin only) stand in.

function toUser(v: unknown): Principal | null {
    const o = obj(v);
    const id = str(o.id ?? o.userId);
    if (!id) return null;
    const name = str(o.name) || str(o.displayName) || str(o.username) || str(o.email) || id;
    const email = str(o.email);
    return { type: 'user', id, name, detail: email && email !== name ? email : null, memberCount: null };
}

function toGroup(v: unknown): Principal | null {
    const o = obj(v);
    const id = str(o.id ?? o.groupId);
    if (!id) return null;
    const members = Array.isArray(o.members) ? o.members.length : (Array.isArray(o.userIds) ? o.userIds.length : null);
    return { type: 'group', id, name: str(o.name) || id, detail: null, memberCount: count(o.memberCount) ?? members };
}

/** Normalise a directory body: `{ users, groups }`. Exported for the test. */
export function parseDirectory(body: unknown): Principal[] {
    const raw = obj(body);
    const users = (Array.isArray(raw.users) ? raw.users : []).map(toUser);
    const groups = (Array.isArray(raw.groups) ? raw.groups : []).map(toGroup);
    return [...groups, ...users].filter((p): p is Principal => !!p);
}

async function readList(url: string, signal?: AbortSignal): Promise<unknown[]> {
    try {
        const res = await authFetch(url, { signal });
        if (!res.ok) return [];
        const body = await res.json();
        return Array.isArray(body) ? body : [];
    } catch {
        return [];
    }
}

export async function fetchDirectory(automationId: string, signal?: AbortSignal): Promise<Principal[]> {
    const own = await authFetch(`${BASE}/${encodeURIComponent(automationId)}/principals`, { signal });
    if (own.ok) return parseDirectory(await own.json());
    if (own.status !== 404) return [];
    const res = await authFetch(`${BASE}/approvals/directory`, { signal });
    if (res.ok) {
        const body = obj(await res.json());
        return parseDirectory({ users: body.members ?? body.users, groups: body.groups });
    }
    const [users, groups] = await Promise.all([
        readList(`${API_BASE}/auth/users`, signal),
        readList(`${API_BASE}/auth/groups`, signal),
    ]);
    return parseDirectory({ users, groups });
}

export function usePeopleDirectory(automationId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: automationPeopleKeys.directory(automationId || ''),
        queryFn: ({ signal }) => fetchDirectory(automationId as string, signal),
        enabled: enabled && !!automationId,
        staleTime: 5 * 60_000,
        retry: false,
    });
}

/** Case-insensitive match on name and detail, groups first. Pure. */
export function filterPrincipals(all: Principal[], query: string, exclude: Set<string> = new Set()): Principal[] {
    const q = query.trim().toLowerCase();
    return all
        .filter(p => !exclude.has(`${p.type}:${p.id}`))
        .filter(p => !q || p.name.toLowerCase().includes(q) || (p.detail || '').toLowerCase().includes(q))
        .slice(0, 8);
}
