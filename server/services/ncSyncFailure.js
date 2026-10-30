// @typecheck strict
/**
 * How a failed Nextcloud read of the user/group sync is recorded on org
 * health: which code it opens and what the row may say about it.
 *
 * Three codes, because the backstop (jobs/ncSyncBackstop.js) backs off
 * differently on them and the admin UI words them differently: a 401 means
 * the connector refuses our signature (the tenant keys diverged) and a 404
 * means AppAPI answers for a disabled or uninstalled app. Neither heals by
 * retrying. Everything else is a transient failure of the connection. A
 * successful sync, manual or scheduled, resolves all three.
 */

const NC_SYNC_FAILED = 'connector.nc_sync_failed';
const APP_REMOVED = 'connector.app_removed';
const KEY_DIVERGENCE = 'connector.key_divergence';

// Configuration gaps the message names; matched, never echoed.
/** @type {Array<[RegExp, string]>} */
const NAMED_REASONS = [
    [/has no tenant key/, 'no_tenant_key'],
    [/has no connector_callback_url/, 'no_callback_url'],
];

/**
 * What an org-health row may say about a failed NC read. Built from an
 * allow-list of classified fields rather than from the error message: the
 * message names the proxy path, and a later change to ncProxyFetch could put
 * the callback URL (or worse) in it without anyone looking here.
 *
 * @param {Error & { status?: unknown, cause?: { code?: unknown } }} err
 * @returns {{ stage: string, reason: string, httpStatus?: number, errorCode?: string }}
 */
function summarizeSyncError(err) {
    const e = /** @type {Partial<Error & { status?: unknown, cause?: { code?: unknown } }>} */ (err && typeof err === 'object' ? err : {});
    const summary = { stage: 'list_users', reason: 'error' };
    const status = httpStatusOf(e);
    if (status !== null) return { ...summary, reason: `http_${status}`, httpStatus: status };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ...summary, reason: 'timeout' };
    const message = String(e.message || '');
    const named = NAMED_REASONS.find(([re]) => re.test(message));
    if (named) return { ...summary, reason: named[1] };
    if (message !== 'fetch failed') return summary;
    const errorCode = errorCodeOf(e);
    return errorCode ? { ...summary, reason: 'unreachable', errorCode } : { ...summary, reason: 'unreachable' };
}

/** @param {{ status?: unknown }} e */
function httpStatusOf(e) {
    const status = Number(e.status);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/** @param {{ cause?: { code?: unknown } }} e */
function errorCodeOf(e) {
    const code = e.cause && e.cause.code;
    return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

/**
 * The health code and sanitised meta for a failed read.
 * @param {Error & { status?: unknown, cause?: { code?: unknown } }} err
 */
function classifySyncFailure(err) {
    const meta = summarizeSyncError(err);
    const code = meta.reason === 'http_401' ? KEY_DIVERGENCE
        : meta.reason === 'http_404' ? APP_REMOVED
            : NC_SYNC_FAILED;
    return { code, meta };
}

module.exports = { summarizeSyncError, classifySyncFailure, NC_SYNC_FAILED, APP_REMOVED, KEY_DIVERGENCE };
