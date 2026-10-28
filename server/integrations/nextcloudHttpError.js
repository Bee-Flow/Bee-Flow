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
 *   5xx  a short generic line; the body is never echoed (a Tables 500 once
 *        leaked raw SQL and the table prefix)
 *   other 4xx  the status plus Nextcloud's reason
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
 * @param {{status:number, text:()=>Promise<string>}} res
 * @param {{authError:string, what:string, app?:string}} opts
 *   what: the thing that was attempted ("team lookup"); app: the Nextcloud app
 *   name, used when a 404 carries no reason and the app itself may be missing.
 * @returns {Promise<{error:string}>}
 */
async function nextcloudHttpError(res, { authError, what, app }) {
    const status = res.status;
    if (status === 401) return { error: authError };
    if (status === 502 || status === 503 || status === 504) {
        return { error: `Nextcloud could not be reached or is temporarily unavailable (${status}) during ${what}. Try again shortly.` };
    }
    if (status >= 500) {
        return { error: `Nextcloud ${what} failed (${status}): the Nextcloud server reported an internal error. Check the Nextcloud log.` };
    }
    const rawBody = await res.text().catch(() => '');
    const reason = extractReason(rawBody);
    if (status === 403) {
        // The AppAPI/HaRP signature check fails with a 403 too: that one IS the connector.
        if (/\b997\b|AppAPI authentication failed/i.test(`${reason} ${rawBody.slice(0, 500)}`)) return { error: authError };
        return { error: `Permission denied for ${what}${reason ? `: ${reason}` : ' (this account may not do this)'}.` };
    }
    if (status === 404) {
        if (reason) return { error: `Not found for ${what}: ${reason}` };
        return { error: `Not found for ${what}: the id may be wrong${app ? `, or the "${app}" app is not installed or enabled` : ''}.` };
    }
    return { error: `Nextcloud ${what} failed (${status})${reason ? `: ${reason}` : ''}` };
}

module.exports = { nextcloudHttpError, extractReason };
