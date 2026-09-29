/**
 * Shared internals of the /api/support router.
 *
 * PII-safe logging, session/URL helpers, the staff gate shim and the public
 * CSAT landing page. The SSE bus, the staff notifier and the canned-body
 * renderer are re-exported from support/, where they live so that background
 * services can use them without requiring a route.
 */

const supportStore = require('../../stores/supportStore');
const staffAccess = require('../../support/staffAccess');
const log = require('../../telemetry/log');

// ── PII-safe logging helper ──────────────────────────────────────────────
// Email + body content must NEVER appear in container logs verbatim.
// `_redact()` truncates and masks before any console.log/warn/error.
function _redactEmail(addr) {
    if (!addr || typeof addr !== 'string') return '(no-addr)';
    const at = addr.indexOf('@');
    if (at < 1) return addr.slice(0, 3) + '***';
    return addr.slice(0, Math.min(2, at)) + '***@' + addr.slice(at + 1).split('.')[0].slice(0, 1) + '***';
}
function _shortId(id) {
    return (id || '').toString().slice(0, 8);
}

// Collapse a reply body into a single-line excerpt for a notification preview.
function _notifExcerpt(text, max = 500) {
    const s = (text || '').toString().replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getUserId(req) {
    return req.session?.user?.id || req.session?.userId || null;
}

function getUserDisplay(req) {
    const u = req.session?.user;
    if (!u) return null;
    return u.displayName || u.name || u.email || u.username || u.id || null;
}

// Staff gate — shared home (support/staffAccess). Thin shim so the ~30
// call sites keep their name.
async function _hasAdminSupport(req) {
    return staffAccess.hasAdminSupport(req, getUserId(req));
}

// The same gate as middleware, with the same 403 body. A route that also
// validates its request mounts this FIRST, so a schema never answers a
// stranger ahead of the 403 — "your body is wrong" would otherwise tell them
// the endpoint exists.
function requireStaffSupport(req, res, next) {
    _hasAdminSupport(req)
        .then((ok) => (ok ? next() : res.status(403).json({ error: 'admin_support permission required' })))
        .catch(next);
}

const { clientHost: _clientHost, adminSupportTabPath, appRootPath } = require('../../utils/appPaths');

function _buildThreadUrl(thread, { forStaff = false } = {}) {
    const host = _clientHost();
    if (forStaff) return `${host}${adminSupportTabPath(thread.id)}`;
    if (thread.requester_user_id) return `${host}${appRootPath()}?support=${thread.id}`;
    const token = supportStore.buildAccessToken(thread.id, thread.requester_email);
    return `${host}/support/t/${thread.id}?token=${token}`;
}

// Build the public CSAT links (5 star URLs + a dispute URL) for a thread.
// The API base is the server's own public host (where these routes live).
function _buildCsatLinks(thread) {
    const apiBase = `${process.env.API_PROTOCOL || 'https'}://${process.env.API_PUBLIC_HOST || process.env.SERVER_PUBLIC_HOST || 'server.beeflow.nl'}`;
    const base = `${apiBase}/api/support/csat/${thread.id}`;
    const stars = [1, 2, 3, 4, 5].map(score => {
        const token = supportStore.buildCsatToken(thread.id, thread.requester_email, score);
        return `${base}?score=${score}&token=${token}`;
    });
    const disputeToken = supportStore.buildCsatToken(thread.id, thread.requester_email, 0);
    const dispute = `${base}?dispute=1&token=${disputeToken}`;
    return { stars, dispute };
}

// ── Canned-response variable substitution ────────────────────────────────
// One-pass, plaintext, known keys only. A value coming from a thread field
// (e.g. a subject containing "{{x}}") is treated as literal text — it never
// triggers a second substitution pass, so it can't inject new placeholders.
// Minimal self-contained HTML page for the public CSAT landing.
function _csatHtml({ score, disputed, error } = {}) {
    let heading, body;
    if (error) { heading = 'Hmm'; body = error; }
    else if (disputed) { heading = 'Thanks for letting us know'; body = 'We\'ve reopened your request and a team member will follow up shortly.'; }
    else { heading = 'Thank you!'; body = `We\'ve recorded your rating${score ? ` of ${score}/5` : ''}. We appreciate your feedback.`; }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bee Flow Support</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;max-width:420px;text-align:center}
h1{font-size:22px;margin:0 0 12px;color:#0f172a}p{color:#475569;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${heading}</h1><p>${body}</p></div></body></html>`;
}

// ── SSE event bus for the staff inbox ─────────────────────────────────────
// The bus itself lives in support/events so background services can emit
// without requiring a route module. Same single instance, re-exported here.
const { supportEvents } = require('../../support/events');
// Both moved out of this file: four background services need them and must
// not require a route module. See support/notifications.js.
const { notifyStaff, renderCannedBody } = require('../../support/notifications');

const { emit: _emit } = require('../../support/events');

function _logListenerPressure() {
    // Warn (not crash) when the bus approaches the configured cap. Half-closed
    // SSE sockets can otherwise pile up listeners silently — node would only
    // emit a MaxListenersExceededWarning once at the threshold.
    const n = supportEvents.listenerCount('event');
    if (n > 30) {
        log.warn(`[Support] SSE listener pressure: ${n} active subscribers (cap 50)`);
    }
}

// ── Staff notify ─────────────────────────────────────────────────────────
// Notifies all super admins (role === 'admin') via in-app notification.
// configStore key `support_notify_emails` may carry extra cc emails if
// staff want a personal copy outside the in-app channel.

// ──────────────────────────────────────────────────────────────────────────
// Acting org for staff-managed catalogues (tags, canned responses, SLA).
// Super-admins manage system-wide entries (org = null). Org-scoped support
// staff manage entries for their own org only.
// ──────────────────────────────────────────────────────────────────────────
async function _actingOrgId(req) {
    return staffAccess.actingOrgId(req);
}

module.exports = {
    _redactEmail,
    _shortId,
    _notifExcerpt,
    getUserId,
    getUserDisplay,
    _hasAdminSupport,
    requireStaffSupport,
    _buildThreadUrl,
    _buildCsatLinks,
    renderCannedBody,
    _csatHtml,
    supportEvents,
    _emit,
    _logListenerPressure,
    notifyStaff,
    _actingOrgId,
};
