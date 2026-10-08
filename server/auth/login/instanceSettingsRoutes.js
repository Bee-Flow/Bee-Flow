// @typecheck
/**
 * Login Routes — the installation's own OAuth credentials (Nextcloud client
 * id/secret), read and written by the platform operator only. Split out of
 * auth/loginRoutes.js.
 */

const express = require('express');
const router = express.Router();

const { loadConfig, saveConfig, requireSuperAdmin } = require('../permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const URL_TEXT = 'Enter the Nextcloud URL of this installation.';
const CLIENT_ID_TEXT = 'Enter the OAuth client id of this installation.';
// This is a WHOLE-FORM save, and the handler treats it as one: the two visible
// fields are written unconditionally, so a body carrying only `clientId` blanks
// the Nextcloud URL. Requiring both makes that explicit rather than silent —
// a partial save is now refused instead of quietly erasing the other half.
// `clientSecret` stays optional because blank means "keep the stored one"; it
// is write-only and never read back by GET /settings.
const SettingsBody = z.object({
    nextcloudUrl: worded(URL_TEXT).trim().max(2048, URL_TEXT),
    clientId: worded(CLIENT_ID_TEXT).trim().max(512, CLIENT_ID_TEXT),
    clientSecret: worded('The OAuth client secret must be text.').max(2048, 'That client secret is too long.').optional(),
}).strict();

// Get settings (admin only)
// Instance-wide OAuth credentials — clientId/clientSecret of the whole
// installation, not of one tenant. Previously requireAdmin, which any org
// admin satisfies via `manage_users`: that let a self-registered org admin
// repoint the installation's SSO at their own IdP.
router.get('/settings', requireSuperAdmin, async (req, res) => {
    const config = await loadConfig();
    res.json({
        oauth: {
            nextcloudUrl: config.oauth.nextcloudUrl || '',
            clientId: config.oauth.clientId || '',
            clientSecretSet: !!config.oauth.clientSecret
        }
    });
});

// Save settings (admin only)
router.post('/settings', requireSuperAdmin, validate({ body: SettingsBody }), async (req, res) => {
    const config = await loadConfig();
    const { nextcloudUrl, clientId, clientSecret } = req.body;

    config.oauth.nextcloudUrl = nextcloudUrl;
    config.oauth.clientId = clientId;
    if (clientSecret) {
        config.oauth.clientSecret = clientSecret;
    }

    if (await saveConfig({ oauth: req.body })) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

module.exports = router;
