/**
 * Webhook receiver for NC events forwarded by the Bee Flow connector.
 *
 * The connector subscribes to OCP\User and OCP\Group events via NC's
 * AppAPI events_listener. NC posts to the connector at /webhook/nc-events;
 * the connector signs the payload with the tenant key and forwards here.
 *
 * Auth model:
 *   X-Beeflow-NC-Instance-Id  identifies the org via nc_instance_id.
 *   X-Beeflow-Sig             HMAC-SHA256(tenantKey, ts || method || url || body)
 *                             prefixed with `<unixSeconds>.`
 *   ±5min skew allowed; constant-time compare; tenant-key lookup is
 *   per-org so a leaked key only impersonates that org's connector.
 *   The check itself is auth/connectorSig.js, the one copy every connector
 *   route shares. This route asks it to refuse a REPLAY too: a signature
 *   already accepted inside its window is a 401, so a captured
 *   `user.deleted` cannot be played again against an account the admin
 *   re-created. Rate-limited per IP ahead of the body parser, at the same
 *   ceiling as the connector's /api/automation/events/* pushes.
 *
 * ── The body, after the signature ────────────────────────────────────
 *
 * The signature is checked FIRST, so an unsigned caller learns nothing about
 * the schema: it gets the same 401 whatever it sent. Only then is the body
 * held to the one shape the connector has ever sent
 * (nextcloud-connector/src/eventsWebhook.js): `{ event, ncUid, groupId }`.
 *
 * `event` is a closed vocabulary — the connector maps Nextcloud's event
 * classes onto exactly five names, and ignores the rest on ITS side. An
 * unknown name here therefore means connector and server disagree, and it
 * used to be answered `200 { ignored }`: a `user.deleted` spelled any other
 * way left the account active, and the connector, which only logs a non-2xx,
 * logged nothing. It is a 400 now, which the connector's log shows.
 *
 * `ncUid` is text. `!ncUid` let any truthy value through, so an array or an
 * object reached the sync, which compares it to `users.nc_uid` in SQL — a
 * deletion that matched nobody and answered `{ ok: true, action: 'noop' }`.
 *
 * The query string has no schema: nothing reads it, and it is part of the
 * signed URL, so nobody without the tenant key can add one.
 */

const express = require('express');
const router = express.Router();

const { verifyConnectorSig } = require('../../auth/connectorSig');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const sync = require('../../services/ncUserGroupSync');
const { badRequest } = require('../../core/http/errors');
const { z, onUnknownKeys, typeError } = require('../../utils/zod');

const EVENTS = ['user.created', 'user.updated', 'user.deleted', 'group.member_added', 'group.member_removed'];
const EVENT_TEXT = `event is one of ${EVENTS.join(', ')}.`;
const UID_TEXT = 'ncUid is the Nextcloud user id, as text.';
const GROUP_TEXT = 'groupId is the Nextcloud group id, as text.';
const BODY_TEXT = 'A Nextcloud event is a JSON object with event, ncUid and groupId.';

const NcEvent = z.object({
    event: z.enum(EVENTS, { error: () => EVENT_TEXT }),
    ncUid: z.string({ error: UID_TEXT }).min(1, UID_TEXT),
    // null for a user event. The sync re-reads the user's groups from
    // Nextcloud rather than trusting this, so it is only held to its type.
    groupId: z.string({ error: typeError({ invalid: GROUP_TEXT }) }).nullish(),
}, { error: onUnknownKeys(BODY_TEXT, typeError({ required: BODY_TEXT, invalid: BODY_TEXT })) }).strict();

// We need the raw body bytes for HMAC verification, but downstream wants
// the parsed JSON. express.json() with verify hook captures both.
const captureRaw = express.json({
    limit: '256kb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

// Same env knob and ceiling as the /api/automation/events/* limiter
// (routes/automation/events.js): the connector forwards both from one IP.
// Registered before the body parser so a flood does not pay the JSON parse.
// A sync event lost to a 429 is picked up by jobs/ncSyncBackstop.js.
const NC_USER_SYNC_RPM_PER_IP = parseInt(process.env.AUTOMATION_EVENTS_RPM_PER_IP, 10) || 600;
const userSyncLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: NC_USER_SYNC_RPM_PER_IP,
    keyFn: (req) => `ncsync:${req.ip || 'unknown'}`,
});

/**
 * The body, held to NcEvent with the 400 core/http/validate.js gives
 * (`invalid_request`, each issue pathed `body.<field>`). It is parsed here,
 * after the signature, not by `validate()` in the chain: in front of the handler
 * it would answer an unsigned caller's body with a 400 describing the schema,
 * and splitting the signature check out into a middleware of its own makes it an
 * untagged gate under /auth, which auth/accessRegistry.drift.test.js refuses.
 */
function readEvent(body) {
    const parsed = NcEvent.safeParse(body);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.map((i) => ({ path: ['body', ...i.path].join('.'), message: i.message }));
    throw badRequest('invalid_request', issues[0].message, issues);
}

router.post('/webhook/nc-user-sync', userSyncLimiter, captureRaw, async (req, res) => {
    const org = await verifyConnectorSig(req, { rejectReplay: true });
    if (!org) return res.status(401).json({ error: 'Invalid or missing signature' });

    const { event, ncUid, groupId } = readEvent(req.body);

    let result;
    switch (event) {
        case 'user.created':
        case 'user.updated':
            result = await sync.applyUserCreated(org, ncUid);
            break;
        case 'user.deleted':
            result = await sync.applyUserDeleted(org, ncUid);
            break;
        case 'group.member_added':
        case 'group.member_removed':
            result = await sync.applyGroupMemberChange(org, ncUid, groupId);
            break;
    }
    return res.json({ ok: true, ...result });
});

module.exports = router;
