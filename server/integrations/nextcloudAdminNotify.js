/**
 * Nextcloud notification bell — the PASSIVE half of approval delivery.
 *
 * Say this plainly, because the whole design hangs on it: **no external
 * service can put Approve/Reject buttons in a Nextcloud notification.** The
 * buttons exist in the notification data model (`{label, link, type, primary}`)
 * and every client renders them, but they can only be SET from PHP inside the
 * server via `INotification::addAction()` — verified against
 * notifications/openapi-full.json (the only create routes are
 * `admin_notifications` v1/v2/v3, whose bodies are shortMessage/longMessage or
 * subject/message/*Parameters and carry no `actions` field) and against
 * app_api's ExNotificationsManager::sendNotification, which calls
 * setApp/setUser/setDateTime/setObject/setSubject and never addAction. Even our
 * own ExApp connector cannot do it; a classic PHP app would be required.
 *
 * So the bell is a POINTER, not a control: it says an approval is waiting and
 * carries a deep link into Bee Flow. Interactivity lives in Talk (see
 * nextcloudTalkBot.js). Never describe this channel as "approve from
 * Nextcloud".
 *
 * ── The link problem ───────────────────────────────────────────────────────
 * v3 has no `link` field either (nor `icon`, nor `object_type`/`object_id`).
 * The documented way to make a notification clickable from outside is to put
 * the URL on a RICH OBJECT parameter: the `highlight` type takes `{id, name,
 * link}` and has since Nextcloud 13 (server lib/public/RichObjectStrings/
 * Definitions.php). That is what `subjectParameters.open` below is.
 *
 * ── Versions and rights ────────────────────────────────────────────────────
 *   POST …/api/v3/admin_notifications/{uid}   Nextcloud 30+ (rich objects)
 *   POST …/api/v2/admin_notifications/{uid}   Nextcloud 21+ (plain text)
 *   Both require the CALLER to be a Nextcloud admin — a non-admin gets 403
 *   (or 404 on some builds). That is not a bug to work around: an org whose
 *   Bee Flow identity is not a Nextcloud admin simply cannot use this channel,
 *   and Talk is the fallback. The failure is recorded in the delivery ledger
 *   rather than swallowed.
 */

const NOTIFY_API = '/ocs/v2.php/apps/notifications/api';
/** v2's own caps, and the ones v3 inherits in practice. */
const MAX_SUBJECT = 255;
const MAX_MESSAGE = 4000;

const COMMON_HEADERS = Object.freeze({
    'OCS-APIRequest': 'true',
    'Accept': 'application/json',
});

function clamp(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function explain(status) {
    if (status === 403 || status === 404) {
        return 'Nextcloud refused the notification — admin_notifications requires a Nextcloud admin account.';
    }
    if (status === 400) return 'Nextcloud rejected the notification body (empty or too long).';
    if (status === 503) return 'Nextcloud is in maintenance mode.';
    return `Nextcloud notification failed (HTTP ${status}).`;
}

/**
 * Send one notification to one Nextcloud user.
 *
 * `ncFetch`/`baseUrl` come from nextcloudClient.resolveAuth — whatever
 * identity the caller has. Tries v3 (rich objects, so the deep link is
 * clickable) and falls back to v2 plain text on 404/405, which is what an
 * instance below Nextcloud 30 answers.
 *
 * @returns {{ok:boolean, apiVersion:('v3'|'v2'|null), status:number, error?:string}}
 */
async function sendAdminNotification({ ncFetch, baseUrl, ncUid, subject, message, link = null }) {
    if (typeof ncFetch !== 'function' || !baseUrl || !ncUid) {
        return { ok: false, apiVersion: null, status: 0, error: 'no Nextcloud identity for this organisation' };
    }
    const shortMessage = clamp(subject, MAX_SUBJECT);
    const longMessage = clamp(message, MAX_MESSAGE);
    if (!shortMessage) {
        return { ok: false, apiVersion: null, status: 0, error: 'empty notification subject' };
    }

    // ── v3: rich objects, so the deep link is a clickable pill ───────────
    const v3Body = {
        subject: shortMessage,
        message: longMessage || '',
    };
    if (link) {
        // The placeholder must appear in the string it belongs to, or
        // Nextcloud renders the raw text and drops the parameter.
        v3Body.message = clamp(`${longMessage ? `${longMessage} ` : ''}{open}`, MAX_MESSAGE);
        v3Body.messageParameters = {
            open: { type: 'highlight', id: 'beeflow-approval', name: 'Open in Bee Flow', link },
        };
    }
    try {
        const res = await ncFetch(
            `${baseUrl}${NOTIFY_API}/v3/admin_notifications/${encodeURIComponent(ncUid)}?format=json`,
            {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(v3Body),
            },
        );
        if (res.ok || res.status === 200) return { ok: true, apiVersion: 'v3', status: res.status };
        // 404/405 = this instance has no v3 route (below Nextcloud 30). Any
        // other status is a real refusal and must NOT be retried on v2 — a 403
        // means "not an admin" and v2 would say the same thing twice.
        if (res.status !== 404 && res.status !== 405) {
            return { ok: false, apiVersion: 'v3', status: res.status, error: explain(res.status) };
        }
    } catch (e) {
        return { ok: false, apiVersion: 'v3', status: 0, error: e.message };
    }

    // ── v2: plain text, form-encoded. The link rides in the body text. ───
    try {
        const form = new URLSearchParams();
        form.set('shortMessage', shortMessage);
        form.set('longMessage', clamp(link ? `${longMessage} ${link}` : longMessage, MAX_MESSAGE));
        const res = await ncFetch(
            `${baseUrl}${NOTIFY_API}/v2/admin_notifications/${encodeURIComponent(ncUid)}?format=json`,
            {
                method: 'POST',
                headers: { ...COMMON_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: form.toString(),
            },
        );
        if (res.ok || res.status === 200) return { ok: true, apiVersion: 'v2', status: res.status };
        return { ok: false, apiVersion: 'v2', status: res.status, error: explain(res.status) };
    } catch (e) {
        return { ok: false, apiVersion: 'v2', status: 0, error: e.message };
    }
}

module.exports = { sendAdminNotification, MAX_SUBJECT, MAX_MESSAGE, _notifyTest: { clamp, explain } };
