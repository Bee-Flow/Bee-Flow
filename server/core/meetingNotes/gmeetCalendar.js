// @typecheck strict
/**
 * Google Meet calendar helper — mirror of `talkCalendar.js` for Google.
 *
 * Lists the user's calendar events that carry a Google Meet link (upcoming for
 * the "Upcoming" view / auto-record scoping, recently-ended for the gmeet
 * import poller) and extracts the Meet meeting code the Meet REST API keys on.
 *
 * Built on the shared googleapis client (`createGoogleApiClient`); Meet-link
 * extraction is parity with `calendarTools.formatEvent` (`hangoutLink ||
 * conferenceData.entryPoints[0].uri`).
 */

// The Google client is injected by integrations/ (see ../integrations/integrationClients.js).
const { integrationClient } = require('../integrations/integrationClients');
const log = require('../../telemetry/log');

// Meet codes are three dash-separated lowercase groups (3-4-3), e.g.
// `abc-defg-hij`. Accept full meet.google.com URLs (with or without scheme,
// query, trailing path) and bare codes; anything else → null.
const MEET_LINK_RE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z-])/i;
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
// Pages of 250 calendar events followed per scan (a 7-day window of a very
// busy calendar fits many times over).
const MAX_EVENT_PAGES = 20;

/** @param {string | null | undefined} url */
function extractMeetCode(url) {
    if (!url) return null;
    const s = String(url).trim();
    if (MEET_CODE_RE.test(s)) return s.toLowerCase();
    const m = s.match(MEET_LINK_RE);
    return m ? m[1].toLowerCase() : null;
}

/**
 * @param {{ id?: string, iCalUID?: string, recurringEventId?: string, summary?: string, hangoutLink?: string,
 *   conferenceData?: { entryPoints?: Array<{ uri?: string }> },
 *   start?: { dateTime?: string, date?: string }, end?: { dateTime?: string, date?: string },
 *   organizer?: { email?: string, self?: boolean },
 *   attendees?: Array<{ email?: string, displayName?: string, self?: boolean, responseStatus?: string, resource?: boolean }> }} event  a Calendar API event
 */
function formatMeetEvent(event) {
    const meetLink = event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || null;
    const meetingCode = extractMeetCode(meetLink);
    if (!meetingCode) return null;
    return {
        eventId: event.id,
        iCalUID: event.iCalUID || null,
        // Set on one occurrence of a recurring series: the auto-record switch
        // then reports 'series_only' instead of arming space-wide recording.
        recurringEventId: event.recurringEventId || null,
        title: event.summary || '(no title)',
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        organizerEmail: event.organizer?.email || null,
        organizerSelf: event.organizer?.self === true,
        attendees: (event.attendees || []).map(a => ({
            email: a.email,
            displayName: a.displayName || null,
            self: a.self === true,
            // Kept so the ingest can leave out who declined and the rooms.
            responseStatus: a.responseStatus || null,
            resource: a.resource === true,
        })),
        meetingCode,
        meetLink,
    };
}

/**
 * @param {object | undefined} session
 * @param {{ timeMin: Date, timeMax: Date }} range
 */
async function listMeetEvents(session, { timeMin, timeMax }) {
    const calendar = await integrationClient('google').createGoogleApiClient(session, {
        api: 'calendar',
        version: 'v3',
        notConnectedError: 'Not connected to Google — user must log in with Google',
    });
    // Every page, not the first 250: the order is oldest first and the Meet
    // filter runs after the fetch, so on a busy calendar the cut dropped the
    // NEWEST meetings — exactly the ones a "recently ended" scan is for.
    /** @type {any[]} */
    const items = [];
    /** @type {string | null} */
    let pageToken = null;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        /** @type {{ data?: { items?: any[], nextPageToken?: string | null } }} */
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            maxResults: 250,
            singleEvents: true,
            orderBy: 'startTime',
            ...(pageToken ? { pageToken } : {}),
        });
        items.push(...(response.data?.items || []));
        pageToken = response.data?.nextPageToken || null;
        if (!pageToken) break;
    }
    if (pageToken) log.warn(`[GmeetCalendar] calendar window holds more than ${MAX_EVENT_PAGES * 250} events; the newest are not listed`);
    return /** @type {any[]} */ (items.map(formatMeetEvent).filter(Boolean));
}

/**
 * The user's upcoming Meet meetings within `windowHours`.
 * Returns [{ eventId, iCalUID, title, start, end, organizerEmail,
 * organizerSelf, attendees, meetingCode, meetLink }]. Errors propagate so
 * callers can classify not-connected vs transient failures.
 * @param {{ session?: object, windowHours?: number }} [opts]
 */
async function listUpcomingMeetMeetings({ session, windowHours = 48 } = {}) {
    const now = Date.now();
    return listMeetEvents(session, {
        timeMin: new Date(now),
        timeMax: new Date(now + windowHours * 3600_000),
    });
}

/**
 * Meet meetings that ENDED within `lookbackHours`, at least `graceMinutes`
 * ago (Meet artifacts appear "soon after" the end — the grace period avoids
 * hammering conferenceRecords for meetings that just wrapped up). Ongoing
 * meetings (end in the future) are excluded. Same row shape as above.
 * @param {{ session?: object, lookbackHours?: number, graceMinutes?: number }} [opts]
 */
async function listRecentlyEndedMeetMeetings({ session, lookbackHours = 24, graceMinutes = 5 } = {}) {
    const now = Date.now();
    const floor = now - lookbackHours * 3600_000;
    const meetings = await listMeetEvents(session, {
        timeMin: new Date(floor),
        timeMax: new Date(now),
    });
    const cutoff = now - graceMinutes * 60_000;
    return meetings.filter((/** @type {{ end: string | number | Date; }} */ m) => {
        const end = m.end ? new Date(m.end).getTime() : NaN;
        return Number.isFinite(end) && end <= cutoff && end >= floor;
    });
}

module.exports = { extractMeetCode, listUpcomingMeetMeetings, listRecentlyEndedMeetMeetings };
