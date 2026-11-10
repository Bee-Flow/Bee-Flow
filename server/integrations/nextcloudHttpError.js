// @typecheck strict
/**
 * One mapping from a failed Nextcloud HTTP answer to a tool error.
 *
 * Without this, Teams and Forms would send every 401 AND 403 to the connector
 * message ("could not reach Nextcloud"), and every 404 to "app not
 * installed", so a plain permission error or a wrong id would look like an
 * outage. Here:
 *   401  the connector or session itself -> `authError` (the caller's text)
 *   403  permission denied, with Nextcloud's own reason when it gives one
 *   404  not found; names the missing app only when no reason came back
 *   503  maintenance mode when Nextcloud says so (its header, or the Sabre
 *        maintenance body); otherwise "temporarily unavailable"
 *   5xx  a short generic line; the body is never echoed (a Tables 500 once
 *        leaked raw SQL and the table prefix)
 *   other 4xx  the status plus Nextcloud's reason
 *
 * An answer that did not come from Nextcloud at all (the error page of a proxy
 * or CDN in front of it) is worded as such: statuses 520 to 527, or an HTML
 * 403/413 that carries the proxy's own marker. That check runs AFTER the
 * AppAPI signature check, so a connector auth failure keeps its own message.
 */

const { bestEffort } = require('../utils/bestEffort');

const MAX_DETAIL = 200;

/**
 * Control characters out, whitespace collapsed, cut to a fixed length.
 * @param {string} text
 */
function clean(text) {
    return String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
}

/** @type {Record<string, string>} */
const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

/**
 * The five basic XML entities (a Sabre message is XML text).
 * @param {string} text
 */
function decodeXml(text) {
    return text.replace(/&(lt|gt|quot|apos|amp);/g, (m) => XML_ENTITIES[m]);
}

/**
 * Nextcloud's own reason out of a response body: `ocs.meta.message`, a plain
 * `message`, or the Sabre `<s:message>` of a WebDAV error. Never returns raw
 * JSON, HTML or a stack: when nothing readable is there, returns ''.
 * @param {string} bodyText
 * @returns {string}
 */
function extractReason(bodyText) {
    const text = String(bodyText || '').trim();
    if (!text) return '';
    try {
        const json = JSON.parse(text);
        const msg = json?.ocs?.meta?.message || json?.ocs?.data?.message || json?.message;
        return typeof msg === 'string' && msg.toUpperCase() !== 'OK' ? clean(msg) : '';
    } catch (e) {
        bestEffort('integrations/nextcloudHttpError:extractReason', e); // [nextcloudHttpError] body is not JSON, trying the XML shape:
    }
    const sabre = text.match(/<s:message>([^<]*)<\/s:message>/i);
    return sabre ? clean(decodeXml(sabre[1])) : '';
}

/**
 * What this module reads of a response. `headers` is optional: several callers
 * and tests pass a bare `{ status, text }`.
 * @typedef {{ status: number, text: () => Promise<string>, headers?: { get?: (name: string) => string | null } | null }} NcErrorResponse
 */

/**
 * One response header, '' when the response carries none.
 * @param {{ headers?: { get?: (name: string) => string | null } | null }} res
 * @param {string} name
 */
function headerOf(res, name) {
    const headers = res && res.headers;
    if (!headers || typeof headers.get !== 'function') return '';
    const value = headers.get(name);
    return typeof value === 'string' ? value : '';
}

/**
 * Nextcloud marks every answer it gives in maintenance mode with this header
 * (OCS and index.php); WebDAV says it in the Sabre body instead.
 * @param {{ headers?: { get?: (name: string) => string | null } | null }} res
 */
function hasMaintenanceHeader(res) {
    return headerOf(res, 'x-nextcloud-maintenance-mode') === '1';
}

const MAINTENANCE_BODY_RE = /maintenance mode|upgrade needed/i;

/**
 * @param {string} what
 */
function maintenanceMessage(what) {
    return `Nextcloud is in maintenance mode (503) during ${what}. Try again when the maintenance or upgrade is finished.`;
}

/**
 * Statuses only a proxy or CDN in front of Nextcloud sends (its origin did not answer).
 * @param {number} status
 */
function isProxyOnlyStatus(status) {
    return status >= 520 && status <= 527;
}

const HTML_PAGE_RE = /^\s*<(!doctype html|html[\s>])/i;

/**
 * An HTML error page that carries the proxy's own marker, in a header or in
 * the page. Nextcloud answers its APIs in JSON or XML; a page that names
 * Nextcloud is taken for Nextcloud's own and keeps the wording it had.
 * @param {{ headers?: { get?: (name: string) => string | null } | null }} res
 * @param {string} rawBody
 */
function isProxyPage(res, rawBody) {
    const head = String(rawBody || '').slice(0, 4000);
    const contentType = headerOf(res, 'content-type');
    if (!HTML_PAGE_RE.test(head) && !/text\/html/i.test(contentType)) return false;
    if (/nextcloud/i.test(head)) return false;
    return !!headerOf(res, 'cf-ray') || /cloudflare/i.test(headerOf(res, 'server')) || /cloudflare|cf-ray/i.test(head);
}

/**
 * @param {number} status
 * @param {string} what
 */
function proxyMessage(status, what) {
    const lead = `A proxy in front of Nextcloud answered instead of Nextcloud (${status}) during ${what}`;
    if (status === 403) return `${lead}: it blocked the request (a firewall or bot rule). Ask the Nextcloud admin to let the Bee Flow calls through.`;
    if (status === 413) return `${lead}: the upload is larger than the proxy accepts.`;
    return `${lead}: the proxy got no answer from Nextcloud. Check that Nextcloud is up and reachable from the proxy.`;
}

/**
 * The message for a failed download, from the status and headers alone (the
 * body of a download answer is not read here).
 * @param {{ status: number, headers?: { get?: (name: string) => string | null } | null }} res
 * @returns {string}
 */
function downloadFailureMessage(res) {
    const status = res.status;
    if (status === 503 && hasMaintenanceHeader(res)) return maintenanceMessage('download');
    if (isProxyOnlyStatus(status)) return proxyMessage(status, 'download');
    if ((status === 403 || status === 413) && isProxyPage(res, '')) return proxyMessage(status, 'download');
    return `Nextcloud download failed (${status})`;
}

/**
 * A 5xx answer: maintenance, unavailable, a proxy's own status, or an internal error.
 * @param {NcErrorResponse} res
 * @param {string} what
 * @returns {Promise<{error:string}>}
 */
async function serverSideError(res, what) {
    const status = res.status;
    if (status === 503) {
        const maintenance = hasMaintenanceHeader(res) || MAINTENANCE_BODY_RE.test(await res.text().catch(() => ''));
        if (maintenance) return { error: maintenanceMessage(what) };
    }
    if (status === 502 || status === 503 || status === 504) {
        return { error: `Nextcloud could not be reached or is temporarily unavailable (${status}) during ${what}. Try again shortly.` };
    }
    if (isProxyOnlyStatus(status)) return { error: proxyMessage(status, what) };
    return { error: `Nextcloud ${what} failed (${status}): the Nextcloud server reported an internal error. Check the Nextcloud log.` };
}

/**
 * @param {NcErrorResponse} res
 * @param {{authError:string, what:string, app?:string}} opts
 *   what: the thing that was attempted ("team lookup"); app: the Nextcloud app
 *   name, used when a 404 carries no reason and the app itself may be missing.
 * @returns {Promise<{error:string}>}
 */
async function nextcloudHttpError(res, { authError, what, app }) {
    const status = res.status;
    if (status === 401) return { error: authError };
    if (status >= 500) return serverSideError(res, what);
    const rawBody = await res.text().catch(() => '');
    const reason = extractReason(rawBody);
    if (status === 403) {
        // The AppAPI/HaRP signature check fails with a 403 too: that one IS the connector.
        if (/\b997\b|AppAPI authentication failed/i.test(`${reason} ${rawBody.slice(0, 500)}`)) return { error: authError };
        if (isProxyPage(res, rawBody)) return { error: proxyMessage(status, what) };
        return { error: `Permission denied for ${what}${reason ? `: ${reason}` : ' (this account may not do this)'}.` };
    }
    if (status === 404) {
        if (reason) return { error: `Not found for ${what}: ${reason}` };
        return { error: `Not found for ${what}: the id may be wrong${app ? `, or the "${app}" app is not installed or enabled` : ''}.` };
    }
    if (status === 413 && isProxyPage(res, rawBody)) return { error: proxyMessage(status, what) };
    return { error: `Nextcloud ${what} failed (${status})${reason ? `: ${reason}` : ''}` };
}

module.exports = { nextcloudHttpError, extractReason, hasMaintenanceHeader, downloadFailureMessage };
