/**
 * GitHub Integration Routes — PAT-based
 *
 * Minimal routes for token management (status, disconnect).
 * No OAuth flow needed — users paste their PAT in Settings.
 *
 * /status and /disconnect read nothing but the session, so neither carries
 * a schema.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const configStore = require('../../stores/configStore');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// One key, and it is a credential. `!token?.trim()` guards a missing token
// but not a token of the wrong TYPE: optional chaining stops at null and
// undefined, so `{ token: 12345 }` reached `.trim()` on a number and threw a
// TypeError outside the try — a bare 500 where the caller had simply sent
// the wrong JSON type. `.strict()` closes the other half: `{ tokn: 'ghp_…' }`
// was answered "Token is required", which names the key the route wanted
// rather than the one it got.
const TOKEN_TEXT = 'A GitHub personal access token is required.';
const ConnectBody = z.object({
    token: z.string({ required_error: TOKEN_TEXT, invalid_type_error: TOKEN_TEXT }).trim().min(1, TOKEN_TEXT),
}).strict();

// The session gate stays AHEAD of the schema: an unauthenticated caller must
// still read 401, not a 400 about its body.
const requireSessionUser = (req, res, next) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    next();
};

// ─── Connection Status ───────────────────────────────────────────
router.get('/status', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const hasToken = !!(await configStore.getSecret(`github_token_user_${userId}`));
    const username = await configStore.getConfig(`github_username_user_${userId}`);

    res.json({
        connected: hasToken,
        username: hasToken ? username : null,
    });
});

// ─── Save Token ──────────────────────────────────────────────────
router.post('/connect', requireSessionUser, validate({ body: ConnectBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { token } = req.body;

    try {
        // Validate token by fetching user profile
        const userRes = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(10000),
        });

        if (!userRes.ok) {
            return res.status(400).json({ error: 'Invalid GitHub token. Please check and try again.' });
        }

        const userData = await userRes.json();
        const username = userData.login;

        // Store token and username
        await configStore.setSecret(`github_token_user_${userId}`, token);
        await configStore.setConfig(`github_username_user_${userId}`, username);

        log.info(`[GitHub] Connected for user ${userId} (${username})`);
        res.json({ success: true, username });
    } catch (err) {
        log.error('[GitHub] Connect error:', err.message);
        res.status(500).json({ error: 'Failed to validate GitHub token' });
    }
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await configStore.deleteConfig(`github_token_user_${userId}`);
    await configStore.deleteConfig(`github_username_user_${userId}`);

    log.info(`[GitHub] Disconnected for user ${userId}`);
    res.json({ success: true });
});

module.exports = router;
