/**
 * Filling in a template together: who filled in which field, requests to
 * colleagues for the fields only they know, the notes people leave each other
 * and the assistant's final check (server/core/documents/fillTogether.mts).
 *
 *   POST   /api/studio-documents/:id/value-requests                   { fields, assigneeIds, message? }
 *   POST   /api/studio-documents/:id/value-requests/:requestId/close
 *   POST   /api/studio-documents/:id/field-notes                      { key?, text }
 *   DELETE /api/studio-documents/:id/field-notes/:noteId
 *
 * Each answers where the filling stands with these four next to it; the
 * document's GET carries them in its settings (valueRequests, filledBy,
 * fieldNotes, fillReview).
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

export type FilledBy = Record<string, { userId: string; at: string; via?: 'ai' }>;

export interface FieldNote {
    id: string;
    /** The field the note is at; '' for a note on the whole document. */
    key: string;
    userId: string;
    text: string;
    at: string;
}

export interface FillFinding {
    key: string;
    /** rewrite: a better wording is offered. doubt: the value does not look right. */
    kind: 'rewrite' | 'doubt';
    reason: string;
    suggestion?: string;
}

interface FillReview {
    at: string;
    checked: number;
    findings: FillFinding[];
}

/** What is shown next to the values of a document that is being filled in. */
export interface FillTeam {
    requests: ValueRequest[];
    filledBy: FilledBy;
    notes: FieldNote[];
    /** Null while the document was never checked. */
    review: FillReview | null;
}

export const NO_TEAM: FillTeam = { requests: [], filledBy: {}, notes: [], review: null };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function requestsFrom(raw: unknown): ValueRequest[] {
    return list(raw).filter((r): r is ValueRequest => isObject(r) && typeof r.id === 'string' && typeof r.assigneeId === 'string' && Array.isArray(r.fields));
}

function notesFrom(raw: unknown): FieldNote[] {
    return list(raw).filter((n): n is FieldNote => isObject(n) && typeof n.id === 'string' && typeof n.key === 'string'
        && typeof n.userId === 'string' && typeof n.text === 'string');
}

const isFinding = (f: unknown): f is FillFinding & { was?: string } => isObject(f) && typeof f.key === 'string'
    && (f.kind === 'rewrite' || f.kind === 'doubt') && typeof f.reason === 'string';

/**
 * The final check, read defensively. The routes answer only the remarks that
 * still apply; the document's own settings also keep the value each remark was
 * made about (`was`), so with `values` a remark on a value that changed since
 * is left out here as well.
 */
function reviewFrom(raw: unknown, values?: Record<string, unknown>): FillReview | null {
    if (!isObject(raw) || typeof raw.at !== 'string') return null;
    const findings = list(raw.findings).filter(isFinding)
        .filter((f) => !values || typeof f.was !== 'string' || f.was === JSON.stringify(values[f.key] ?? null))
        .map((f) => ({ key: f.key, kind: f.kind, reason: f.reason, ...(typeof f.suggestion === 'string' ? { suggestion: f.suggestion } : {}) }));
    return { at: raw.at, checked: typeof raw.checked === 'number' ? raw.checked : 0, findings };
}

/** The four, from a route's answer (or from a document's settings, with its `values`). */
export function teamOf(body: unknown, values?: Record<string, unknown>): FillTeam {
    const b = isObject(body) ? body : {};
    return {
        requests: requestsFrom(b.requests), filledBy: isObject(b.filledBy) ? b.filledBy as FilledBy : {},
        notes: notesFrom(b.notes), review: reviewFrom(b.review, values),
    };
}

export const isOpenRequest = (r: ValueRequest): boolean => !r.doneAt && !r.cancelledAt;

/** What people do together on a form besides filling in; a test hands in its own. */
export interface FillTeamApi {
    ask: (id: string, fields: string[], assigneeIds: string[], message?: string) => Promise<FillTeam>;
    closeRequest: (id: string, requestId: string) => Promise<FillTeam>;
    addNote: (id: string, key: string, text: string) => Promise<FillTeam>;
    removeNote: (id: string, noteId: string) => Promise<FillTeam>;
}

async function askColleagues(id: string, fields: string[], assigneeIds: string[], message?: string): Promise<FillTeam> {
    return teamOf(await apiJson('POST /api/studio-documents/{id}/value-requests', {
        params: { id }, body: { fields, assigneeIds, ...(message?.trim() ? { message: message.trim() } : {}) },
    }));
}

async function closeValueRequest(id: string, requestId: string): Promise<FillTeam> {
    return teamOf(await apiJson('POST /api/studio-documents/{id}/value-requests/{requestId}/close', { params: { id, requestId }, body: {} }));
}

async function addFieldNote(id: string, key: string, text: string): Promise<FillTeam> {
    return teamOf(await apiJson('POST /api/studio-documents/{id}/field-notes', { params: { id }, body: { ...(key ? { key } : {}), text } }));
}

async function removeFieldNote(id: string, noteId: string): Promise<FillTeam> {
    return teamOf(await apiJson('DELETE /api/studio-documents/{id}/field-notes/{noteId}', { params: { id, noteId } }));
}

export const fillTeamApi: FillTeamApi = { ask: askColleagues, closeRequest: closeValueRequest, addNote: addFieldNote, removeNote: removeFieldNote };
