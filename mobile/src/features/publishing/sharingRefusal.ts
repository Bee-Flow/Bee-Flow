/**
 * Webpage sharing is the Enterprise capability `webpage_sharing` since the
 * enterprise split (2026-10). The server refuses what WIDENS who can see a
 * page (publishing it, a new external link) with the standard licence body,
 * `{ error: 'feature_locked' | 'feature_disabled', feature: 'webpage_sharing' }`,
 * and leaves what exists alone: withdrawing, refreshing and revoking a link
 * still work.
 *
 * The client turns `error` into the ApiError's message, so without this the
 * toast read "feature_locked". This swaps that token for the sentence the web
 * app shows (the same dictionary keys), keeping the status and the body, so
 * describeError still titles it "Not available on your plan".
 */

import { ApiError } from '../../api/client';
import { translate } from '../../i18n';

export const WEBPAGE_SHARING = 'webpage_sharing';

/** The error to throw in place of `err`: a worded licence refusal, or `err` itself. */
export function readableSharingRefusal(err: unknown): unknown {
    if (!(err instanceof ApiError) || err.status !== 403) return err;
    const body = err.body as { error?: unknown; feature?: unknown } | null | undefined;
    if (!body || typeof body !== 'object' || body.feature !== WEBPAGE_SHARING) return err;
    if (body.error === 'feature_disabled') {
        return new ApiError(
            translate(
                'webpages.sharing.locked_not_granted',
                'Sharing webpages is not switched on for your organisation, so ask an admin. Your own pages keep working, and what is already shared stays shared.',
            ),
            { status: err.status, body: err.body },
        );
    }
    if (body.error === 'feature_locked') {
        return new ApiError(
            translate(
                'webpages.sharing.locked_upgrade',
                'Sharing a webpage with others is available on a higher plan. Your own pages keep working, what is already shared stays shared, and you can always stop sharing.',
            ),
            { status: err.status, body: err.body },
        );
    }
    return err;
}

/** Run a sharing request, and word its licence refusal if it gets one. */
export async function sharingRequest<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (err) {
        throw readableSharingRefusal(err);
    }
}
