/**
 * Organisation policy for keeping integration answers BETWEEN runs.
 *
 * One switch, one duration and two scope ticks. Off by default, and off for a
 * reason worth stating on the screen: turning it on means this organisation's
 * third-party response payloads — a Gmail search result is somebody's mail —
 * are stored in the database, encrypted, until they expire. That is a
 * processing decision, so it belongs to an org admin and leaves a config row
 * recording that they made it.
 *
 * The two ticks (`scopes.integration`, `scopes.http`) live inside the SAME key
 * because they answer the same question — may third-party response payloads be
 * stored at rest here — and two keys would let an org sit half-on with nobody
 * able to see which half. But an admin who consented to "what an app answers"
 * did not consent to arbitrary outbound HTTP, so the widening needs its own
 * tick rather than a reworded screen.
 *
 * Switching it OFF also purges what is already stored. An "off" that left rows
 * behind would not be what anyone reads it as, and the count is returned so the
 * admin can see what actually went. SHORTENING the window reaches the stored
 * rows too — `expires_at` is stamped at write time, so without that the rows
 * already in the table keep the window the admin just replaced.
 *
 * Storage + resolution: core/automationRunner/integrationCachePolicy.js
 * (configStore key `org_integration_cache_<orgId>`). This route only reads and
 * writes that row, and asks the store for a count.
 */

'use strict';

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const configStore = require('../stores/configStore');
const { resolveUserOrgIds } = require('../auth');
const { requireAuth, isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');
const {
    normalizePolicy,
    invalidateCachePolicy,
    killSwitchOn,
    CONFIG_KEY_PREFIX,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
} = require('../core/automationRunner/integrationCachePolicy');
const integrationCacheStore = require('../stores/integrationCacheStore');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// `.strict()`, `enabled` REQUIRED, every tick a real boolean. On this route a
// body the handler did not understand was never a no-op — it was an OFF, and
// an OFF PURGES:
//
//   - `enabled: "true"` (a form, a script, a stale client) read as not-true,
//     so the save switched the cache OFF and deleted every stored answer of
//     the organisation, answering 200 with `purged: N`;
//   - so did a body that misspelled or left out `enabled`;
//   - `scopes.integration: "false"` read as not-false, so an admin switching
//     app look-ups off left them ON.
//
// "Only a literal true turns it on" is kept, and made stronger: anything that
// is not a boolean now changes nothing at all, instead of writing an OFF.
// `ttlSeconds` stays CLAMPED (normalizePolicy owns the range; see
// orgIntegrationCache.test.js); a value that is not a number is refused rather
// than replaced by the default.

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the setting as a JSON object.' }).strict(),
);

const ENABLED_TEXT = 'Say whether answers may be kept: enabled is true or false.';
const tick = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` }).optional();

const PolicyBody = bodyOf({
    enabled: z.boolean({ required_error: ENABLED_TEXT, invalid_type_error: ENABLED_TEXT }),
    ttlSeconds: z.number({ invalid_type_error: 'ttlSeconds is a number of seconds.' }).optional(),
    scopes: z.object({
        integration: tick('scopes.integration'),
        http: tick('scopes.http'),
    }, { invalid_type_error: 'scopes is { integration, http }, each true or false.' }).strict().optional(),
});

/**
 * The purge forgets EVERYTHING the organisation has stored. It takes no
 * options, so one it would ignore — `{ integration: 'gmail' }` — is refused
 * rather than read as "all of it".
 */
const NoBody = bodyOf({});

function envelope(policy, extra = {}) {
    return {
        ...policy,
        // An operator can switch the whole feature off for the box. Say so,
        // rather than showing a toggle that silently does nothing.
        killSwitch: killSwitchOn(),
        ttlRange: { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS },
        ...extra,
    };
}

// GET /:orgId — current policy (any member of the org may read it)
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        const stored = await configStore.getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
        const stats = await integrationCacheStore.statsForOrg(orgId);
        res.json(envelope(normalizePolicy(stored), {
            // Lets the screen distinguish "never configured" from "explicitly off".
            configured: !!stored,
            entries: stats.entries,
            // Expired-but-not-yet-pruned rows are still ROWS. The prune runs
            // hourly, so reporting only live entries told an org it held
            // nothing while thousands sat in the table between passes.
            expiredEntries: stats.expiredEntries,
            bytes: stats.bytes,
        }));
    } catch (err) {
        log.error('[OrgIntegrationCache] GET failed:', err.message);
        res.status(500).json({ error: 'Failed to load the setting' });
    }
});

// PUT /:orgId — save (org admin or super admin only)
router.put('/:orgId', requireAuth, validate({ body: PolicyBody }), async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can change this setting' });
        }

        const { enabled, ttlSeconds, scopes } = req.body;
        // normalizePolicy clamps and resolves the default of an absent field,
        // so a hand-rolled body can never write an unusable row. `scopes`
        // decides WHICH outbound answers the consent covers (app look-ups /
        // outbound HTTP); normalizeScopes only ever reads a literal true as a
        // yes for http.
        const policy = normalizePolicy({ enabled, ttlSeconds, scopes });

        await configStore.setConfig(`${CONFIG_KEY_PREFIX}${orgId}`, {
            ...policy,
            updatedAt: new Date().toISOString(),
            updatedBy: req.session?.user?.id || null,
        });
        invalidateCachePolicy(orgId);

        // Turning it off is also an instruction to forget.
        let purged = 0;
        if (!policy.enabled) purged = await integrationCacheStore.purgeForOrg(orgId);

        // A SHORTER window has to reach the rows already stored. expires_at is
        // stamped at write time, so lowering it from 60 minutes to 5 used to
        // change nothing for another 59 — the admin doing that has just seen
        // stale data and means now. Only ever shortens, so it is a no-op when
        // the window is widened or unchanged.
        let shrunk = 0;
        if (policy.enabled) shrunk = await integrationCacheStore.shrinkTtlForOrg(orgId, policy.ttlSeconds);

        log.info(`[OrgIntegrationCache] org ${orgId}: ${policy.enabled ? 'ENABLED' : 'disabled'}`
            + ` (ttl ${policy.ttlSeconds}s, scopes app=${policy.scopes.integration} http=${policy.scopes.http}`
            + `${purged ? `, purged ${purged} entries` : ''}`
            + `${shrunk ? `, shortened ${shrunk} stored entries` : ''})`);

        const stats = await integrationCacheStore.statsForOrg(orgId);
        res.json(envelope(policy, {
            configured: true,
            entries: stats.entries,
            expiredEntries: stats.expiredEntries,
            bytes: stats.bytes,
            purged,
            shrunk,
        }));
    } catch (err) {
        log.error('[OrgIntegrationCache] PUT failed:', err.message);
        res.status(500).json({ error: 'Failed to save the setting' });
    }
});

// DELETE /:orgId/entries — forget everything cached, without changing the policy.
// The button an admin wants after a data-correction incident: the answers on
// hand are wrong, and waiting out the TTL is not an answer.
router.delete('/:orgId/entries', requireAuth, validate({ body: NoBody }), async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can clear this' });
        }
        const purged = await integrationCacheStore.purgeForOrg(orgId);
        res.json({ purged });
    } catch (err) {
        log.error('[OrgIntegrationCache] purge failed:', err.message);
        res.status(500).json({ error: 'Failed to clear the stored answers' });
    }
});

module.exports = router;
