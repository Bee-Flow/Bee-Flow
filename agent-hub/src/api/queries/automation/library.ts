// Automations library: the ONLY place that knows the wire contract of the
// automation trash (GET /_trash, POST /:id/restore) and the server-side
// duplicate (POST /:id/duplicate).
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// callers render a failure as a sentence, and the tests mock `authFetch`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { queryClient } from '../../queryClient';

const BASE = `${API_BASE}/api/automation`;

/** One automation waiting in the trash. */
export interface TrashedAutomation {
    id: string;
    title: string;
    deletedAt: string | null;
    /** When the purge job removes it for good. */
    purgeAt: string | null;
}

export interface AutomationTrash {
    automations: TrashedAutomation[];
    retentionDays: number;
}

export const automationLibraryKeys = {
    trash: ['automation', 'trash'] as const,
};

/** A failed request, with the status the caller may branch on. */
export class LibraryRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

async function failure(res: Response, fallback: string): Promise<LibraryRequestError> {
    let message = fallback;
    try {
        const body = await res.json();
        if (body && typeof body.error === 'string' && body.error) message = body.error;
    } catch { /* not JSON: keep the fallback */ }
    return new LibraryRequestError(message, res.status);
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Normalise one /_trash body. Exported for the test; tolerant of junk. */
export function parseTrash(body: unknown): AutomationTrash {
    const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const rows = Array.isArray(raw.automations) ? raw.automations : [];
    const automations: TrashedAutomation[] = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const row = r as Record<string, unknown>;
        const id = text(row.id);
        if (!id) continue;
        automations.push({
            id,
            title: text(row.title) || '',
            deletedAt: text(row.deletedAt),
            purgeAt: text(row.purgeAt),
        });
    }
    const days = typeof raw.retentionDays === 'number' && raw.retentionDays > 0 ? raw.retentionDays : 30;
    return { automations, retentionDays: days };
}

export async function fetchAutomationTrash(signal?: AbortSignal): Promise<AutomationTrash> {
    const res = await authFetch(`${BASE}/_trash`, { signal });
    if (!res.ok) throw await failure(res, 'Could not read the trash.');
    return parseTrash(await res.json());
}

export async function restoreAutomation(id: string): Promise<{ id: string }> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    if (!res.ok) throw await failure(res, 'Could not restore that automation.');
    const body = await res.json().catch(() => null);
    return { id: text(body?.automation?.id) || id };
}

/**
 * Server-side duplicate: a draft copy without runs. Returns the new id, or
 * null when the server answered without one.
 */
export async function duplicateAutomationOnServer(id: string): Promise<string | null> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
    if (!res.ok) throw await failure(res, 'Could not duplicate that automation.');
    const body = await res.json().catch(() => null);
    return text(body?.automation?.id) || text(body?.id);
}

/** The trash is read only while its section is open. */
export function useAutomationTrashQuery({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<AutomationTrash, Error>({
        queryKey: automationLibraryKeys.trash,
        queryFn: ({ signal }) => fetchAutomationTrash(signal),
        enabled,
        // A delete elsewhere invalidates it; opening the section reads it fresh.
        staleTime: 0,
        retry: false,
    });
}

export function useRestoreAutomationMutation({ onRestored }: { onRestored?: (id: string) => void } = {}) {
    const client = useQueryClient();
    return useMutation<{ id: string }, Error, string>({
        mutationFn: restoreAutomation,
        onSuccess: ({ id }) => {
            void client.invalidateQueries({ queryKey: automationLibraryKeys.trash });
            onRestored?.(id);
        },
    });
}

/**
 * Called after a delete moved an automation into the trash, from code outside a
 * component (the library hook), so it reaches the shared client directly.
 */
export function invalidateAutomationTrash(): void {
    void queryClient.invalidateQueries({ queryKey: automationLibraryKeys.trash });
}
