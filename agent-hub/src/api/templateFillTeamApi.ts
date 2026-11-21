/**
 * Filling in a template together in a project: who filled in which field, and
 * requests to colleagues for the fields only they know
 * (server/core/documents/valueRequests.mts).
 *
 *   POST /api/studio-documents/:id/value-requests                   { fields, assigneeIds, message? } → { requests }
 *   POST /api/studio-documents/:id/value-requests/:requestId/close  → { requests }
 *
 * The document's GET carries both in its settings (valueRequests, filledBy).
 */
import { apiJson } from './typedRequest';

export interface ValueRequest {
    id: string;
    fields: string[];
    assigneeId: string;
    requestedBy: string;
    message: string;
    createdAt: string;
    doneAt?: string;
    cancelledAt?: string;
}

export type FilledBy = Record<string, { userId: string; at: string }>;

export interface TeamState {
    projectId: string | null;
    requests: ValueRequest[];
    filledBy: FilledBy;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function requestsFrom(raw: unknown): ValueRequest[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is ValueRequest => isObject(r) && typeof r.id === 'string' && typeof r.assigneeId === 'string' && Array.isArray(r.fields));
}

/** The team part of a document as its GET answers it, read defensively. */
export function teamStateOf(body: unknown): TeamState {
    const doc = isObject(body) && isObject(body.document) ? body.document : {};
    const settings = isObject(doc.settings) ? doc.settings : {};
    return {
        projectId: typeof doc.projectId === 'string' && doc.projectId ? doc.projectId : null,
        requests: requestsFrom(settings.valueRequests),
        filledBy: isObject(settings.filledBy) ? settings.filledBy as FilledBy : {},
    };
}

export const isOpenRequest = (r: ValueRequest): boolean => !r.doneAt && !r.cancelledAt;

export async function askColleagues(id: string, fields: string[], assigneeIds: string[], message?: string): Promise<ValueRequest[]> {
    const body = await apiJson<'POST /api/studio-documents/{id}/value-requests', { requests?: unknown }>(
        'POST /api/studio-documents/{id}/value-requests',
        { params: { id }, body: { fields, assigneeIds, ...(message?.trim() ? { message: message.trim() } : {}) } },
    );
    return requestsFrom(body.requests);
}

export async function closeValueRequest(id: string, requestId: string): Promise<ValueRequest[]> {
    const body = await apiJson<'POST /api/studio-documents/{id}/value-requests/{requestId}/close', { requests?: unknown }>(
        'POST /api/studio-documents/{id}/value-requests/{requestId}/close', { params: { id, requestId } },
    );
    return requestsFrom(body.requests);
}
