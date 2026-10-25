// @typecheck strict
'use strict';

/**
 * How many people take part in a Talk meeting — the sources that both the Scheduled
 * LIST and the recording ENGINE have.
 *
 * ── WHY THIS IS A SHARED MODULE ──────────────────────────────────────
 * The list and the engine made the same decision with OTHER data. The
 * route only counted with the calendar (`participantCountOf(m)`); the engine had
 * that calendar PLUS the conversation type PLUS a live count from Talk. With a calendar
 * appointment without ATTENDEE lines — the usual "Talk room with a shared
 * link" form — the route said `unknown_size` → toggle OFF, while the
 * engine counted four participants and RECORDED. The screen said the opposite of
 * what the server did, in a privacy product. This module is the half that
 * BOTH sides can know; what only the engine can know (the live count)
 * is explicitly outside it, and that difference is carried by the route as
 * `recordDecided: false` to the screen instead of as a silent "off".
 *
 * ── THE SCOPE DECIDES WHETHER THE CALENDAR COUNTS ────────────────────
 * With `autoRecordScope: 'all'` the engine does not look at the calendar
 * (talkAutoRecord fills `calendarByToken` only in calendar scope). An invitation with six
 * invitees would then show "Will record" on the screen while the engine decides on the live count. So: in scope 'all' the
 * calendar does not count here either.
 *
 * ── UNKNOWN NARROWS ──────────────────────────────────────────────────
 * `null` is "we do not know", never "zero". `decideRecord` makes
 * `record: false, reason: 'unknown_size'` of that — unknown does not count as "more
 * than two".
 */

/**
 * The participant count that can be established WITHOUT an extra Talk call.
 *
 * @param {object} p
 * @param {any|null} p.room      a row from `nextcloud_talk_list_rooms`
 * @param {any|null} p.meeting   the calendar appointment (talkCalendar), or null
 * @param {string} p.autoRecordScope 'calendar' | 'all'
 * @returns {number|null} the count, or null if it cannot be known from here
 */
function knownParticipantCount({ room = null, meeting = null, autoRecordScope = 'calendar' } = /** @type {any} */ ({})) {
    const meetingPrefs = require('../../stores/meetingPrefsStore');

    // 1. The calendar — but only if the engine looks at it too.
    if (autoRecordScope !== 'all') {
        const fromCalendar = meetingPrefs.participantCountOf(meeting);
        if (fromCalendar !== null) return fromCalendar;
    }

    // 2. The conversation type. A Talk room of type 1 is by definition a
    //    one-on-one; the route knows that just as well as the engine, because both
    //    already have the room list in hand.
    if (room && room.type === 1) return 2;

    return null;
}

module.exports = { knownParticipantCount };
