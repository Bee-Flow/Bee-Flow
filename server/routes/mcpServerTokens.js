/**
 * Self-service tokens for the Bee Flow MCP server (routes/mcpServer.js).
 *
 * Session-authenticated, and scoped to the caller: a user can only mint,
 * inspect or revoke their own token. The token value is shown exactly once, at
 * mint time — only the random half is stored, so there is nothing to show
 * later even to the person who created it.
 *
 * ── What a caller may send: nothing, and that is enforced ────────────────────
 *
 * None of the three routes reads a query or a body. Each one now says so with
 * a `.strict()` schema, because the key somebody adds here is a user id, and
 * it used to fall away without a word while the route acted on the CALLER:
 *
 *   - `DELETE /token?userId=<colleague>` — an admin revoking a leaked token —
 *     revoked the admin's OWN token and answered `{ success: true }`. The
 *     leaked token kept working.
 *   - `POST /token` with `{ "userId": "<colleague>" }` rotated away the
 *     caller's own working token and handed back one that authenticates as
 *     the caller, wherever it is pasted.
 *   - `GET /token?userId=<colleague>` answered `exists` for the caller.
 *
 * Somebody else's token is minted or revoked with
 * `scripts/mint-mcp-token.js --user <id> [--revoke]`, never over HTTP.
 */

const express = require('express');
const configStore = require('../stores/configStore');
const { mintToken, SECRET_KEY } = require('../auth/mcpToken');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const router = express.Router();

const ONLY_YOURS = 'This route acts on your own MCP token only, so it takes no parameters. '
    + 'Another user\'s token is minted or revoked with scripts/mint-mcp-token.js --user <id>.';
/** A query with no keys; the message is the one a caller can act on. */
const NO_QUERY = z.object({}, { errorMap: () => ({ message: ONLY_YOURS }) }).strict(ONLY_YOURS);
/** A body with no keys, which also accepts no body at all (Express 5 leaves `req.body` undefined). */
const NO_BODY = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, { errorMap: () => ({ message: ONLY_YOURS }) }).strict(ONLY_YOURS),
);

function callerId(req) {
    return req.session?.user?.id || null;
}

/** Whether a token exists, and how to point a client at it. Never the value. */
router.get('/token', validate({ query: NO_QUERY }), async (req, res) => {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    // A revoked token leaves a random value behind (see DELETE below), so
    // "a secret exists" is not the same as "the user holds a working token".
    // The revoke marker is what distinguishes them.
    //
    // A failed read is NOT "no token". It used to be caught and answered
    // `200 { exists: false }`, and the app reads that as "No token yet" with a
    // Create button that mints at once — the confirmation that says "this
    // revokes the token your client holds" only appears when `exists` is
    // true. One database blip, one tap, and the working token pasted into
    // Nextcloud was rotated away without a warning. It is a 500 now, which
    // the app shows as a retryable error.
    const stored = await configStore.getSecret(SECRET_KEY(userId));
    const revoked = await configStore.getSecret(`${SECRET_KEY(userId)}_revoked`);
    const exists = !!stored && revoked !== '1';

    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    res.json({
        exists,
        url: base ? `${base}/mcp` : '/mcp',
        transport: 'streamable_http',
        // The exact block to paste into Nextcloud's AI admin settings, under
        // Context Agent → MCP Config.
        nextcloudConfigExample: {
            'bee-flow': {
                url: base ? `${base}/mcp` : 'https://<your-bee-flow-server>/mcp',
                transport: 'streamable_http',
            },
        },
    });
});

/**
 * Mint (or rotate) the caller's token. Rotating immediately invalidates the
 * previous one — there is deliberately no way to hold two, so a leaked token
 * is revoked by minting again.
 */
router.post('/token', validate({ query: NO_QUERY, body: NO_BODY }), async (req, res) => {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { token, random } = mintToken(userId);
    try {
        await configStore.setSecret(SECRET_KEY(userId), random);
        await configStore.setSecret(`${SECRET_KEY(userId)}_revoked`, '0');
    } catch (err) {
        log.error('[MCP server] could not store token:', err.message);
        return res.status(500).json({ error: 'Could not store the token' });
    }
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    res.json({
        token,
        note: 'Copy this now — it is not stored and cannot be shown again. Minting a new token revokes this one.',
        url: base ? `${base}/mcp` : '/mcp',
        transport: 'streamable_http',
    });
});

/**
 * Revoke. configStore has no delete for secrets, so revocation overwrites the
 * stored half with a fresh random value nobody holds — which is equivalent for
 * this purpose (authenticateToken compares against it and can never match) and
 * avoids adding a delete path to a store whose whole surface is write-once.
 */
router.delete('/token', validate({ query: NO_QUERY, body: NO_BODY }), async (req, res) => {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const { random } = mintToken(userId);
        await configStore.setSecret(SECRET_KEY(userId), random);
        await configStore.setSecret(`${SECRET_KEY(userId)}_revoked`, '1');
    } catch (err) {
        log.error('[MCP server] could not revoke token:', err.message);
        return res.status(500).json({ error: 'Could not revoke the token' });
    }
    res.json({ success: true });
});

module.exports = router;
