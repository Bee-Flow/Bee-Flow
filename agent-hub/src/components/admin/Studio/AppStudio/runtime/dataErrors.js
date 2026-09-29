/**
 * App Studio runtime — how a failed data read is described.
 *
 * A read can now arrive by two roads (one request per binding, or a batch of
 * them), and both must produce the SAME error object, because everything
 * downstream decides on it: react-query's retry rule keys off `status`, the
 * wait length off `retryAfter`, and the connector pre-flight banner off `code`
 * and `provider`. Without one shared shape, "the viewer is over the per-minute
 * budget" and "this query is broken" are the same anonymous Error — which is
 * exactly how a 429 used to become red "could not be loaded" text.
 *
 * Lives in its own module so useAppDataSource and dataBatchClient can both use
 * it without importing each other.
 */

/** An error the rest of the runtime can reason about. */
export function makeDataError({ status, message, retryAfter, code, provider }) {
    const err = new Error(message || 'Data request failed');
    if (Number.isFinite(status)) err.status = status;
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
    if (code) err.code = code;
    if (provider) err.provider = provider;
    return err;
}

/**
 * The same, from an HTTP response.
 *
 * The limiter always sends Retry-After (server/utils/perUserRateLimit.js), so
 * a wait never has to be guessed — but only if someone reads the header, which
 * for a long time nobody did.
 */
export function dataErrorFromResponse(res, body, fallback) {
    const after = Number(res?.headers?.get?.('Retry-After'));
    return makeDataError({
        status: res?.status,
        message: body?.error || `${fallback} (${res?.status})`,
        retryAfter: after,
        code: body?.code,
        provider: body?.provider,
    });
}

/** The viewer is over the read budget — worth waiting out rather than showing. */
export const isRateLimited = (err) => err?.status === 429;
