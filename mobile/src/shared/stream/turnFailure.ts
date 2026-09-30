/**
 * How a turn that failed OUTSIDE the stream reads: the one wording every
 * stream surface starts from (TurnRunner's default; agents add their 403).
 *
 * A turn fails this way for two reasons, and neither is a sentence the
 * platform should write for us:
 *
 *   - the API refused before the first frame. describeError knows the
 *     refusals: a 402 is a plan limit, a 5xx is "not something you did" —
 *     never "HTTP 502" or the body's "Internal server error";
 *   - the transport let go: the idle watchdog in core/api/sse aborting a
 *     silent socket ("The operation was aborted."), expo/fetch's
 *     "fetch failed: …", a reset connection. Whatever the platform called
 *     it, what happened is that the connection was lost.
 *
 * A refusal the server sends IN the stream (`error` frames) is not this: it
 * carries the server's own sentence and is folded by the adapter.
 */

import { ApiError, OfflineError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { translate } from '@/core/i18n';

/** The client's placeholder for a body with no sentence — a category, not words. */
const STATUS_ONLY = /^HTTP \d{3}$/;

export function describeTurnFailure(err: unknown): string {
    if (err instanceof ApiError || err instanceof OfflineError) {
        const { title, message } = describeError(err);
        return message && !STATUS_ONLY.test(message) ? message : title;
    }
    return translate('mobile.chat.connection_lost', 'The connection to the server was lost.');
}
