// @typecheck
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

const { createGoogleApiClient } = require('../../integrations/googleClient');

// Meet codes are three dash-separated lowercase groups (3-4-3), e.g.
// `abc-defg-hij`. Accept full meet.google.com URLs (with or without scheme,
// query, trailing path) and bare codes; anything else → null.
const MEET_LINK_RE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z-])/i;
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

function extractMeetCode(url) {
    if (!url) return null;
    const s = String(url).trim();
    if (MEET_CODE_RE.test(s)) return s.toLowerCase();
    const m = s.match(MEET_LINK_RE);
    return m ? m[1].toLowerCase() : null;
}

function formatMeetEvent(event) {
    const meetLink = event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || null;
    const meetingCode = extractMeetCode(meetLink);
    if (!meetingCode) return null;
    return {
        eventId: event.id,
        iCalUID: event.iCalUID || null,
        title: event.summary || '(no title)',
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        organizerEmail: event.organizer?.email || null,
        organizerSelf: event.organizer?.self === true,
        attendees: (event.attendees || []).map(a => ({
            email: a.email,
            displayName: a.displayName || null,
            self: a.self === true,
        })),
        meetingCode,
        meetLink,
    };
}

async function listMeetEvents(session, { timeMin, timeMax }) {
    const calendar = await createGoogleApiClient(session, {
        api: 'calendar',
        version: 'v3',
        notConnectedError: 'Not connected to Google — user must log in with Google',
    });
    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
    });
    return (response.data?.items || []).map(formatMeetEvent).filter(Boolean);
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
    return meetings.filter((m) => {
        const end = m.end ? new Date(m.end).getTime() : NaN;
        return Number.isFinite(end) && end <= cutoff && end >= floor;
    });
}

module.exports = { extractMeetCode, listUpcomingMeetMeetings, listRecentlyEndedMeetMeetings };
