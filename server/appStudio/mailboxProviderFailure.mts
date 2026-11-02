/**
 * What a mail provider's refusal tells the person opening an attachment.
 *
 * The raw error carries the provider's own JSON (request ids, inner errors)
 * and the provider's OWN status: a Graph 400 is a request we built wrong, not
 * the viewer's bad request, and neither belongs on screen. The read layer's
 * own refusals (413 too large, 415 not a file) carry no provider fields and
 * pass through untouched.
 *
 * `expose` marks a message written for the viewer, so the route may show it
 * on a 5xx where it otherwise answers with a generic sentence.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log') as { warn: (...args: unknown[]) => void };

type ProviderError = Error & {
    status?: number;
    graphCode?: string | null;
    response?: { status?: number };
};

export type ExposedError = Error & { status: number; code: string; expose: true };

type Failure = readonly [status: number, message: string, code: string];

const ACCESS_DENIED: Failure = [502, 'The mailbox refused access to this attachment. Reconnect the mailbox and try again.', 'mailbox_access_denied'];
const PROVIDER_FAILURES: Record<string, Failure> = {
    404: [404, 'That attachment is no longer in the mailbox', 'attachment_gone'],
    401: ACCESS_DENIED,
    403: ACCESS_DENIED,
    429: [503, 'The mail provider is busy. Try again in a minute.', 'provider_throttled'],
    default: [502, 'The mail provider could not deliver this attachment.', 'provider_error'],
};

/**
 * The provider's status for a provider error: 401 for a token that cannot be
 * refreshed (providerClients says "reconnect the mailbox"), 0 when it gave
 * none, null when the error is our own.
 */
function providerStatus(err: ProviderError | null | undefined): number | null {
    if (!err) return null;
    if (/reconnect the mailbox/i.test(String(err.message || ''))) return 401;
    // graphFetchFromTokens always sets graphCode (null when unparseable);
    // a googleapis error always carries its response.
    if (!('graphCode' in err) && !err.response) return null;
    return Number(err.status ?? err.response?.status) || 0;
}

/** The error to throw in place of `err`: a viewer-facing one, or `err` itself when it is ours. */
export function providerFailure(err: unknown, provider: string): unknown {
    const e = err as ProviderError | null | undefined;
    const status = providerStatus(e);
    if (status === null) return err;
    log.warn(`[mailboxAttachments] ${provider} refused an attachment read: ${status || 'no status'} ${e?.graphCode || ''}`.trim());
    const [httpStatus, message, code] = PROVIDER_FAILURES[status] || PROVIDER_FAILURES.default;
    return Object.assign(new Error(message), { status: httpStatus, code, expose: true }) as ExposedError;
}

/** The JSON body of a failed materialize: the viewer-facing message when there is one, else generic on a 5xx. */
export function materializeErrorBody(err: unknown, status: number): { error: string; code?: string } {
    const e = err as Partial<ExposedError> | null | undefined;
    if (e?.expose) return { error: String(e.message), ...(e.code ? { code: e.code } : {}) };
    return { error: status >= 500 ? 'Failed to open attachment' : String(e?.message ?? '') };
}
