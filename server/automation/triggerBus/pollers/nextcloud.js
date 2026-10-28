// @typecheck
/**
 * Nextcloud pollers, extracted verbatim from ../../triggerBus.js: the
 * activity-feed channels (file.new / file.changed / share.received /
 * activity.new) on one short-lived per-user feed cache, plus
 * notification.new and calendar.event.upcoming.
 *
 * `ctx` is the object triggerBus.js builds: `store()` returns the current
 * automationStore (swappable through triggerBus._setDepsForTests), the other
 * getters return the client / integration modules, required lazily as they
 * were inline. Everything that sits in the server's import cycle comes in
 * through it, so this module stays a leaf.
 */

const log = require('../../../telemetry/log');
const { fallback } = require('../../../utils/bestEffort');
const { normaliseFilePayload, normaliseCalendarPayload } = require('../ncPayload.mts');

/**
 * Longest lead time calendar.event.upcoming honours, in minutes. Configurable
 * (0 = no cap); the default is a day. A value out of range is clamped here
 * and the builder says so when the trigger is saved (builderTools/triggerAdvice.js).
 */
function upcomingMaxLeadMinutes() {
    const raw = parseInt(String(process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES ?? ''), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 1440;
}

/** @param {unknown} value  the filter's leadMinutes */
function upcomingLeadMinutes(value) {
    const n = Number(value);
    const lead = Number.isFinite(n) && n > 0 ? n : 15;
    const max = upcomingMaxLeadMinutes();
    return Math.max(1, max > 0 ? Math.min(lead, max) : lead);
}

/** Most calendars one upcoming subscription reads per tick (0 = all). */
function upcomingMaxCalendars() {
    const raw = parseInt(String(process.env.AUTOMATION_NC_UPCOMING_MAX_CALENDARS ?? ''), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 50;
}

/**
 * The calendar URIs an upcoming subscription watches: the filter's choice, or
 * every calendar the user has (falling back to 'personal' when the list
 * cannot be read).
 * @param {Record<string, any>} filter
 * @param {(args: Record<string, unknown>) => Promise<any>} listCalendars
 * @returns {Promise<string[]>}
 */
async function upcomingCalendars(filter, listCalendars) {
    const named = Array.isArray(filter.calendars)
        ? filter.calendars.map((c) => String(c ?? '').trim()).filter(Boolean)
        : [];
    const one = filter.calendar || filter.calendarUri || filter.calendarId;
    if (named.length) return [...new Set(named)];
    if (one) return [String(one)];
    const result = await listCalendars({}).catch((e) => fallback('automation/triggerBus/pollers/nextcloud:upcomingCalendars', e, null));
    const slugs = Array.isArray(result?.calendars)
        ? result.calendars.map((c) => c && c.slug).filter((s) => typeof s === 'string' && s)
        : [];
    if (!slugs.length) return ['personal'];
    const cap = upcomingMaxCalendars();
    return cap > 0 ? slugs.slice(0, cap) : slugs;
}

// Module-scoped cache of the Nextcloud activity feed per-user. Five
// triggers (file.new / file.changed / share.received / activity.new /
// notification.new) can subscribe at once for the same user; without a
// cache they would each issue an HTTP request inside a single polling
// tick. Cache is short-lived (a few seconds) — long enough to coalesce
// the in-pass calls, short enough that the next tick still fetches fresh
// rows.
//
// In-flight dedup. Two concurrent ticks (multi-pod, or a
// reaper-triggered re-poll) would issue duplicate fetches because each
// only sees the empty resolved cache. So we park the in-flight Promise
// alongside the cached rows; concurrent callers await the same Promise
// instead of firing their own request.
const _ncActivityCache = new Map(); // userId → { ts, rows[], inflight? }
const NC_ACTIVITY_CACHE_TTL_MS = 5_000;

async function _ncFetchActivityRows(ctx, userId, session) {
    const cached = _ncActivityCache.get(userId);
    if (cached) {
        if (cached.inflight) {
            // Someone else is fetching; piggyback on their result.
            return cached.inflight;
        }
        if (Date.now() - cached.ts < NC_ACTIVITY_CACHE_TTL_MS) return cached.rows;
    }
    const promise = (async () => {
        let rows = [];
        try {
            const tools = ctx.nextcloudActivityTools();
            const { guardedNcCall } = ctx.ncScopeGuard();
            const result = await guardedNcCall('nextcloud_activity_list', { filter: 'all', limit: 200 }, { userId, session },
                () => tools.executeNextcloudActivityTool('nextcloud_activity_list', { filter: 'all', limit: 200 }, userId, session));
            if (result?.activities) rows = result.activities;
            return rows;
        } catch (e) {
            log.warn(`[TriggerBus] nextcloud activity fetch threw for user ${userId}: ${/** @type {Error} */ (e).message}`);
            return rows;
        }
    })().then((rows) => {
        rows.sort((a, b) => (a.id || 0) - (b.id || 0));
        _ncActivityCache.set(userId, { ts: Date.now(), rows, inflight: null });
        return rows;
    }).catch((e) => {
        // Clear the inflight slot so the next tick can retry.
        _ncActivityCache.set(userId, { ts: 0, rows: [], inflight: null });
        throw e;
    });

    _ncActivityCache.set(userId, { ts: cached?.ts || 0, rows: cached?.rows || [], inflight: promise });
    return promise;
}

/**
 * Map a raw activity row to the normalised payload our triggers emit, plus
 * `_kind` flags the per-trigger filter uses to route. Activity API type
 * slugs vary by Nextcloud version, so we look at both the `type` field
 * and the human-readable subject as a fallback (documented in the plan).
 */
/**
 * @param {NcActivityRow} row
 * @param {{ nextcloudUid?: string | null, connectorNcUid?: string | null, automationProviders?: { nextcloud?: { nextcloudUid?: string | null } } } | null | undefined} session
 * @returns {Record<string, any>}  the canonical file payload plus the activity-only keys
 */
function _ncNormaliseActivity(row, session) {
    const t = String(row.type || '').toLowerCase();
    const subj = String(row.subject || '').toLowerCase();
    // file.new = "a file APPEARED in the folder". Covers fresh uploads
    // (file_created) and restores (file_restored), PLUS a file moved / copied /
    // renamed INTO the folder. Nextcloud has no dedicated move/copy activity
    // type — it reports them as `file_changed` with a move/copy/rename subject
    // (the destination path lands in objectName, which the inFolder filter
    // already matches). We read the subject (EN + NL, the connector locales) to
    // tell an arrival from a plain in-place edit, which stays file.changed only.
    // Without this, an invoice MOVED into /Invoices/test never fired file.new.
    const ARRIVAL_SUBJECT_RE = /\b(moved|renamed|copied|restored|verplaatst|hernoemd|gekopieerd|teruggezet)\b/;
    const isFileCreated = t === 'file_created'
        || t === 'file_restored'
        || (t === 'files' && subj.includes('created'))
        || ((t === 'file_changed' || t === 'files') && ARRIVAL_SUBJECT_RE.test(subj));
    const isFileChanged = t === 'file_changed' || t === 'file_updated' || (t === 'files' && (subj.includes('changed') || subj.includes('updated')));
    const isShareReceived = t === 'shared_with_you' || t === 'remote_share_received'
        || ((t === 'shares' || t === 'shared') && subj.includes('shared'));

    const sessionUid = session?.nextcloudUid
        || session?.automationProviders?.nextcloud?.nextcloudUid
        || session?.connectorNcUid
        || null;
    const isOwnAction = !!(sessionUid && row.actor === sessionUid);

    // The canonical file payload (../ncPayload.mts) — the same keys the
    // connector's webhook delivers for the same event — plus the activity-only
    // keys automations may already bind to (type, subject, message, raw, ...).
    return {
        ...normaliseFilePayload({
            activityId: row.id,
            type: row.type,
            subject: row.subject,
            message: row.message,
            actor: row.actor,
            objectName: row.objectName,
            objectType: row.objectType,
            // The activity row's object id is the file id the webhook calls `id`.
            id: row.objectId ?? null,
            path: row.objectName || '',
            link: row.link,
            datetime: row.datetime,
            isOwnAction,
        }, { viewerUid: sessionUid }),
        raw: row,
        _isFileCreated: isFileCreated,
        _isFileChanged: isFileChanged,
        _isShareReceived: isShareReceived,
    };
}

/** Generic Nextcloud poller body — every Nextcloud channel uses this
 *  with a different `predicate` to pick which rows to emit. */
async function _ncPollChannel(ctx, { sub, session, predicate }) {
    const rows = await _ncFetchActivityRows(ctx, sub.userId, session);
    const cursorId = sub.lastCursor ? Number(sub.lastCursor) : 0;
    const fresh = rows.filter(r => Number(r.id || 0) > cursorId);

    // Bootstrap: first poll only anchors the cursor; we don't deliver
    // historic rows the moment the user activates the trigger (mirrors
    // the Gmail bootstrap convention).
    if (!sub.lastCursor) {
        const maxId = rows.length ? rows[rows.length - 1].id : null;
        if (maxId != null) {
            await ctx.store().updateSubscription(sub.id, { lastCursor: String(maxId) });
            log.info(`[TriggerBus] nextcloud bootstrap sub ${sub.id} anchored at activity_id=${maxId}`);
        }
        return [];
    }

    const events = [];
    let highest = cursorId;
    for (const row of fresh) {
        const normalised = _ncNormaliseActivity(row, session);
        if (predicate(normalised)) events.push(normalised);
        if (Number(row.id || 0) > highest) highest = Number(row.id);
    }
    if (highest > cursorId) {
        await ctx.store().updateSubscription(sub.id, { lastCursor: String(highest) });
    }
    return events;
}

/** @param {any} ctx */
function createNextcloudPollers(ctx) {
    return {
        'file.new':       (sub, session) => _ncPollChannel(ctx, { sub, session, predicate: r => r._isFileCreated }),
        'file.changed':   (sub, session) => _ncPollChannel(ctx, { sub, session, predicate: r => r._isFileChanged }),
        'share.received': (sub, session) => _ncPollChannel(ctx, { sub, session, predicate: r => r._isShareReceived }),
        'activity.new':   (sub, session) => _ncPollChannel(ctx, { sub, session, predicate: () => true }),

        /**
         * notification.new — separate Notifications API, not the activity
         * feed. Cursor = highest seen notification id.
         */
        'notification.new': async (sub, session) => {
            try {
                const tools = ctx.nextcloudNotificationsTools();
                const { guardedNcCall } = ctx.ncScopeGuard();
                const result = await guardedNcCall('nextcloud_notifications_list', { limit: 100 }, { userId: sub.userId, session },
                    () => tools.executeNextcloudNotificationsTool('nextcloud_notifications_list', { limit: 100 }, sub.userId, session));
                if (result?.error) {
                    log.warn(`[TriggerBus] nextcloud notifications fetch failed for sub ${sub.id}: ${result.error}`);
                    return [];
                }
                const items = Array.isArray(result?.notifications) ? result.notifications.slice() : [];
                items.sort((a, b) => (a.id || 0) - (b.id || 0));
                const cursorId = sub.lastCursor ? Number(sub.lastCursor) : 0;

                if (!sub.lastCursor) {
                    // Only anchor once notifications actually exist. Anchoring at
                    // 0 on an empty first poll would make the next non-empty tick
                    // treat the entire list as "fresh" and replay it.
                    if (items.length) {
                        await ctx.store().updateSubscription(sub.id, { lastCursor: String(items[items.length - 1].id) });
                    }
                    return [];
                }

                const fresh = items.filter(n => Number(n.id || 0) > cursorId);
                let highest = cursorId;
                const events = [];
                for (const n of fresh) {
                    if (Number(n.id || 0) > highest) highest = Number(n.id);
                    events.push({
                        notificationId: n.id,
                        app: n.app || null,
                        subject: n.subject || '',
                        message: n.message || '',
                        link: n.link || null,
                        datetime: n.datetime || null,
                    });
                }
                if (highest > cursorId) await ctx.store().updateSubscription(sub.id, { lastCursor: String(highest) });
                return events;
            } catch (e) {
                log.warn('[TriggerBus] nextcloud notifications poll error:', /** @type {Error} */ (e).message);
                return [];
            }
        },

        /**
         * calendar.event.upcoming — fire N minutes before a Nextcloud calendar
         * event starts. NC has no real-time push class for "starting soon", so
         * this is poll-derived (mirrors the google-calendar event.upcoming
         * handler above). Cursor JSON: { firedIds:[…last 200] }, keyed
         * `uid|dtstart` so recurring-event instances dedupe independently.
         * Emits the shape matchNextcloudCalendarUpcomingFilter expects
         * (startsAt / summary / calendarId / calendarUri / attendees).
         *
         * Which calendars: the ones the filter names (`calendars: [...]`, or
         * one `calendar` / `calendarId` / `calendarUri`), otherwise EVERY
         * calendar the user can see — reading one calendar by default would
         * silently miss every event in the others.
         */
        'calendar.event.upcoming': async (sub, session) => {
            try {
                const tools = ctx.nextcloudCalendarTools();
                const filter = sub.filter || {};
                const leadMinutes = upcomingLeadMinutes(filter.leadMinutes);
                const includeAllDay = filter.includeAllDay === true;
                const { guardedNcCall } = ctx.ncScopeGuard();
                const calendars = await upcomingCalendars(filter, (args) => guardedNcCall('nextcloud_calendar_list', args, { userId: sub.userId, session },
                    () => tools.executeNextcloudCalendarTool('nextcloud_calendar_list', args, sub.userId, session)));

                const now = Date.now();
                const SAFETY_MIN = 5; // widen the window so a slow tick doesn't miss the boundary
                /** @type {{ calendar: string, ev: any }[]} */
                const items = [];
                let failures = 0;
                for (const calendar of calendars) {
                    const evArgs = {
                        calendar,
                        start: new Date(now).toISOString(),
                        end: new Date(now + (leadMinutes + SAFETY_MIN) * 60_000).toISOString(),
                        limit: 50,
                    };
                    const result = await guardedNcCall('nextcloud_calendar_list_events', evArgs, { userId: sub.userId, session },
                        () => tools.executeNextcloudCalendarTool('nextcloud_calendar_list_events', evArgs, sub.userId, session));
                    if (result?.error) {
                        failures += 1;
                        log.warn(`[TriggerBus] nextcloud calendar upcoming fetch failed for sub ${sub.id}: ${result.error}`);
                        continue;
                    }
                    for (const ev of (Array.isArray(result?.events) ? result.events : [])) items.push({ calendar, ev });
                }
                // Every calendar failed: leave the cursor alone (nothing was read).
                if (calendars.length > 0 && failures === calendars.length) return [];

                let cursor = { firedIds: [] };
                try { if (sub.lastCursor) cursor = JSON.parse(sub.lastCursor) || cursor; } catch (err) { fallback('automation/triggerBus/pollers/nextcloud:calendar.event.upcoming', err); /* ignore */ }
                const fired = new Set(Array.isArray(cursor.firedIds) ? cursor.firedIds : []);

                const events = [];
                /** @type {string[]} */
                const newlyFired = [];
                for (const { calendar, ev } of items) {
                    const startsAt = ev.dtstart || null;
                    const startMs = startsAt ? Date.parse(startsAt) : NaN;
                    if (!Number.isFinite(startMs)) continue;
                    if (!includeAllDay && ev.allDay) continue; // skip all-day unless asked
                    const key = `${ev.uid || ev.href || ''}|${startsAt}`;
                    // The same event can sit in two calendars (a shared one): fire once.
                    if (fired.has(key) || newlyFired.includes(key)) continue;
                    const minutesUntilStart = Math.round((startMs - now) / 60_000);
                    if (minutesUntilStart > leadMinutes) continue;  // not yet within window
                    if (minutesUntilStart < -SAFETY_MIN) continue;  // already started > safety ago
                    events.push(normaliseCalendarPayload({
                        uid: ev.uid || null,
                        summary: ev.summary || '',
                        description: ev.description || null,
                        startsAt,
                        endsAt: ev.dtend || null,
                        location: ev.location || null,
                        calendar,
                        calendarId: calendar,
                        calendarUri: calendar,
                        // attendees come back as {cn,email} objects; flatten to
                        // strings so matchNextcloudCalendarFilter's attendeeContains works.
                        attendees: (ev.attendees || []).map(a => (a && (a.email || a.cn)) || a).filter(Boolean),
                        organizer: ev.organizer || null,
                        allDay: !!ev.allDay,
                        minutesUntilStart,
                    }));
                    newlyFired.push(key);
                }

                if (newlyFired.length > 0) {
                    const all = [...fired, ...newlyFired].slice(-200);
                    await ctx.store().updateSubscription(sub.id, { lastCursor: JSON.stringify({ firedIds: all }) });
                } else if (!sub.lastCursor) {
                    // Anchor an empty cursor so we stop hitting the bootstrap branch.
                    await ctx.store().updateSubscription(sub.id, { lastCursor: JSON.stringify({ firedIds: [] }) });
                }
                return events;
            } catch (e) {
                log.warn('[TriggerBus] nextcloud calendar upcoming poll error:', /** @type {Error} */ (e).message);
                return [];
            }
        },
    };
}

module.exports = { createNextcloudPollers, _ncFetchActivityRows, _ncNormaliseActivity, upcomingLeadMinutes, upcomingMaxLeadMinutes, upcomingCalendars };

/**
 * One row of the Nextcloud activity feed.
 * @typedef {{ id?: number, type?: string, subject?: string, message?: string, actor?: string, objectName?: string, objectType?: string, objectId?: number | string, link?: string, datetime?: string }} NcActivityRow
 */
