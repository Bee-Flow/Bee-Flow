// @typecheck
/**
 * Google Calendar pollers (event.changed via syncToken, event.upcoming),
 * extracted verbatim from ../../triggerBus.js.
 *
 * `ctx` is the object triggerBus.js builds: `store()` returns the current
 * automationStore (swappable through triggerBus._setDepsForTests), the other
 * getters return the client / integration modules, required lazily as they
 * were inline. Everything that sits in the server's import cycle comes in
 * through it, so this module stays a leaf.
 */

const log = require('../../../telemetry/log');
const { fallback } = require('../../../utils/bestEffort');

/** @param {any} ctx */
function createGoogleCalendarPollers(ctx) {
    return {
        'event.changed': async (sub, session) => {
            try {
                const { createGoogleApiClient } = ctx.googleClient();
                const cal = await createGoogleApiClient(session, { api: 'calendar', version: 'v3' });
                const isBootstrap = !sub.lastCursor;
                // Calendar's syncToken expires after ~1 month of disuse and
                // returns 410 Gone — same recoverable shape as Gmail's 404.
                // Drop the cursor and let the next tick re-bootstrap.
                try {
                    // `nextSyncToken` only appears on the LAST page of a sync;
                    // intermediate pages return `nextPageToken` instead.
                    // Paginate until we actually reach the sync token —
                    // otherwise the cursor never persists and every poll
                    // repeats the same (unbounded) full sync forever.
                    let pageToken;
                    let syncToken = null;
                    const items = [];
                    do {
                        const res = await cal.events.list({
                            calendarId: 'primary',
                            syncToken: sub.lastCursor || undefined,
                            pageToken,
                            maxResults: 2500,
                        });
                        // On bootstrap (no prior cursor), this is a mass full
                        // sync of everything on the calendar — none of it is
                        // an actual "change" the automation should fire on.
                        // Just anchor the cursor; don't dispatch.
                        if (!isBootstrap) items.push(...(res.data.items || []));
                        pageToken = res.data.nextPageToken || undefined;
                        if (res.data.nextSyncToken) syncToken = res.data.nextSyncToken;
                    } while (pageToken);

                    if (syncToken) await ctx.store().updateSubscription(sub.id, { lastCursor: syncToken });
                    if (isBootstrap) {
                        log.info(`[TriggerBus] calendar bootstrap sub ${sub.id} anchored${syncToken ? '' : ' (no syncToken returned — will retry next tick)'}`);
                        return [];
                    }
                    return items.map(ev => ({
                        eventId: ev.id,
                        summary: ev.summary || '',
                        description: ev.description || null,
                        start: ev.start || null,
                        end: ev.end || null,
                        status: ev.status || null,
                        calendarId: 'primary',
                        organizer: ev.organizer || null,
                        attendees: ev.attendees || [],
                        htmlLink: ev.htmlLink || null,
                    }));
                } catch (err) {
                    const code = err?.code || err?.response?.status;
                    if (code === 410 || /sync token/i.test(err?.message || '')) {
                        log.warn(`[TriggerBus] calendar syncToken stale for sub ${sub.id} — clearing.`);
                        await ctx.store().updateSubscription(sub.id, { lastCursor: null });
                        // Bootstrap on the next tick — return [] so we don't
                        // dump a year of historic events into the user's lap.
                        return [];
                    }
                    throw err;
                }
            } catch (e) {
                log.warn('[TriggerBus] calendar poll error:', e.message);
                return [];
            }
        },

        /**
         * event.upcoming — fire N minutes before the start of an event.
         * Cursor JSON: { firedIds:[…last 200] }.
         */
        'event.upcoming': async (sub, session) => {
            try {
                const { createGoogleApiClient } = ctx.googleClient();
                const cal = await createGoogleApiClient(session, { api: 'calendar', version: 'v3' });

                const filter = sub.filter || {};
                const leadMinutes = Math.max(1, Math.min(Number(filter.leadMinutes) || 15, 240));
                const calendarId = filter.calendarId || 'primary';
                const includeAllDay = filter.includeAllDay === true;

                const now = Date.now();
                // Query a slightly wider window than leadMinutes so a slow
                // tick doesn't miss the boundary.
                const SAFETY_MIN = 5;
                const timeMin = new Date(now).toISOString();
                const timeMax = new Date(now + (leadMinutes + SAFETY_MIN) * 60_000).toISOString();

                const res = await cal.events.list({
                    calendarId,
                    timeMin, timeMax,
                    singleEvents: true,
                    orderBy: 'startTime',
                    maxResults: 50,
                });

                let cursor = { firedIds: [] };
                try { if (sub.lastCursor) cursor = JSON.parse(sub.lastCursor) || cursor; } catch (err) { fallback('automation/triggerBus/pollers/googleCalendar:event.upcoming', err); /* ignore */ }
                const fired = new Set(Array.isArray(cursor.firedIds) ? cursor.firedIds : []);

                const events = [];
                const newlyFired = [];
                for (const ev of (res.data.items || [])) {
                    if (!ev.id || fired.has(ev.id)) continue;
                    if (!includeAllDay && !ev.start?.dateTime) continue; // skip all-day unless asked
                    const startMs = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : NaN;
                    if (!Number.isFinite(startMs)) continue;
                    const minutesUntilStart = Math.round((startMs - now) / 60_000);
                    if (minutesUntilStart > leadMinutes) continue; // not yet within window
                    if (minutesUntilStart < -SAFETY_MIN) continue; // already started > safety ago
                    events.push({
                        eventId: ev.id,
                        summary: ev.summary || '',
                        description: ev.description || null,
                        start: ev.start, end: ev.end,
                        status: ev.status || null,
                        calendarId,
                        organizer: ev.organizer || null,
                        attendees: ev.attendees || [],
                        htmlLink: ev.htmlLink || null,
                        minutesUntilStart,
                    });
                    newlyFired.push(ev.id);
                }

                if (newlyFired.length > 0) {
                    const all = [...fired, ...newlyFired].slice(-200);
                    await ctx.store().updateSubscription(sub.id, {
                        lastCursor: JSON.stringify({ firedIds: all }),
                    });
                } else if (!sub.lastCursor) {
                    // Initialise an empty cursor so we don't keep hitting
                    // the bootstrap branch.
                    await ctx.store().updateSubscription(sub.id, {
                        lastCursor: JSON.stringify({ firedIds: [] }),
                    });
                }
                return events;
            } catch (e) {
                log.warn('[TriggerBus] calendar upcoming poll error:', e.message);
                return [];
            }
        },
    };
}

module.exports = { createGoogleCalendarPollers };
