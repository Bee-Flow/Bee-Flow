/**
 * NC Login Mini — minimal ExApp.
 *
 * Proves NC AppAPI auto-login works: user clicks the icon in the top bar,
 * lands on a page that says "Hi <their NC name>" with zero login screens.
 *
 * AppAPI auth: NC sends `AUTHORIZATION-APP-API: base64(<userId>:<APP_SECRET>)`
 * on every USER-level request. We verify the shared secret and look up the
 * user's display name via OCS. No tenant keys, no SaaS, no JWT minting.
 */

const express = require('express');
const { verifyAppApiAuth, escapeHtml, frameAncestors } = require('./appApiAuth');

const APP_ID = process.env.APP_ID || 'nc_login_mini';
const APP_VERSION = process.env.APP_VERSION || '0.1.0';
const APP_SECRET = process.env.APP_SECRET || '';
const NEXTCLOUD_URL = (process.env.NEXTCLOUD_URL || '').replace(/\/+$/, '');
const APP_PORT = Number(process.env.APP_PORT || 23000);
const APP_HOST = process.env.APP_HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Allow NC to iframe us. Without this header NC's default response CSP wins
// and the browser blocks rendering with "frame-ancestors 'none'".
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors(NEXTCLOUD_URL, req.headers).join(' ')}`);
    next();
});

const userCache = new Map();
async function fetchUser(uid) {
    const cached = userCache.get(uid);
    if (cached && cached.expiresAt > Date.now()) return cached.user;
    const url = `${NEXTCLOUD_URL}/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`;
    const res = await fetch(url, {
        headers: {
            'OCS-APIRequest': 'true',
            'EX-APP-ID': APP_ID,
            'EX-APP-VERSION': APP_VERSION,
            'AUTHORIZATION-APP-API': Buffer.from(`${uid}:${APP_SECRET}`).toString('base64'),
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OCS HTTP ${res.status}`);
    const body = await res.json();
    const d = body?.ocs?.data || {};
    const user = {
        uid: d.id || uid,
        displayName: d.displayname || d.display_name || uid,
        email: d.email || null,
        groups: Array.isArray(d.groups) ? d.groups : [],
        enabled: d.enabled !== false,
    };
    userCache.set(uid, { user, expiresAt: Date.now() + 60_000 });
    return user;
}

// Lifecycle endpoints — unauthenticated, called by NC AppAPI itself.
app.get('/heartbeat', (_req, res) => res.json({ status: 'ok' }));
function appApiHeaders() {
    return {
        'Content-Type': 'application/json',
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
        'EX-APP-ID': APP_ID,
        'EX-APP-VERSION': APP_VERSION,
        'AUTHORIZATION-APP-API': Buffer.from(`:${APP_SECRET}`).toString('base64'),
    };
}

async function registerTopMenu() {
    const r = await fetch(`${NEXTCLOUD_URL}/ocs/v1.php/apps/app_api/api/v1/ui/top-menu`, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ name: 'main', displayName: 'NC Login Mini', icon: 'img/app.svg', adminRequired: 0 }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok && r.status !== 409) throw new Error(`top-menu HTTP ${r.status}`);
    console.log('[init] top-menu registered');
}

async function registerEmbedScript() {
    const r = await fetch(`${NEXTCLOUD_URL}/ocs/v1.php/apps/app_api/api/v1/ui/script`, {
        method: 'POST',
        headers: appApiHeaders(),
        body: JSON.stringify({ type: 'top_menu', name: 'main', path: 'js/embed', afterAppId: '' }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok && r.status !== 409) throw new Error(`embed script HTTP ${r.status}`);
    console.log('[init] embed script registered');
}

app.post('/init', (_req, res) => {
    res.status(200).json({});
    setImmediate(async () => {
        try { await registerTopMenu(); } catch (e) { console.warn('[init] top-menu failed:', e.message); }
        try { await registerEmbedScript(); } catch (e) { console.warn('[init] embed script failed:', e.message); }
    });
});
app.put('/enabled', (_req, res) => res.json({}));

app.get('/img/app.svg', (_req, res) => {
    res.type('image/svg+xml').send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">' +
        '<circle cx="12" cy="8" r="4"/>' +
        '<path d="M12 14c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6z"/>' +
        '</svg>'
    );
});

// The actual user-facing page. NC AppAPI has already authenticated and
// passes the userId in AUTHORIZATION-APP-API; we verify the shared secret,
// fetch the user's profile via OCS, render a simple "Hi <name>" page.
app.get('/', async (req, res) => {
    const auth = verifyAppApiAuth(req.headers['authorization-app-api'], APP_SECRET);
    if (auth.reason === 'auth') {
        return res.status(401).type('html').send('<h1>401 — AppAPI auth missing or invalid</h1>');
    }
    if (!auth.ok) {
        return res.status(401).type('html').send('<h1>401 — no NC user in request</h1>');
    }
    let user;
    try {
        user = await fetchUser(auth.userId);
    } catch (e) {
        return res.status(502).type('html').send(`<h1>OCS lookup failed</h1><pre>${escapeHtml(e.message)}</pre>`);
    }
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>NC Login Mini</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:4em auto;padding:0 1em;color:#1f2937}
h1{font-size:2em;margin-bottom:.2em}
pre{background:#f3f4f6;padding:1em;border-radius:6px;overflow:auto;font-size:.85em}
.tag{display:inline-block;background:#e0f2fe;color:#0369a1;padding:.15em .6em;border-radius:999px;font-size:.85em;margin-right:.3em}
</style></head><body>
<h1>👋 Hi ${escapeHtml(user.displayName)}!</h1>
<p>You're logged in as <code>${escapeHtml(user.uid)}</code> — no separate sign-in needed.</p>
${user.email ? `<p>Email: <code>${escapeHtml(user.email)}</code></p>` : ''}
${user.groups.length ? `<p>Groups: ${user.groups.map(g => `<span class="tag">${escapeHtml(g)}</span>`).join('')}</p>` : '<p>Groups: <em>none</em></p>'}
<details><summary>Raw user data</summary><pre>${escapeHtml(JSON.stringify(user, null, 2))}</pre></details>
<hr style="margin-top:2em;border:0;border-top:1px solid #e5e7eb">
<p style="color:#6b7280;font-size:.85em">If you can see your name above, NC AppAPI auto-login works. ✅</p>
</body></html>`);
});

// Embed script injected by NC into the top-menu page. Renders an iframe
// pointing at the signed proxy back to us so this page loads inside the NC
// chrome instead of standalone.
app.get(['/js/embed', '/js/embed.js'], (_req, res) => {
    res.type('application/javascript').send(`
(function() {
    var content = document.getElementById('content');
    if (!content) return;
    content.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = OC.generateUrl('/apps/app_api/proxy/${APP_ID}/');
    iframe.style.cssText = 'width:100%;height:calc(100vh - 50px);border:0;display:block;';
    content.appendChild(iframe);
})();
`);
});

app.listen(APP_PORT, APP_HOST, () => {
    console.log(`nc_login_mini v${APP_VERSION} listening on ${APP_HOST}:${APP_PORT}`);
    console.log(`NC: ${NEXTCLOUD_URL || '(NEXTCLOUD_URL not set!)'}`);
});
