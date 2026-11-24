// Desks (server/usecases/coworkDesks.mts): coworks of different owners that hand work to each other. The desk one of
// my coworks is on or invited to, the desks I am on, one desk as I see it, and what changes them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export interface DeskSummary { id: string; name: string; isOwner: boolean }
export interface ItemDesk { id: string; name: string; accepted: boolean; deskRole: string | null; invitedBy: string | null }
export interface DeskMember {
    scheduleId: string; title: string; ownerName: string; mine: boolean; accepted: boolean; after: string | null;
    lastStatus: string | null; lastRunAt: string | null; deskRole: string | null;
    /**
     * It starts after a colleague's cowork on the desk: 'allowed' once that colleague said yes, 'waiting' until then
     * (it receives nothing). Null when it starts after none, or after a cowork of its own owner.
     */
    handOff: 'allowed' | 'waiting' | null;
    /** The reader owns the cowork it starts after: the reader allows the hand-off or withdraws it. */
    decidesHandOff: boolean;
}
interface DeskRole { role: string; holderId: string | null; standInId: string | null; awayUntil: string | null; holderName: string | null; standInName: string | null; away: boolean }
export interface RoleInput { role: string; holderId: string; standInId?: string | null; awayUntil?: string | null }
export interface DeskView {
    desk: { id: string; name: string; isOwner: boolean; ownerName: string };
    /** In the order work moves along them. */
    members: DeskMember[];
    roles: DeskRole[];
    /** For the desk's maker: the people of the organisation who can hold a role. */
    colleagues: Array<{ id: string; name: string }>;
}

const DESKS_KEY = ['cowork', 'desks'] as const;

export function useMyDesks(enabled = true) {
    return useQuery<DeskSummary[], Error>({
        queryKey: DESKS_KEY,
        enabled,
        queryFn: async () => (await apiJson<'GET /api/cowork/desks', { desks?: DeskSummary[] }>('GET /api/cowork/desks')).desks ?? [],
        staleTime: 30_000,
        retry: false,
    });
}

export function useItemDesk(coworkId: string) {
    return useQuery<ItemDesk | null, Error>({
        queryKey: [...DESKS_KEY, 'item', coworkId],
        queryFn: async () => (await apiJson<'GET /api/cowork/{id}/desk', { desk?: ItemDesk | null }>('GET /api/cowork/{id}/desk', { params: { id: coworkId } })).desk ?? null,
        retry: false,
    });
}

export function useDeskView(deskId: string | null) {
    return useQuery<DeskView, Error>({
        queryKey: [...DESKS_KEY, 'view', deskId],
        enabled: !!deskId,
        queryFn: () => apiJson<'GET /api/cowork/desks/{id}', DeskView>('GET /api/cowork/desks/{id}', { params: { id: String(deskId) } }),
        retry: false,
    });
}

/** A change to a desk; afterwards every desk read is read again. */
function useDeskChange<V>(fn: (vars: V) => Promise<unknown>) {
    const client = useQueryClient();
    return useMutation<unknown, Error, V>({
        mutationFn: fn,
        onSuccess: () => { void client.invalidateQueries({ queryKey: DESKS_KEY }); },
    });
}

/** What the owner of one cowork does with desks: put it on one (a new one too), accept, leave, choose its role. */
export function useItemDeskActions(coworkId: string) {
    const params = (deskId: string) => ({ id: deskId, scheduleId: coworkId });
    const add = (deskId: string) => apiJson('POST /api/cowork/desks/{id}/members', { params: { id: deskId }, body: { scheduleId: coworkId } });
    return {
        join: useDeskChange<string>(add),
        create: useDeskChange<string>(async (name) => {
            const made = await apiJson<'POST /api/cowork/desks', DeskView>('POST /api/cowork/desks', { body: { name } });
            return add(made.desk.id);
        }),
        accept: useDeskChange<string>((deskId) => apiJson('POST /api/cowork/desks/{id}/members/{scheduleId}/accept', { params: params(deskId), body: {} })),
        leave: useDeskChange<string>((deskId) => apiJson('DELETE /api/cowork/desks/{id}/members/{scheduleId}', { params: params(deskId) })),
        chooseRole: useDeskChange<{ deskId: string; deskRole: string | null }>(({ deskId, deskRole }) => apiJson('PUT /api/cowork/desks/{id}/members/{scheduleId}', { params: params(deskId), body: { deskRole } })),
    };
}

/** What the owner of a cowork does about a colleague's cowork that starts after it: let it receive the result, or stop that. */
export function useDeskHandOff(deskId: string) {
    const params = (scheduleId: string) => ({ id: deskId, scheduleId });
    return {
        allow: useDeskChange<string>((scheduleId) => apiJson('POST /api/cowork/desks/{id}/members/{scheduleId}/hand-off', { params: params(scheduleId), body: {} })),
        withdraw: useDeskChange<string>((scheduleId) => apiJson('DELETE /api/cowork/desks/{id}/members/{scheduleId}/hand-off', { params: params(scheduleId) })),
    };
}

/** What the desk's maker does: set its roles, remove it. */
export function useDeskOwnerActions(deskId: string) {
    return {
        saveRoles: useDeskChange<RoleInput[]>((roles) => apiJson('PUT /api/cowork/desks/{id}/roles', { params: { id: deskId }, body: { roles } })),
        remove: useDeskChange<void>(() => apiJson('DELETE /api/cowork/desks/{id}', { params: { id: deskId } })),
    };
}
