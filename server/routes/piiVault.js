/**
 * The user's own tokenization vault.
 *
 * ── There is no admin path to this data, deliberately ───────────────────────
 *
 * Every route here is scoped to `req.session.user.id` and takes no user id
 * parameter, so there is no query that can be pointed at somebody else. The
 * vault is the reverse dictionary for that user's Privacy Shield: an org admin
 * who could read it would be able to de-anonymise every redaction the shield
 * ever made for them, which would make the feature theatre. If support needs
 * to help someone with their vault, they walk them through this screen.
 *
 * Reads are audited. Listing your own PII is legitimate and routine, but it is
 * still the one endpoint that returns raw PII in bulk, so it leaves a trail.
 *
 * ── What a caller may send ───────────────────────────────────────────────────
 *
 * Every query and body below is `.strict()`, and on this router that is not
 * tidiness. The list read `limit`, `offset` and `search` one by one and let
 * anything else fall away, and the two deletes read nothing at all:
 *
 *   - `DELETE /?id=<entry>` — the one-entry delete with its id in the wrong
 *     place — EMPTIED THE WHOLE VAULT under `{ ok: true, removed: N }`. Every
 *     placeholder in every stored message lost its restoration, for good.
 *   - `GET /?serach=jan` answered with the entire decrypted vault, audited as a
 *     bulk read, to someone who had asked for the entries matching one name.
 *   - `?limit=-5` passed `parseInt(…) || 200` (−5 is truthy) and reached the
 *     store as a negative LIMIT: a 500 instead of a sentence.
 *
 * A search longer than 200 characters used to be cut to 200 without a word, so
 * the vault answered a question nobody asked; it is refused now.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const { requireAuth } = require('../auth/permissions');
const vault = require('../stores/piiVaultStore');
const userStore = require('../stores/userStore');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A whole number on the query string, refused in words when it is not one. */
const whole = (name, min, what) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`)
    .min(min, `${name} must be ${what}.`)
    .optional();

const ListQuery = z.object({
    // Above 500 is still answered with 500, and the response says so in its
    // own `limit` — a ceiling the caller can read is not a silent fallback.
    limit: whole('limit', 1, 'at least 1'),
    offset: whole('offset', 0, 'zero or more'),
    search: worded('search must be text.').max(200, 'A vault search is at most 200 characters.').optional(),
}).strict();

/** Nothing. Said rather than left out: an ignored key on a delete is a promise. */
const NO_QUERY = z.object({}).strict();
/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const NO_BODY = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

const RATE = new Map(); // userId → { count, windowStart }
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

/**
 * Bulk PII retrieval deserves a ceiling even for its rightful owner: a stolen
 * session should not be able to walk the whole vault in a tight loop.
 */
function rateLimited(userId) {
    const now = Date.now();
    const hit = RATE.get(userId);
    if (!hit || now - hit.windowStart > RATE_WINDOW_MS) {
        RATE.set(userId, { count: 1, windowStart: now });
        return false;
    }
    hit.count++;
    return hit.count > RATE_MAX;
}

function audit(req, action, meta = {}) {
    try {
        const userId = req.session.user.id;
        userStore.logAccessAudit(action, 'pii_vault', userId, userId, null, meta, req.session.user.organizationId || null);
    } catch (_) { /* auditing must never fail the request */ }
}

/** GET / — the caller's vault, decrypted. */
router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    const userId = req.session.user.id;
    if (rateLimited(userId)) return res.status(429).json({ error: 'Too many requests' });

    try {
        const limit = Math.min(req.query.limit ?? 200, 500);
        const offset = req.query.offset ?? 0;
        const search = req.query.search ?? '';

        const { entries, total } = await vault.listForUser(userId, {
            search, limit, offset,
            orgId: req.session.user.organizationId || undefined,
        });
        audit(req, 'pii_vault.read', { returned: entries.length, total });
        res.json({ entries, total, limit, offset, maxEntries: vault.MAX_ENTRIES_PER_USER });
    } catch (err) {
        log.error('[PiiVault] list failed:', err.message);
        res.status(500).json({ error: 'Could not load your vault' });
    }
});

/**
 * DELETE /:id — forget one value.
 *
 * Not reversible, and not only a UI concern: any stored message still carrying
 * this token loses its restoration, so the placeholder becomes permanent. The
 * client confirms with that wording before calling.
 */
router.delete('/:id', requireAuth, validate({ query: NO_QUERY, body: NO_BODY }), async (req, res) => {
    const userId = req.session.user.id;
    try {
        const ok = await vault.deleteEntry(userId, req.params.id);
        if (!ok) return res.status(404).json({ error: 'Entry not found' });
        audit(req, 'pii_vault.delete', { entryId: req.params.id });
        res.json({ ok: true });
    } catch (err) {
        log.error('[PiiVault] delete failed:', err.message);
        res.status(500).json({ error: 'Could not delete that entry' });
    }
});

/**
 * DELETE / — empty the vault. Same caveat as above, for every entry at once.
 *
 * Takes NOTHING, and says so: this is the route a misplaced `?id=` used to land
 * on, and "delete one" must never be able to arrive here as "delete all".
 */
router.delete('/', requireAuth, validate({ query: NO_QUERY, body: NO_BODY }), async (req, res) => {
    const userId = req.session.user.id;
    try {
        const removed = await vault.clearForUser(userId);
        audit(req, 'pii_vault.clear', { removed });
        res.json({ ok: true, removed });
    } catch (err) {
        log.error('[PiiVault] clear failed:', err.message);
        res.status(500).json({ error: 'Could not clear your vault' });
    }
});

module.exports = router;
