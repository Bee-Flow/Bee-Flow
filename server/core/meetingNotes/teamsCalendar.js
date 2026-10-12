// @typecheck
/**
 * Microsoft Teams calendar helper — mirror of `gmeetCalendar.js` for Outlook.
 *
 * Lists the user's Outlook calendar events that carry a Teams join link
 * (upcoming for the "Upcoming" view, recently ended for the Teams import
 * poller). Built on `/me/calendarView`, the same endpoint the ms_calendar_*
 * tools read (integrations/msCalendarTools.js), with the timezone pinned to
 * UTC so start/end compare as instants.
 */

const { lazyDeps } = require('./lazyDeps');

/** Collaborators; tests swap them through init(). */
const { deps, init } = lazyDeps({
    graphFetch: () => require('../../integrations/msGraphClient').graphFetch,
});

const TEAMS_JOIN_RE = /^https:\/\/teams\.(microsoft|live)\.com\//i;
const EVENT_FIELDS = [
    'id', 'iCalUId', 'subject', 'start', 'end', 'organizer', 'attendees', 'isOrganizer',
    'isOnlineMeeting', 'onlineMeeting', 'onlineMeetingProvider', 'seriesMasterId', 'isCancelled',
].join(',');
const MAX_PAGES = 3;

/** True for a Teams meeting join URL (work/school or personal Teams). */
function isTeamsJoinUrl(url) {
    return typeof url === 'string' && TEAMS_JOIN_RE.test(url.trim());
}

// calendarView with `Prefer: outlook.timezone="UTC"` returns UTC wall time
// without an offset ("2026-10-01T09:00:00.0000000"); make it an ISO instant.
function utcIso(dateTime) {
    if (!dateTime) return null;
    const s = String(dateTime);
    const iso = /[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function formatTeamsEvent(event) {
    const joinUrl = event?.onlineMeeting?.joinUrl || null;
    if (!isTeamsJoinUrl(joinUrl) || event.isCancelled) return null;
    return {
        eventId: event.id,
        iCalUID: event.iCalUId || null,
        seriesMasterId: event.seriesMasterId || null,
        title: event.subject || '(no title)',
        start: utcIso(event.start?.dateTime),
        end: utcIso(event.end?.dateTime),
        organizerEmail: event.organizer?.emailAddress?.address || null,
        organizerSelf: event.isOrganizer === true,
        attendees: (event.attendees || []).map(a => ({
            email: a.emailAddress?.address || null,
            displayName: a.emailAddress?.name || null,
        })),
        joinUrl,
    };
}

async function listTeamsEvents(session, { timeMin, timeMax }) {
    const out = [];
    let next = `/me/calendarView?startDateTime=${encodeURIComponent(timeMin.toISOString())}`
        + `&endDateTime=${encodeURIComponent(timeMax.toISOString())}`
        + `&$top=100&$orderby=start/dateTime&$select=${EVENT_FIELDS}`;
    for (let page = 0; next && page < MAX_PAGES; page++) {
        const data = await deps.graphFetch(next, session, { headers: { Prefer: 'outlook.timezone="UTC"' } });
        for (const event of data?.value || []) {
            const formatted = formatTeamsEvent(event);
            if (formatted) out.push(formatted);
        }
        next = data?.['@odata.nextLink'] || null;
    }
    return out;
}

/**
 * The user's upcoming Teams meetings within `windowHours`. Errors propagate so
 * callers can tell not-connected from transient failures.
 * @param {{ session?: object, windowHours?: number }} [opts]
 */
async function listUpcomingTeamsMeetings({ session, windowHours = 48 } = {}) {
    const now = Date.now();
    return listTeamsEvents(session, {
        timeMin: new Date(now),
        timeMax: new Date(now + windowHours * 3600_000),
    });
}

/**
 * Teams meetings that ENDED within `lookbackHours`, at least `graceMinutes`
 * ago (the recording is processed after the meeting; asking right away only
 * costs calls). Same row shape as above.
 * @param {{ session?: object, lookbackHours?: number, graceMinutes?: number }} [opts]
 */
async function listRecentlyEndedTeamsMeetings({ session, lookbackHours = 24, graceMinutes = 5 } = {}) {
    const now = Date.now();
    const floor = now - lookbackHours * 3600_000;
    const meetings = await listTeamsEvents(session, {
        timeMin: new Date(floor),
        timeMax: new Date(now),
    });
    const cutoff = now - graceMinutes * 60_000;
    return meetings.filter((m) => {
        const end = m.end ? new Date(m.end).getTime() : NaN;
        return Number.isFinite(end) && end <= cutoff && end >= floor;
    });
}

module.exports = { init, isTeamsJoinUrl, formatTeamsEvent, listUpcomingTeamsMeetings, listRecentlyEndedTeamsMeetings };
