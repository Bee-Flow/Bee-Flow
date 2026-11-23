/**
 * Filling in a document from a template together, in a project: who filled
 * in which field, and requests to a colleague for the fields only they know.
 *
 * Both live in the document's settings, next to the values themselves
 * (settings.sampleValues), so they are saved in the same write as the value
 * that answers them and travel with the document:
 *
 *   settings.valueRequests = [{ id, fields: [key], assigneeId, requestedBy,
 *                               message, createdAt, doneAt?, cancelledAt? }]
 *   settings.filledBy      = { <key>: { userId, at, via? } }   via 'ai': stored by the
 *                            assistant for that person, in the chat
 *
 * A request is DONE when every field it asks for has a value; whoever filled
 * the last one does not matter (a colleague may answer for the assignee). The
 * caller tells the requester (notifications are not this module's job: it is
 * pure, so the rules have plain tests).
 */

export type Settings = Record<string, unknown>;

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

export type FilledBy = Record<string, { userId: string, at: string, via?: 'ai' }>;
/** Who saved, when, and whether the assistant stored it for them. */
export type Filler = { userId: string, now: string, via?: 'ai' };

/** At most this many open requests on one document, and fields per request. */
export const MAX_OPEN_REQUESTS = 50;
export const MAX_REQUEST_FIELDS = 100;
export const MAX_MESSAGE = 500;

const isObject = (v: unknown): v is Settings => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** The requests a document keeps, read defensively. */
export function requestsOf(settings: unknown): ValueRequest[] {
    const raw = isObject(settings) ? settings.valueRequests : null;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is ValueRequest => isObject(r) && typeof r.id === 'string' && typeof r.assigneeId === 'string'
        && Array.isArray(r.fields));
}

/** Who filled in which field, read defensively. */
export function filledByOf(settings: unknown): FilledBy {
    const raw = isObject(settings) ? settings.filledBy : null;
    return isObject(raw) ? raw as FilledBy : {};
}

export const isOpen = (r: ValueRequest): boolean => !r.doneAt && !r.cancelledAt;

/** The settings with a new request; refuses a request for no field, an unknown field or too many open ones. */
export function addRequest(settings: Settings, input: {
    id: string, fields: string[], assigneeId: string, requestedBy: string, message?: string, now: string, knownKeys: string[],
}): Settings {
    const fields = [...new Set(input.fields)].filter((k) => input.knownKeys.includes(k));
    if (fields.length === 0) throw Object.assign(new Error('Pick at least one field of this document to ask about.'), { status: 422, errorClass: 'value_request_no_fields' });
    if (fields.length > MAX_REQUEST_FIELDS) throw Object.assign(new Error(`A request asks about at most ${MAX_REQUEST_FIELDS} fields.`), { status: 422, errorClass: 'value_request_too_many' });
    const requests = requestsOf(settings);
    if (requests.filter(isOpen).length >= MAX_OPEN_REQUESTS) {
        throw Object.assign(new Error(`This document already has ${MAX_OPEN_REQUESTS} open requests. Close some first.`), { status: 422, errorClass: 'value_request_limit' });
    }
    const request: ValueRequest = {
        id: input.id, fields, assigneeId: input.assigneeId, requestedBy: input.requestedBy,
        message: String(input.message || '').trim().slice(0, MAX_MESSAGE), createdAt: input.now,
    };
    return { ...settings, valueRequests: [...requests, request] };
}

/** The settings with a request cancelled; only the requester (or the assignee, declining) may. */
export function cancelRequest(settings: Settings, requestId: string, userId: string, now: string): { settings: Settings, request: ValueRequest | null } {
    const requests = requestsOf(settings);
    const found = requests.find((r) => r.id === requestId) || null;
    if (!found || !isOpen(found)) return { settings, request: null };
    if (found.requestedBy !== userId && found.assigneeId !== userId) {
        throw Object.assign(new Error('Only who asked, or who was asked, can close this request.'), { status: 403, errorClass: 'value_request_not_yours' });
    }
    const cancelled = { ...found, cancelledAt: now };
    return { settings: { ...settings, valueRequests: requests.map((r) => (r.id === requestId ? cancelled : r)) }, request: cancelled };
}

/**
 * The settings after `who` saved `changedKeys`: who filled them in, and the
 * open requests whose fields now all have a value marked done (returned, for
 * the caller to tell the requester).
 */
export function recordFilled(settings: Settings, values: Settings, changedKeys: string[], who: Filler): { settings: Settings, completed: ValueRequest[] } {
    const filledBy = { ...filledByOf(settings) };
    for (const key of changedKeys) {
        if (isEmpty(values[key])) delete filledBy[key];
        else filledBy[key] = { userId: who.userId, at: who.now, ...(who.via ? { via: who.via } : {}) };
    }
    const completed: ValueRequest[] = [];
    const requests = requestsOf(settings).map((r) => {
        if (!isOpen(r) || !r.fields.every((k) => !isEmpty(values[k]))) return r;
        const done = { ...r, doneAt: who.now };
        completed.push(done);
        return done;
    });
    const next: Settings = { ...settings, filledBy };
    if (requests.length) next.valueRequests = requests;
    return { settings: next, completed };
}
