// @typecheck
/**
 * Admin Routes — Nextcloud app-password management for the caller's own
 * account. Split out of auth/adminRoutes.js; mounted there in the original
 * registration order.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { loadConfig, requireAuth } = require('../permissions');
const { assertAllowedNextcloudHost, nextcloudFetch, MAX_URL_LENGTH: NEXTCLOUD_MAX_URL_LENGTH } = require('../../integrations/nextcloudTarget');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CREDENTIALS_TEXT = 'Username and password are required';
// `url` is optional — blank leaves resolution to the org-wide config — but the
// KEY is now closed. A mis-spelled `url` used to answer 200 while the app
// password was filed against the organisation's Nextcloud instead of the host
// the person named, and nothing on screen said so.
const SaveAppPasswordBody = z.object({
    username: worded(CREDENTIALS_TEXT).min(1, CREDENTIALS_TEXT).max(200, 'That username is too long.'),
    password: worded(CREDENTIALS_TEXT).min(1, CREDENTIALS_TEXT).max(512, 'That app password is too long.'),
    url: worded('A Nextcloud URL must be text.').trim().max(NEXTCLOUD_MAX_URL_LENGTH, 'That Nextcloud URL is too long.').optional(),
}).strict();

// === App Password Management ===

// Normalise a user-supplied Nextcloud base URL: default to https://, drop the
// query/hash and any trailing slashes so it concatenates cleanly with the
// OCS/WebDAV paths the integration appends. The pathname is KEPT — Nextcloud
// subpath installs (https://example.com/nextcloud) are common.
//
// Returns null for blank input, or { error } when the value is unusable —
// either unparseable or refused by the SSRF target policy (see
// integrations/nextcloudTarget.js). Callers surface `error` verbatim; it names
// the env flag a self-hoster needs for a LAN address.
function normalizeNextcloudUrl(raw) {
    if (!raw || !String(raw).trim()) return null;
    let value = String(raw).trim();
    if (value.length > NEXTCLOUD_MAX_URL_LENGTH) {
        return { error: 'That Nextcloud URL is too long.' };
    }
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        return { error: 'Enter a valid Nextcloud URL (e.g. https://cloud.example.com)' };
    }
    if (!parsed.hostname) return { error: 'Enter a valid Nextcloud URL (e.g. https://cloud.example.com)' };
    const normalized = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    try {
        assertAllowedNextcloudHost(normalized);
    } catch (e) {
        return { error: e.message };
    }
    return normalized;
}

// session.accessToken is a SHARED slot: Google/Microsoft SSO and the Google
// Workspace connector write to it too. Deciding "this is a Nextcloud session"
// from token presence alone made the UI offer Nextcloud's auto-create flow to
// Google-connected users — which POSTs their GOOGLE token as a Bearer to the
// org's Nextcloud host. The provider tag is the only safe discriminator.
function isNextcloudOAuthSession(req) {
    return req.session?.oauthProvider === 'nextcloud' && !!req.session?.accessToken;
}

router.get('/app-password-status', requireAuth, async (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) {
        return res.json({ hasAppPassword: false, isNextcloudUser: false, nextcloudUrl: '' });
    }

    const appPasswordData = await userStore.getAppPassword(userId);
    res.json({
        hasAppPassword: !!appPasswordData,
        isNextcloudUser: isNextcloudOAuthSession(req),
        nextcloudUrl: appPasswordData?.url || ''
    });
});

router.post('/create-app-password', requireAuth, async (req, res) => {
    const accessToken = req.session.accessToken;
    const userId = req.session.user?.id;

    if (!accessToken || !userId) {
        return res.status(401).json({ error: 'Not authenticated with Nextcloud' });
    }
    // Never forward a non-Nextcloud OAuth token to the Nextcloud host.
    if (!isNextcloudOAuthSession(req)) {
        return res.status(400).json({
            error: 'This is not a Nextcloud sign-in session. Generate an app password in Nextcloud (Settings → Security) and save it below.',
            code: 'not_a_nextcloud_session',
        });
    }

    const config = await loadConfig();
    const nextcloudUrl = config.oauth?.nextcloudUrl;

    if (!nextcloudUrl) {
        return res.status(400).json({ error: 'Nextcloud URL not configured' });
    }

    // Nextcloud uid for WebDAV Basic auth — falls back to id, then displayName
    const nextcloudUsername = req.session.user?.id || req.session.user?.['display-name'] || userId;

    // Correct OCS endpoint per Nextcloud docs: /core/getapppassword (not /core/apppassword)
    // https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html
    // Note: app passwords minted with a Bearer token inherit the OAuth access-token TTL
    // (~10 min). For persistent WebDAV access the user should paste a manually-generated
    // app password via /save-app-password instead.
    const response = await nextcloudFetch(`${nextcloudUrl}/ocs/v2.php/core/getapppassword`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'OCS-APIRequest': 'true',
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        log.warn(`[Nextcloud] getapppassword failed (${response.status})`);
        return res.status(response.status === 403 ? 403 : 502).json({
            error: response.status === 403
                ? 'Already authenticated with an app password — generate a new one in Nextcloud Settings → Security.'
                : 'Failed to create app password from Nextcloud'
        });
    }

    const data = /** @type {{ ocs?: { data?: { apppassword?: string } } }} */ (await response.json());
    const appPassword = data.ocs?.data?.apppassword;

    if (!appPassword) {
        return res.status(502).json({ error: 'No app password returned by Nextcloud' });
    }

    await userStore.storeAppPassword(userId, nextcloudUsername, appPassword);
    res.json({
        success: true,
        message: 'App password created',
        warning: 'App passwords minted via OAuth inherit the access-token lifetime. For persistent WebDAV access, generate one manually in Nextcloud (Settings → Security) and save it via the password form.'
    });
});

router.post('/save-app-password', requireAuth, validate({ body: SaveAppPasswordBody }), async (req, res) => {
    const { username, password, url } = req.body;

    // url is optional — blank leaves resolution to the org-wide config.
    const nextcloudUrl = normalizeNextcloudUrl(url);
    if (nextcloudUrl && /** @type {{error?: string}} */ (nextcloudUrl).error) {
        return res.status(400).json({ error: /** @type {{error: string}} */ (nextcloudUrl).error });
    }

    const userId = req.session.user?.id;
    await userStore.storeAppPassword(userId, username, password, nextcloudUrl);
    res.json({ success: true, message: 'App password saved securely' });
});

router.delete('/app-password', requireAuth, async (req, res) => {
    const userId = req.session.user?.id;
    await userStore.deleteAppPassword(userId);
    res.json({ success: true });
});

module.exports = router;
