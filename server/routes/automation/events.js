// §WS5 #4 — public inbound trigger surface (webhook + provider event pushes),
// extracted verbatim from routes/automation.js. Mounted BEFORE the auth chain.
//
// EVERY BODY HERE STAYS OPEN, and that is the point of the file. None of them
// is ours: `/webhook/:slug` carries whatever the caller's system sends and is
// handed to the run as `triggerPayload`; the four provider routes carry
// Google's, Nextcloud's, Microsoft's and GitHub's own envelopes, which they
// version on their own schedule. Two of them are also SIGNED over the exact
// bytes received, so a schema that stripped or reordered a key would break
// the HMAC that proves the delivery is genuine. The narrowing that belongs
// here is the signature check and the rate limit, both below — not a shape.
const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const configStore = require('../../stores/configStore');
const triggerBus = require('../../automation/triggerBus');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');

// ── PUBLIC routes (defined first; auth comes after) ────

// Rate limits for the unauthenticated trigger surface. Limiters are registered
// BEFORE the body-parsing middleware so floods don't pay the JSON-parse cost.
// In-memory sliding windows (perUserRateLimit) — fine single-instance; `trust
// proxy` is configured in index.js so req.ip is the real client IP.
const AUTOMATION_WEBHOOK_RPM_PER_SLUG = parseInt(process.env.AUTOMATION_WEBHOOK_RPM_PER_SLUG, 10) || 120;
const AUTOMATION_WEBHOOK_RPM_PER_IP = parseInt(process.env.AUTOMATION_WEBHOOK_RPM_PER_IP, 10) || 300;
const AUTOMATION_EVENTS_RPM_PER_IP = parseInt(process.env.AUTOMATION_EVENTS_RPM_PER_IP, 10) || 600;

const webhookSlugLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: AUTOMATION_WEBHOOK_RPM_PER_SLUG,
    keyFn: (req) => `whslug:${req.params.slug}`,
});
const webhookIpLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: AUTOMATION_WEBHOOK_RPM_PER_IP,
    keyFn: (req) => `whip:${req.ip || 'unknown'}`,
});
// Shared across the /events/* provider push endpoints. 600/min/IP is
// deliberately generous: MS Graph's validationToken handshake must never 429
// (Graph drops the subscription if it does), and providers publish from small
// shared IP pools where one busy tenant would otherwise starve the rest.
const eventsLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: AUTOMATION_EVENTS_RPM_PER_IP,
    keyFn: (req) => `evt:${req.ip || 'unknown'}`,
});

/**
 * Allowlisted, size-capped copy of an inbound webhook's request headers,
 * exposed to the run as `trigger.headers.<name>` (A14).
 *
 * - Allowlist: content-type, user-agent, and x-* EXCEPT the BeeFlow auth pair
 *   (signature/nonce must never leak into run state or run history).
 * - Keys are normalised to lowercase snake_case (`content-type` →
 *   `content_type`): bind.js's dotted-path grammar rejects `-`, so the
 *   canonical binding is `trigger.headers.content_type`.
 * - Total serialized size is capped (~8KB) — headers are metadata, not a data
 *   channel.
 */
function pickWebhookHeaders(req) {
    const MAX_TOTAL = 8 * 1024;
    const out = {};
    let total = 0;
    for (const [rawKey, rawVal] of Object.entries(req.headers || {})) {
        const key = String(rawKey).toLowerCase();
        if (key === 'x-beeflow-signature' || key === 'x-beeflow-nonce') continue;
        if (key !== 'content-type' && key !== 'user-agent' && !key.startsWith('x-')) continue;
        const val = Array.isArray(rawVal) ? rawVal.join(', ') : String(rawVal ?? '');
        total += key.length + val.length;
        if (total > MAX_TOTAL) break;
        out[key.replace(/-/g, '_')] = val;
    }
    return out;
}

// Webhook trigger — signed inbound URL.
router.post('/webhook/:slug', webhookIpLimiter, webhookSlugLimiter, express.json({ limit: '256kb' }), async (req, res) => {
    const slug = req.params.slug;
    const wh = await automationStore.getWebhook(slug);
    if (!wh) return res.status(404).json({ error: 'Unknown webhook' });

    const sigHeader = req.get('X-BeeFlow-Signature') || '';
    const nonce = req.get('X-BeeFlow-Nonce') || '';
    if (!sigHeader.startsWith('sha256=') || !nonce) return res.status(401).json({ error: 'Missing signature or nonce' });
    // The nonce must be part of the signed message, not just checked
    // separately — otherwise a captured (nonce, signature, body) triple
    // lets an attacker replay the same body with a NEW nonce (the
    // signature still verifies, since it never covered the nonce) and
    // checkAndStoreNonce sees it as fresh.
    const expected = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(`${nonce}\n${JSON.stringify(req.body || {})}`).digest('hex');
    // Constant-time compare
    const ok = sigHeader.length === expected.length && crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'Bad signature' });

    const fresh = await automationStore.checkAndStoreNonce(`${slug}:${nonce}`);
    if (!fresh) return res.status(401).json({ error: 'Replayed nonce' });

    await automationStore.touchWebhook(slug);
    const automation = await automationStore.getAutomation(wh.automationId);
    if (!automation || !automation.isActive || automation.isDraft) {
        return res.status(409).json({ error: 'Automation is not active' });
    }
    // Handoff 5: the run executes the LIVE definition. A webhook issued for a
    // trigger that so far exists only in the working copy is not live yet —
    // firing it would enter the live flow at its primary trigger instead.
    const { liveHasTrigger } = require('../../core/automationRunner/definitionForRun');
    if (automation.liveVersion != null && wh.triggerStepId && !liveHasTrigger(automation, wh.triggerStepId)) {
        return res.status(409).json({ error: 'This webhook\'s trigger is not live yet. Publish the routine first.', code: 'trigger_not_live' });
    }
    // Async run; ack immediately.
    const runner = require('../../core/automationRunner');
    const triggerHeaders = pickWebhookHeaders(req);
    setImmediate(async () => {
        try {
            await runner.executeAutomation(automation, {
                triggerKind: 'webhook',
                triggerPayload: req.body || {},
                // Request headers, additively at trigger.headers.<name>
                // (A14) — OUTSIDE trigger.output, which stays the raw POST
                // body, so header names can never collide with body fields
                // and existing trigger.output.<field> bindings are
                // untouched.
                triggerHeaders,
                // Seed the DAG walk from the specific trigger node this
                // webhook row was issued for (definition.trigger or one of
                // definition.triggers[] — scoped multi-trigger slice).
                rootStepId: wh.triggerStepId || null,
            });
        }
        catch (e) { log.error('[automation/webhook] run error:', e.message); }
    });
    return res.status(202).json({ accepted: true, automationId: automation.id });
});

// Gmail Pub/Sub push — payload is base64-encoded JSON; we decode and dispatch.
//
// SECURITY: this endpoint is NOT cryptographically authenticated (Pub/Sub OIDC
// token verification is not yet wired — it needs google-auth-library + the push
// service-account audience). It is, however, no longer exploitable for a
// cross-tenant trigger: we have no emailAddress→userId mapping, so userId is
// always null, and triggerBus.dispatchEvent FAILS CLOSED for user-scoped
// providers (gmail) when userId is null — it refuses to fan out. The result is
// that this route can be flooded (rate-limited) but cannot trigger any tenant's
// automation. To actually deliver Gmail push events, two things must land
// together: (1) OIDC JWT verification here, and (2) an emailAddress→userId
// resolution so dispatch is scoped to the one owning subscriber.
router.post('/events/gmail', eventsLimiter, express.json({ limit: '128kb' }), async (req, res) => {
    try {
        const data = req.body?.message?.data;
        if (!data) return res.status(204).end();
        let decoded = {};
        try { decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch {}
        // userId intentionally null until an emailAddress→userId mapping + OIDC
        // verification exist; dispatchEvent drops null-userId gmail events.
        await triggerBus.dispatchEvent({ provider: 'gmail', event: 'mail.new', payload: decoded, userId: null });
        return res.status(204).end();
    } catch (e) {
        log.error('[automation/events/gmail] error:', e.message);
        res.status(500).end();
    }
});

// Nextcloud events forwarded by the connector (Phase 1 push pipeline).
//
// The connector subscribes to NC AppAPI events_listener for Files /
// Sharing / Calendar / Deck / Talk events; on receipt it signs the body
// with the tenant key and POSTs here. We verify the signature against
// the org's stored connector_tenant_key, map the connector's stable
// event name to a subscription, and dispatch through triggerBus.
//
// Auth model (mirrors /webhook/nc-user-sync exactly):
//   X-Beeflow-NC-Instance-Id  identifies the org
//   X-Beeflow-Sig             ts.hmac(tenantKey, "ts\nMETHOD\nurl\nbody")
//   ±5 min skew, constant-time compare.
//
// On success we mark `last_push_at` on the matching subscriptions so the
// poller can downgrade subs that haven't seen a push lately back into
// polling mode without losing events.
const captureRawNc = express.json({
    limit: '512kb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

async function verifyNcConnectorSig(req) {
    const instanceId = String(req.headers['x-beeflow-nc-instance-id'] || '');
    if (!instanceId) return null;
    const userStore = require('../../stores/userStore');
    const org = await userStore.getOrganizationByNcInstanceId(instanceId).catch(() => null);
    if (!org) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) return null;

    const sigHeader = String(req.headers['x-beeflow-sig'] || '');
    const dot = sigHeader.indexOf('.');
    if (dot === -1) return null;
    const ts = parseInt(sigHeader.slice(0, dot), 10);
    const sig = sigHeader.slice(dot + 1);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return null;

    const message = `${ts}\n${req.method}\n${req.originalUrl}\n${req.rawBody || ''}`;
    const expected = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    if (expected.length !== sig.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
    } catch { return null; }
    return org;
}

router.post('/events/nextcloud', eventsLimiter, captureRawNc, async (req, res) => {
    const org = await verifyNcConnectorSig(req);
    if (!org) return res.status(401).json({ error: 'Invalid or missing signature' });

    const { event, ncUid, payload } = req.body || {};
    if (!event) return res.status(400).json({ error: 'Missing event' });

    // Resolve the Bee Flow user from the NC uid via the user store —
    // the same mapping `ncUserGroupSync` maintains. If the uid hasn't
    // been provisioned yet, the event can't reach an automation; ack
    // so the connector doesn't retry.
    const userStore = require('../../stores/userStore');
    const user = ncUid
        ? await userStore.getUserByNcUid(org.id, ncUid).catch(() => null)
        : null;

    await triggerBus.dispatchEvent({
        provider: 'nextcloud',
        event,
        payload: payload || {},
        userId: user?.id || null,
        // Carry the org so background side-effects (e.g. Talk recording
        // auto-ingest) can resolve org-scoped settings even when the
        // ncUid → Bee Flow user mapping failed (bot/federated actor).
        orgId: org.id,
    });

    // Approval-by-reaction rides the SAME signed event (a 👍 on a card we
    // posted into Talk is a vote), additively: the trigger dispatch above
    // is untouched, so a routine subscribed to talk.reaction.added still
    // fires exactly as before.
    //
    // Deliberately NOT awaited. Approving resumes a paused run, which the
    // decision path guards for 60 SECONDS; the connector holds Talk's
    // webhook open while it waits on us, and a slow bot is one Talk marks
    // unhealthy. So the ack goes out now and the vote is counted behind
    // it — the same shape the /webhook/:slug trigger uses.
    if (event === 'talk.reaction.added') {
        setImmediate(() => {
            // try/catch as well as .catch: a throw INSIDE a setImmediate
            // callback (a bad require, a synchronous throw) is an uncaught
            // exception, and an uncaught exception on a webhook path takes
            // the process down.
            try {
                require('../../automation/approvalReactionIngest')
                    .handleTalkReaction({ orgId: org.id, ncUid: ncUid || null, payload: payload || {} })
                    .catch(e => log.warn(`[automation/events/nextcloud] approval reaction failed: ${e.message}`));
            } catch (e) {
                log.warn(`[automation/events/nextcloud] approval reaction dispatch failed: ${e.message}`);
            }
        });
    }
    // A row moved in a Nextcloud table that a datatable MIRRORS (core/
    // dataEngine/sources/nextcloudTable): patch the copy, behind the ack,
    // in the same guarded shape as the reaction above. Not awaited — a
    // mirror refresh must never hold the connector's webhook open.
    if (typeof event === 'string' && event.startsWith('tables.row.')) {
        setImmediate(() => {
            try {
                require('../../core/dataEngine/sources/nextcloudTable/events')
                    .onTablesEvent({ orgId: org.id, event, payload: payload || {} })
                    .catch(e => log.warn(`[automation/events/nextcloud] tables mirror patch failed: ${e.message}`));
            } catch (e) {
                log.warn(`[automation/events/nextcloud] tables mirror dispatch failed: ${e.message}`);
            }
        });
    }
    // A FILE changed, moved or went in Nextcloud Files that a datatable
    // mirrors as a spreadsheet (core/dataEngine/sources/spreadsheetFile):
    // mark the copy stale and re-read it, behind the ack, in the same
    // guarded shape as the two above. The Bee Flow user the ncUid mapping
    // resolved rides along — a rename by the linker re-points the stored
    // path. Not awaited, for the same reason.
    if (typeof event === 'string' && /^file\.(changed|new|deleted|renamed|restored|copied)$/.test(event)) {
        setImmediate(() => {
            try {
                require('../../core/dataEngine/sources/spreadsheetFile/events')
                    .onFileEvent({ orgId: org.id, event, payload: payload || {}, actorUserId: user?.id || null })
                    .catch(e => log.warn(`[automation/events/nextcloud] spreadsheet mirror refresh failed: ${e.message}`));
            } catch (e) {
                log.warn(`[automation/events/nextcloud] spreadsheet mirror dispatch failed: ${e.message}`);
            }
        });
    }
    // Stamp last_push_at on every nextcloud subscription this user
    // owns for this event so the polling-fallback detector knows the
    // push pipeline is healthy.
    if (user?.id) {
        try {
            const subs = await automationStore.getSubscriptionsForUserAndEvent(user.id, 'nextcloud', event);
            for (const sub of subs) {
                await automationStore.updateSubscription(sub.id, { lastPushAt: new Date().toISOString() }).catch(() => {});
            }
        } catch (_) { /* best-effort */ }
    }
    return res.status(202).end();
});

// MS Graph notifications — handles validation handshake + notifications.
router.post('/events/msgraph', eventsLimiter, express.json({ limit: '128kb' }), async (req, res) => {
    if (req.query.validationToken) {
        // Required handshake: echo the token in plain text, status 200.
        res.set('Content-Type', 'text/plain');
        return res.status(200).send(String(req.query.validationToken));
    }
    try {
        const notifications = req.body?.value || [];
        for (const n of notifications) {
            // Validate clientState. Each notification carries the value the
            // subscription was created with; we look up the matching row and
            // reject mismatches so a leaked notificationUrl can't be used to
            // forge events on behalf of another tenant.
            //
            // We can't do this for every event upfront (subscriptions are
            // keyed by externalRef which only the provisioning step has), so
            // we fan out per-notification.
            try {
                const sub = n.subscriptionId
                    ? await automationStore.getSubscriptionByExternalRef('msgraph', n.subscriptionId).catch(() => null)
                    : null;
                if (sub && sub.clientState && sub.clientState !== n.clientState) {
                    log.warn(`[automation/events/msgraph] clientState mismatch for sub ${sub.id} — dropping`);
                    continue;
                }
                // The event name subscriptions are stored/matched under is the
                // friendly `sub.eventType` (e.g. 'mail.new') set at provisioning
                // time via MSGRAPH_RESOURCE_MAP — NOT derivable from the
                // notification's own `resource` field, whose canonical path
                // shape (e.g. "Users/{id}/Messages/{id}") doesn't match the
                // subscription-time resource string. Without a resolved `sub`
                // there is no subscription to match against anyway (dropped
                // below by the user-scoped fail-closed check), so fall back to
                // a diagnostic-only label.
                await triggerBus.dispatchEvent({
                    provider: 'msgraph',
                    event: sub?.eventType || 'change',
                    payload: n,
                    userId: sub?.userId,
                });
                // A OneDrive drive subscription (a `file.*` routine trigger of
                // this user) is also the only push a spreadsheet mirror in that
                // drive gets (core/dataEngine/sources/spreadsheetFile/events).
                // The notification names no file, so every mirror that user
                // linked at OneDrive is probed. Best effort, behind the ack,
                // guarded like the Nextcloud hooks; the 5 s pulse and the
                // 1-minute ticker are the guarantees.
                if (sub?.userId && /^file\.(changed|new)$/.test(String(sub.eventType || ''))) {
                    setImmediate(() => {
                        try {
                            require('../../core/dataEngine/sources/spreadsheetFile/events')
                                .onProviderHint({ provider: 'onedrive', userId: sub.userId })
                                .catch(e => log.warn(`[automation/events/msgraph] spreadsheet mirror hint failed: ${e.message}`));
                        } catch (e) {
                            log.warn(`[automation/events/msgraph] spreadsheet mirror hint dispatch failed: ${e.message}`);
                        }
                    });
                }
            } catch (perItemErr) {
                log.warn('[automation/events/msgraph] dispatch item error:', perItemErr.message);
            }
        }
        return res.status(202).end();
    } catch (e) {
        log.error('[automation/events/msgraph] error:', e.message);
        res.status(500).end();
    }
});

// GitHub webhook — signature in X-Hub-Signature-256.
//
// SECURITY: the HMAC is verified over the RAW request bytes (what GitHub
// actually signs) — never over a re-serialised JSON.stringify(req.body), which
// can diverge from the bytes GitHub hashed and silently reject valid payloads.
// NOTE (follow-up, see audit WS1.2): the secret `automation_github_webhook_secret`
// is currently a single GLOBAL value, so a leak forges GitHub triggers for every
// org. Scoping it per-org requires a per-org GitHub App installation→org mapping
// (derive the org from the installation id / repo in the payload) — a separate
// feature that also changes the webhook URL users register in GitHub.
const captureRawJson = (limit) => express.json({
    limit,
    verify: (req, _res, buf) => { req.rawBody = buf; },
});
router.post('/events/github', eventsLimiter, captureRawJson('256kb'), async (req, res) => {
    try {
        const sig = req.get('X-Hub-Signature-256') || '';
        const event = req.get('X-GitHub-Event') || 'unknown';
        const secret = await configStore.getConfig('automation_github_webhook_secret');
        if (!secret) return res.status(503).json({ error: 'GitHub webhooks not configured' });
        const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
        const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        if (!ok) return res.status(401).json({ error: 'Bad signature' });
        await triggerBus.dispatchEvent({ provider: 'github', event, payload: req.body || {} });
        return res.status(202).end();
    } catch (e) {
        log.error('[automation/events/github] error:', e.message);
        res.status(500).end();
    }
});

module.exports = router;
