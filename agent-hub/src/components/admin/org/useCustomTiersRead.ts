// The custom tier editor's load: the scope's tiers and every provider's models,
// once per mount, seeding the editor's working copy.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

export interface OrgTier {
    id: string;
    label?: string;
    icon?: string;
    description?: string;
    modelId?: string;
    euModelId?: string;
    maxTokens?: number;
    temperature?: number;
    allowedTaskTypes?: string[];
}

export interface AvailableModel {
    id: string;
    name?: string;
    providerName?: string;
    providerType?: string;
}

/** What one load of the editor found; a refused list stays null, so the editor keeps what it showed. */
interface CustomTiersRead {
    orgTiers: OrgTier[] | null;
    globalTiers: OrgTier[] | null;
    models: AvailableModel[] | null;
    /** The tier list was refused with 403. */
    forbidden: boolean;
    /** The load failed part way; what it read before that is kept. */
    failed: boolean;
}

/** The scope's tiers and every provider's models; a refusal is an answer here (the 403 text, "no providers"), not a failure. */
async function readCustomTiers(scopeOrgId: string | null | undefined): Promise<CustomTiersRead> {
    const out: CustomTiersRead = { orgTiers: null, globalTiers: null, models: null, forbidden: false, failed: false };
    try {
        const refusal = (err: unknown) => {
            if (err instanceof RefusedError) return err;
            throw err;
        };
        const [tiersRes, providersRes] = await Promise.all([
            apiRequest('GET /ai/config/org-custom-chat-models', { query: { orgId: scopeOrgId || undefined } }).catch(refusal),
            apiRequest('GET /ai/providers').catch(refusal),
        ]);
        if (!(tiersRes instanceof RefusedError)) {
            const data = await tiersRes.json();
            out.orgTiers = Array.isArray(data.orgTiers) ? data.orgTiers : [];
            out.globalTiers = Array.isArray(data.globalTiers) ? data.globalTiers : [];
        } else if (tiersRes.status === 403) {
            out.forbidden = true;
        }
        if (!(providersRes instanceof RefusedError)) {
            const { providers } = await providersRes.json();
            const results = await Promise.all(
                (providers || []).map(async (p: { id: string; name?: string; type?: string }) => {
                    try {
                        const r = await apiRequest('GET /ai/providers/{id}/models', { params: { id: p.id } }).catch((err: unknown) => {
                            if (err instanceof RefusedError) return null;
                            throw err;
                        });
                        if (r) {
                            const { models } = await r.json();
                            return (models || []).map((m: AvailableModel) => ({ ...m, providerName: p.name, providerType: p.type }));
                        }
                        return [];
                    } catch (_) { return []; }
                })
            );
            out.models = results.flat();
        }
    } catch (e) {
        console.error('Failed to load org custom tiers:', e);
        out.failed = true;
    }
    return out;
}

/** The editor's load; `onAnswer` gets each answer once. True while the first answer is pending. */
export function useCustomTiersRead(scopeOrgId: string | null, onAnswer: (d: CustomTiersRead) => void): boolean {
    const read = useQuery<CustomTiersRead>({
        queryKey: ['orgAdmin', 'customTiers', scopeOrgId],
        queryFn: () => readCustomTiers(scopeOrgId),
        // One read per mount, as the editor's working copy: no cached copy, no refetch under an edit.
        staleTime: 0,
        gcTime: 0,
        retry: false,
        refetchOnReconnect: false,
        structuralSharing: false,
    });
    const [seeded, setSeeded] = useState<CustomTiersRead | null>(null);
    if (read.data && read.data !== seeded) {
        setSeeded(read.data);
        onAnswer(read.data);
    }
    return read.isPending;
}
