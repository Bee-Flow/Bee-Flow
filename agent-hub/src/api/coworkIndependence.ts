// How independent a Cowork plan may be, over /api/cowork/:id/plan/independence (server/usecases/coworkIndependence.mts):
// the three levels, which the owner may choose now, and what each would ask about.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export type Independence = 'asks_everything' | 'asks_before_sending' | 'on_its_own';

export interface LevelOption {
    level: Independence;
    open: boolean;
    /** The steps a run at this level asks about first. */
    asksBefore: string[];
}

export interface IndependenceState {
    chosen: Independence | null;
    /** The level the next run uses; null when it cannot run as chosen. */
    level: Independence | null;
    asksAvailable: boolean;
    letThrough: number;
    needed: number;
    options: LevelOption[];
}

const key = (coworkId: string) => ['cowork', 'independence', coworkId] as const;

export function useCoworkIndependence(coworkId: string, enabled: boolean) {
    const client = useQueryClient();
    const query = useQuery<IndependenceState, Error>({
        queryKey: key(coworkId),
        enabled,
        queryFn: () => apiJson<'GET /api/cowork/{id}/plan/independence', IndependenceState>('GET /api/cowork/{id}/plan/independence', { params: { id: coworkId } }),
        retry: false,
    });
    const choose = useMutation<IndependenceState, Error, Independence>({
        mutationFn: (level) => apiJson<'PUT /api/cowork/{id}/plan/independence', IndependenceState>('PUT /api/cowork/{id}/plan/independence', { params: { id: coworkId }, body: { level } }),
        onSuccess: (state) => { client.setQueryData(key(coworkId), state); },
    });
    return { query, choose };
}

export interface TrustEntry { stepId: string; title: string; recipient: string; letThrough: number; trusted: boolean; canTrust: boolean }
export interface TrustState { entries: TrustEntry[]; needed: number; ceilingAllows: boolean }

/** Trust per step and recipient (GET/PUT /api/cowork/:id/plan/trust). */
export function useCoworkTrust(coworkId: string) {
    const client = useQueryClient();
    const trustKey = ['cowork', 'trust', coworkId] as const;
    const query = useQuery<TrustState, Error>({
        queryKey: trustKey,
        queryFn: () => apiJson<'GET /api/cowork/{id}/plan/trust', TrustState>('GET /api/cowork/{id}/plan/trust', { params: { id: coworkId } }),
        retry: false,
    });
    const choose = useMutation<TrustState, Error, { stepId: string; recipient: string; trusted: boolean }>({
        mutationFn: (body) => apiJson<'PUT /api/cowork/{id}/plan/trust', TrustState>('PUT /api/cowork/{id}/plan/trust', { params: { id: coworkId }, body }),
        onSuccess: (state) => { client.setQueryData(trustKey, state); },
    });
    return { query, choose };
}
