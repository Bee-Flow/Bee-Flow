// Which agents may call an agent_call automation: the ONLY place that knows the
// wire contract of GET/PUT /api/automation/:id/agent-bindings, so a server
// change is adjusted here and nowhere else.
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// caller renders a failure as a sentence, and the tests mock `authFetch`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';

const BASE = `${API_BASE}/api/automation`;

/** One linked agent as THIS viewer may see it. */
export interface BoundAgent {
    /** null = an agent the viewer may not edit: shown as "another agent", no name. */
    agentId: string | null;
    name: string | null;
    canEdit: boolean;
    /** The agent no longer exists; an editor of the automation can clear the row. */
    missing: boolean;
    /** The automation's owner may still use the agent (false = linked but inert). null = not said. */
    usable: boolean | null;
    /**
     * The agent curates its automations and leaves this one out, so it is linked
     * but never offered. null = not said (an agent the viewer cannot edit, or an
     * unreadable config), which is not the same as granted.
     */
    notGranted: boolean | null;
}

export interface AgentCandidate { id: string; name: string; description: string | null }

export interface AgentBindings {
    bindings: BoundAgent[];
    /** What the viewer may add. null = could not be read (never "none"). */
    candidates: AgentCandidate[] | null;
    canManage: boolean;
    /** The saved trigger is an agent tool; linking needs that first. */
    isAgentCall: boolean;
    /** The name the agent calls it by. */
    toolName: string | null;
    /** Bindings the viewer cannot edit that a save left in place. */
    kept: number;
}

export const agentBindingKeys = {
    one: (id: string) => ['automation-agent-bindings', id] as const,
};

/** A failed call, carrying the server's code (`agent_not_linkable`, …) and its own sentence. */
export class AgentBindingsError extends Error {
    status: number;
    code: string | null;
    serverMessage: string | null;
    constructor(status: number, code: string | null, serverMessage: string | null = null) {
        super(code || `request failed (${status})`);
        this.status = status;
        this.code = code;
        this.serverMessage = serverMessage;
    }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Normalise a GET/PUT answer. Exported for the test; tolerant of junk. */
export function parseAgentBindings(body: unknown): AgentBindings {
    const raw = obj(body);
    const bindings: BoundAgent[] = [];
    for (const b of Array.isArray(raw.bindings) ? raw.bindings : []) {
        const o = obj(b);
        const canEdit = o.canEdit === true;
        bindings.push({
            // An agent the viewer may not edit never carries an id, whatever the server sent.
            agentId: canEdit ? str(o.agentId) : null,
            name: canEdit ? str(o.name) : null,
            canEdit,
            missing: o.missing === true,
            usable: typeof o.usable === 'boolean' ? o.usable : null,
            notGranted: typeof o.notGranted === 'boolean' ? o.notGranted : null,
        });
    }
    const candidates = Array.isArray(raw.candidates)
        ? raw.candidates.flatMap((c): AgentCandidate[] => {
            const o = obj(c);
            const id = str(o.id);
            return id ? [{ id, name: str(o.name) || id, description: str(o.description) }] : [];
        })
        : null;
    return {
        bindings,
        candidates,
        canManage: raw.canManage === true,
        isAgentCall: raw.isAgentCall === true,
        toolName: str(raw.toolName),
        kept: typeof raw.kept === 'number' && raw.kept > 0 ? raw.kept : 0,
    };
}

async function failure(res: { status: number; json: () => Promise<unknown> }): Promise<AgentBindingsError> {
    let code: string | null = null;
    let message: string | null = null;
    try {
        const body = obj(await res.json());
        code = str(body.code);
        message = code ? str(body.error) : null;
    } catch { /* no body */ }
    return new AgentBindingsError(res.status, code, message);
}

export async function fetchAgentBindings(id: string, signal?: AbortSignal): Promise<AgentBindings> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/agent-bindings`, { signal });
    if (!res.ok) throw await failure(res);
    return parseAgentBindings(await res.json());
}

/** `agentIds` = the editable agents that should be linked after the save. */
export async function saveAgentBindings(id: string, agentIds: string[]): Promise<AgentBindings> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/agent-bindings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds }),
    });
    if (!res.ok) throw await failure(res);
    return parseAgentBindings(await res.json());
}

export function useAgentBindings(id: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: agentBindingKeys.one(id || ''),
        queryFn: ({ signal }) => fetchAgentBindings(id as string, signal),
        enabled: !!id && enabled,
        staleTime: 15_000,
        retry: false,
    });
}

/**
 * The ids of the automations linked to one agent, for the agent editor. null =
 * could not be read (never "none"), so the editor then says nothing about links.
 */
export async function fetchLinkedAutomationIds(agentId: string, signal?: AbortSignal): Promise<string[]> {
    const res = await authFetch(`${BASE}/by-agent/${encodeURIComponent(agentId)}/automation-ids`, { signal });
    if (!res.ok) throw await failure(res);
    const ids = obj(await res.json()).automationIds;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

export function useLinkedAutomationIds(agentId: string | null | undefined) {
    return useQuery({
        queryKey: ['automation-agent-bindings', 'by-agent', agentId || ''] as const,
        queryFn: ({ signal }) => fetchLinkedAutomationIds(agentId as string, signal),
        enabled: !!agentId,
        staleTime: 15_000,
        retry: false,
    });
}

export function useSaveAgentBindings(id: string) {
    const qc = useQueryClient();
    return useMutation<AgentBindings, AgentBindingsError, string[]>({
        mutationFn: (agentIds) => saveAgentBindings(id, agentIds),
        onSuccess: (data) => { qc.setQueryData(agentBindingKeys.one(id), data); },
    });
}
