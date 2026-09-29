/**
 * Routine notifications that do not go out the moment they happen
 * (Studio → Automations handoff 5):
 *
 *   bundles  messages the throttle held back (runNotifications.js): once the
 *            recipient is under the routine's maxPerHour again, ONE message
 *            says "n more" for the lot. When the routine has a daily summary,
 *            the held messages wait for it instead.
 *   digest   the daily summary: per person, at the routine's configured time
 *            (its schedule timezone, Europe/Amsterdam by default), one message
 *            with how many runs there were, how many failed and what is still
 *            waiting, over every routine that has the summary on and names
 *            that person (owner, or a user/group recipient of an enabled event).
 *            Nothing happened and nothing waits: no message.
 *
 * Delivery reuses runNotifications' bell (Nextcloud or Bee Flow) and e-mail;
 * a summary goes to a person, so it never goes to a Talk conversation. The
 * Nextcloud text is totals only; routine names and counts go to the Bee Flow
 * bell and the e-mail.
 *
 * Runs every five minutes from core/automationRunner/scheduler/ticks.js under
 * an advisory lock (one pod). Idempotent: a summary is due when the person's
 * last one for those routines is older than today's slot; a bundle is marked
 * reported in the same pass that sends it.
 *
 * Everything is injected (defaultDeps) so the tests run without a database.
 */

'use strict';

const log = require('../telemetry/log');
const { normalizeNotificationSettings } = require('../automation/notificationDefaults');
const { resolveDigestRecipientIds } = require('../automation/notificationRecipients');
const { bundleMessage, composeDigest, talkText } = require('../automation/notificationMessages');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A summary more than this late (the server was down) is skipped, not sent at midnight. */
const DIGEST_GRACE_MS = 3 * HOUR_MS;
const EVENT_RETENTION_DAYS = 30;

function defaultDeps() {
    const runNotifications = require('../core/automationRunner/runNotifications');
    return {
        events: require('../stores/automationStore/notificationEvents'),
        getAutomation: (id) => require('../stores/automationStore').getAutomation(id),
        listUsers: () => require('../stores/userStore').getAllUsers(),
        getUser: (id) => require('../stores/userStore').getUser(id),
        deliverBell: (o) => runNotifications.deliverBell(o),
        sendRunEmail: (a, o) => runNotifications.sendRunEmail(a, o),
        sendDigestEmail: async ({ userId, subject, text }) => {
            const emailService = require('../utils/emailService');
            const cfg = await emailService.getServiceEmailConfig().catch(() => null);
            if (!cfg?.configured) return { sent: false, reason: 'no_service_email' };
            const user = await require('../stores/userStore').getUser(userId).catch(() => null);
            if (!user?.email) return { sent: false, reason: 'no_owner_email' };
            await emailService.sendServiceEmail({ to: user.email, subject, text });
            return { sent: true };
        },
        resolveNcContext: (ownerId) => require('../automation/approvalDelivery').resolveNcContext(ownerId),
        postTalk: (o) => require('../automation/approvalDelivery').postTalkCard(o),
        nextSlot: (time, tz, fromTs) => {
            const [h, m] = time.split(':').map(Number);
            return require('../automation/cron').nextRunAt(`${m} ${h} * * *`, tz, fromTs);
        },
        absoluteUrl: (path) => {
            try { return `${require('../automation/publicUrl').resolvePublicBaseUrl()}${path}`; } catch { return path; }
        },
        appPaths: require('../utils/appPaths'),
    };
}

/**
 * The most recent daily slot at or before `now` for "HH:MM" in `tz`, or null.
 * `nextSlot(time, tz, from)` is the first slot strictly after `from`; looking
 * from a day back finds today's (or, before the time, yesterday's).
 */
function latestSlot(time, tz, now, nextSlot) {
    let slot;
    try { slot = nextSlot(time, tz, now - DAY_MS); } catch { return null; }
    // automation/cron returns an ISO string; accept a Date or epoch ms too.
    const ts = slot instanceof Date ? slot.getTime() : (typeof slot === 'string' ? Date.parse(slot) : Number(slot));
    if (slot == null) return null;
    if (!Number.isFinite(ts) || ts > now) return null;
    return ts;
}

/** A lazy Nextcloud identity per routine owner, shared across one pass. */
function ncCache(deps) {
    const cache = new Map();
    return (ownerId) => ({
        get: async () => {
            if (!cache.has(ownerId)) {
                cache.set(ownerId, await Promise.resolve(deps.resolveNcContext(ownerId)).catch(() => null));
            }
            return cache.get(ownerId);
        },
    });
}

/**
 * Send "n more" for every group of held messages whose recipient is under
 * the cap again. Returns how many bundle messages went out.
 */
async function flushBundles(deps, now, nc) {
    const groups = await deps.events.listPendingBundles({ limit: 200 });
    let sent = 0;
    const settingsCache = new Map();
    for (const g of groups) {
        try {
            if (!settingsCache.has(g.automationId)) {
                const a = await Promise.resolve(deps.getAutomation(g.automationId)).catch(() => null);
                settingsCache.set(g.automationId, a ? { a, settings: normalizeNotificationSettings(a.definition?.notificationSettings) } : null);
            }
            const entry = settingsCache.get(g.automationId);
            if (!entry) {                          // trashed or gone: nothing to report
                await deps.events.markEventsReported(g.ids, new Date(now));
                continue;
            }
            const { a, settings } = entry;
            const ev = settings[g.event];
            // The daily summary will report them, when this person gets one.
            if (settings.digest.enabled && !g.recipient.startsWith('talk:')) {
                if (!entry.digestIds) {
                    entry.digestIds = new Set(await resolveDigestRecipientIds(settings, {
                        automation: a, orgId: a.organizationId || null,
                    }, { listUsers: () => deps.listUsers() }).catch(() => []));
                }
                if (entry.digestIds.has(g.recipient)) continue;
            }
            const cap = ev?.throttle?.maxPerHour ?? null;
            if (cap != null) {
                const recent = await deps.events.countRecentMessages({
                    automationId: g.automationId, event: g.event, recipient: g.recipient, since: new Date(now - HOUR_MS),
                });
                if (recent >= cap) continue;       // the hour is not over yet
            }

            const msg = bundleMessage({ event: g.event, title: a.title, count: g.count });
            const link = `${deps.appPaths.automationPath(a.id)}?view=runs`;
            const url = deps.absoluteUrl(link);
            const createdAt = new Date(now);
            const rows = [];
            for (const channel of g.channels) {
                let ok = false;
                try {
                    if (channel === 'bell') {
                        const r = await deps.deliverBell({
                            userId: g.recipient, event: g.event, urgency: ev?.urgency || 'normal',
                            title: msg.text, message: '', link, short: msg.text, url, nc: nc(a.userId),
                        });
                        ok = !!r?.ok;
                    } else if (channel === 'email') {
                        const r = await deps.sendRunEmail(a, { subject: msg.text, message: url || '', userId: g.recipient });
                        ok = !!r?.sent;
                    } else if (channel === 'talk' && g.recipient.startsWith('talk:')) {
                        const r = await deps.postTalk({
                            orgId: a.organizationId || null, roomToken: g.recipient.slice(5),
                            message: talkText(msg.text, url), ownerId: a.userId, silent: ev?.urgency === 'silent',
                        });
                        ok = !!r?.ok;
                    }
                } catch (e) {
                    log.warn(`[automationDigest] bundle ${channel} failed for ${a.id}: ${e.message}`);
                }
                rows.push({
                    automationId: a.id, event: g.event, recipient: g.recipient, channel,
                    urgency: ev?.urgency || 'normal', createdAt, delivered: ok,
                });
            }
            await deps.events.recordNotificationEvents(rows);
            await deps.events.markEventsReported(g.ids, createdAt);
            sent += 1;
        } catch (e) {
            log.warn(`[automationDigest] bundle for ${g.automationId}/${g.event} failed: ${e.message}`);
        }
    }
    return sent;
}

/**
 * Who gets a summary now, and over which routines: Map recipient →
 * [{ automation, settings, slot }], only the routines whose slot is due.
 */
async function dueDigests(deps, now) {
    const automations = await deps.events.listDigestAutomations();
    const byRecipient = new Map();
    let users = null;
    const listUsers = async () => {
        if (!users) users = await Promise.resolve(deps.listUsers()).catch(() => []);
        return users;
    };
    for (const a of automations) {
        const settings = normalizeNotificationSettings(a.notificationSettings);
        if (!settings.digest.enabled) continue;
        const slot = latestSlot(settings.digest.time, a.scheduleTz || 'Europe/Amsterdam', now, deps.nextSlot);
        if (slot == null || now - slot > DIGEST_GRACE_MS) continue;
        let orgId = a.organizationId || null;
        if (!orgId) {
            const owner = await Promise.resolve(deps.getUser(a.userId)).catch(() => null);
            orgId = owner?.organizationId || null;
        }
        const ids = await resolveDigestRecipientIds(settings, { automation: a, orgId }, { listUsers });
        for (const id of ids) {
            if (!byRecipient.has(id)) byRecipient.set(id, []);
            byRecipient.get(id).push({ automation: a, settings, slot });
        }
    }
    return byRecipient;
}

/** Build and send one person's summary. Returns true when a message went out. */
async function sendDigest(deps, now, nc, recipient, entries) {
    const automationIds = entries.map(e => e.automation.id);
    const slot = Math.min(...entries.map(e => e.slot));
    const last = await deps.events.lastDigestAt(recipient, automationIds);
    const lastTs = last ? Date.parse(last) : null;
    if (lastTs != null && lastTs >= slot) return false;          // already sent for this slot
    const since = lastTs != null ? new Date(lastTs) : new Date(slot - DAY_MS);

    const stats = await deps.events.digestRunStats({ automationIds, since });
    const held = await deps.events.listHeldForDigest({ recipient, automationIds });
    // One message can have held a row per channel: count messages, not rows.
    const heldMessages = new Set(held.map(h => `${h.automationId}|${h.createdAt}`));
    const heldBy = new Map();
    for (const key of heldMessages) {
        const id = key.slice(0, key.indexOf('|'));
        heldBy.set(id, (heldBy.get(id) || 0) + 1);
    }

    const digest = composeDigest({
        items: entries.map(e => ({
            automationId: e.automation.id,
            title: e.automation.title,
            ...(stats.get(e.automation.id) || { runs: 0, failures: 0, waiting: 0 }),
            held: heldBy.get(e.automation.id) || 0,
        })),
        link: '/app/studio/automations',
    });
    const createdAt = new Date(now);
    const rows = [];
    if (digest) {
        const url = deps.absoluteUrl(digest.link);
        const first = entries[0].automation;
        let bellOk = false;
        try {
            const r = await deps.deliverBell({
                userId: recipient, event: 'digest', urgency: 'silent',
                title: digest.shortText, message: digest.text, link: digest.link,
                short: digest.shortText, url, nc: nc(first.userId),
            });
            bellOk = !!r?.ok;
        } catch (e) { log.warn(`[automationDigest] bell failed for ${recipient}: ${e.message}`); }
        let mailOk = false;
        try {
            const r = await deps.sendDigestEmail({
                userId: recipient, subject: digest.subject,
                text: `${digest.text}${url ? `\n\n${url}` : ''}\n\nYour daily summary from Bee Flow. Switch it off in a routine's Settings, under Notifications.`,
            });
            mailOk = !!r?.sent;
        } catch (e) { log.warn(`[automationDigest] e-mail failed for ${recipient}: ${e.message}`); }
        for (const id of automationIds) {
            rows.push({ automationId: id, event: 'digest', recipient, channel: 'bell', urgency: 'silent', createdAt, delivered: bellOk });
            rows.push({ automationId: id, event: 'digest', recipient, channel: 'email', urgency: 'silent', createdAt, delivered: mailOk });
        }
    } else {
        // Nothing to say: still mark the slot as handled so it is not re-checked.
        for (const id of automationIds) {
            rows.push({ automationId: id, event: 'digest', recipient, channel: 'none', urgency: 'silent', createdAt, delivered: false });
        }
    }
    await deps.events.recordNotificationEvents(rows);
    if (held.length) await deps.events.markEventsReported(held.map(h => h.id), createdAt);
    return !!digest;
}

/**
 * One pass: bundles, then summaries, then (about once an hour) the ledger's
 * retention. Every part is best-effort; one failure never ends the pass.
 */
async function digestPass(deps = defaultDeps(), now = Date.now()) {
    const out = { bundles: 0, digests: 0, purged: 0 };
    const nc = ncCache(deps);
    try { out.bundles = await flushBundles(deps, now, nc); }
    catch (e) { log.warn(`[automationDigest] bundle pass failed: ${e.message}`); }
    try {
        const due = await dueDigests(deps, now);
        for (const [recipient, entries] of due) {
            try { if (await sendDigest(deps, now, nc, recipient, entries)) out.digests += 1; }
            catch (e) { log.warn(`[automationDigest] summary for ${recipient} failed: ${e.message}`); }
        }
    } catch (e) { log.warn(`[automationDigest] summary pass failed: ${e.message}`); }
    if (new Date(now).getUTCMinutes() < 5) {
        try { out.purged = await deps.events.purgeNotificationEvents({ days: EVENT_RETENTION_DAYS }); }
        catch (e) { log.warn(`[automationDigest] ledger purge failed: ${e.message}`); }
    }
    return out;
}

module.exports = { digestPass, flushBundles, dueDigests, sendDigest, latestSlot, DIGEST_GRACE_MS, EVENT_RETENTION_DAYS };
