// The request plumbing the automation query modules share: one error class
// that carries the server's machine code, and the GET / PUT of one routine's
// JSON that throws it.
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// callers render a failure as a sentence, and the tests mock `authFetch`.

import { API_BASE, authFetch } from '../../../utils/helpers';

/** A refused request, with the server's error code (`ai_act.domain_required`, `remind_rate_limited`, …). */
export class AutomationRequestError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The error for a failed response: the server's `error` and `code` when it sent them, `fallback` otherwise. */
async function failure(res: Response, fallback: string): Promise<AutomationRequestError> {
    let message = fallback;
    let code: string | null = null;
    try {
        const body: unknown = await res.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
            const { error, code: sent } = body as Record<string, unknown>;
            message = nonEmpty(error) ?? message;
            code = nonEmpty(sent);
        }
    } catch { /* not JSON */ }
    return new AutomationRequestError(message, res.status, code);
}

const routineUrl = (id: string, tail: string) => `${API_BASE}/api/automation/${encodeURIComponent(id)}${tail}`;

/** GET /api/automation/:id<tail>; a refusal throws, with `what` naming the call when the server says nothing. */
export async function getRoutineJson(id: string, tail: string, what: string, signal?: AbortSignal): Promise<unknown> {
    const res = await authFetch(routineUrl(id, tail), { signal });
    if (!res.ok) throw await failure(res, `${what} ${res.status}`);
    return res.json();
}

/** PUT a JSON body to /api/automation/:id<tail>, the same way. */
export async function putRoutineJson(id: string, tail: string, body: unknown, what: string): Promise<unknown> {
    const res = await authFetch(routineUrl(id, tail), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw await failure(res, `${what} ${res.status}`);
    return res.json();
}
