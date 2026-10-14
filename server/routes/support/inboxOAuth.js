/**
 * Tenant Support Inbox: the dedicated per-mailbox OAuth connect (NOT the
 * login OAuth), and the platform Service Email connect that reuses its
 * registered redirect URI. Split out of routes/supportInbox.js; behaviour
 * unchanged.
 */

const crypto = require('crypto');
const log = require('../../telemetry/log');
const supportInboxStore = require('../../stores/supportInboxStore');
const audit = require('../../support/audit');
const providerClients = require('../../services/email/providerClients');
const { resolveOrgScope, loadInboxInScope } = require('./inboxScope');

/**
 * Build the OAuth callback URL. Mirrors the login flow (server/auth/oauthRoutes.js):
 * prefer the explicit SERVER_PUBLIC_HOST/SERVER_PROTOCOL (set in every deploy,
 * incl. local where it is localhost:3001), then the proxy's X-Forwarded-Host,
 * then the Referer origin, and only finally the bare Host header — which behind
 * the agent-hub nginx is `localhost` WITHOUT the port (that produced the broken
 * `http://localhost/...:80` redirect that 404'd). The resolved value is stashed
 * in the session at /oauth/start and reused verbatim at /oauth/callback so the
 * two redirect_uri values Google compares are always identical.
 */
function redirectUriFor(req) {
    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || req.protocol || 'https';
    if (!host) {
        host = req.get('X-Forwarded-Host') || null;
        if (!host) {
            const ref = req.get('Referer');
            if (ref) { try { const u = new URL(ref); host = u.host; protocol = u.protocol.replace(':', ''); } catch { /* ignore */ } }
        }
        if (!host) host = req.get('host');
    }
    return `${protocol}://${host}/api/support-inbox/oauth/callback`;
}

function _oauthClosePage(ok, message) {
    const payload = JSON.stringify({ type: 'support-mailbox-oauth', ok, message: message || '' });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Mailbox connected</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#0f172a">
<p>${ok ? 'Mailbox connected. You can close this window.' : `Connection failed: ${String(message || '').slice(0, 200)}`}</p>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(payload)},'*');}catch(e){}setTimeout(function(){window.close();},800);</script>
</body></html>`;
}

function _serviceEmailClosePage(ok, message) {
    const payload = JSON.stringify({ type: 'service-email-oauth', ok, message: message || '' });
    return `<!doctype html><html><head><meta charset="utf-8"><title>Service email connected</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#0f172a">
<p>${ok ? 'Service email connected. You can close this window.' : `Connection failed: ${String(message || '').slice(0, 200)}`}</p>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(payload)},'*');}catch(e){}setTimeout(function(){window.close();},800);</script>
</body></html>`;
}

/**
 * Handle the OAuth callback for the platform Service Email (Gmail API) connect.
 * This reuses the registered support-inbox redirect URI; the start route
 * (server/routes/ai/config.js, admin-gated) set req.session.serviceEmailConnect,
 * so holding a matching state is the proof this was an admin-initiated connect.
 */
async function _handleServiceEmailCallback(req, res) {
    const sess = req.session.serviceEmailConnect;
    try {
        const { code, state, error } = req.query;
        if (error) return res.status(400).send(_serviceEmailClosePage(false, String(error)));
        if (!sess || !state || state !== sess.state) {
            return res.status(400).send(_serviceEmailClosePage(false, 'Invalid or expired connect session'));
        }
        const emailService = require('../../utils/emailService');
        const { address } = await emailService.completeOAuthConnect({
            code, redirectUri: sess.redirectUri || redirectUriFor(req),
        });
        delete req.session.serviceEmailConnect;
        await new Promise((r) => req.session.save(() => r()));
        res.send(_serviceEmailClosePage(true, address));
    } catch (err) {
        log.error('[ServiceEmail] oauth/callback error:', err.message);
        delete req.session.serviceEmailConnect;
        res.status(500).send(_serviceEmailClosePage(false, err.message));
    }
}

async function oauthStart(req, res) {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = redirectUriFor(req);
    req.session.supportMailbox = {
        state, inboxId: inbox.id, orgId: inbox.organization_id, provider: inbox.provider, ts: Date.now(), redirectUri,
    };
    const url = await providerClients.buildAuthUrl(inbox.provider, { redirectUri, state });
    await new Promise((r) => req.session.save(() => r()));
    res.json({ url });
}

async function oauthCallback(req, res) {
    // Dispatch: the platform Service Email connect reuses this registered
    // redirect URI. Route to it only when the returned state matches the
    // service-email connect session, so a lingering support-mailbox connect in
    // the same session is never mis-handled.
    if (req.session?.serviceEmailConnect && req.query.state === req.session.serviceEmailConnect.state) {
        return _handleServiceEmailCallback(req, res);
    }
    const sess = req.session?.supportMailbox;
    try {
        const { code, state, error } = req.query;
        if (error) return res.status(400).send(_oauthClosePage(false, String(error)));
        if (!sess || !state || state !== sess.state) {
            return res.status(400).send(_oauthClosePage(false, 'Invalid or expired connect session'));
        }
        // Re-validate the inbox is still in scope for this user.
        const scope = await resolveOrgScope(req);
        if (!scope.includes(sess.orgId)) {
            return res.status(403).send(_oauthClosePage(false, 'Organization not in scope'));
        }
        const { tokens, emailAddress } = await providerClients.exchangeCode(sess.provider, {
            code, redirectUri: sess.redirectUri || redirectUriFor(req),
        });
        await supportInboxStore.updateTokens(sess.inboxId, tokens, { emailAddress });
        audit.emit(req, { organizationId: sess.orgId, inboxId: sess.inboxId, action: 'inbox_connected', payload: { provider: sess.provider, emailAddress: emailAddress || null } });
        delete req.session.supportMailbox;
        await new Promise((r) => req.session.save(() => r()));
        res.send(_oauthClosePage(true));
    } catch (err) {
        log.error('[SupportInbox] oauth/callback error:', err.message);
        res.status(500).send(_oauthClosePage(false, err.message));
    }
}

module.exports = { oauthStart, oauthCallback };
