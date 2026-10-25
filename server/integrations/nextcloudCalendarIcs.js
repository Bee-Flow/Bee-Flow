// @typecheck noImplicitAny
'use strict';
/**
 * ICS building and in-place editing for the Nextcloud calendar tools.
 *
 * `buildVCalendarEvent` writes a new event. `updateVCalendarEvent` edits the
 * stored ICS in place, so everything the caller did not mention (RRULE/EXDATE,
 * VALARM, ORGANIZER, STATUS, CATEGORIES, X- properties, attendee PARTSTAT and
 * ROLE, the original TZID, VTIMEZONE) survives the PUT.
 *
 * Input problems throw `CalendarInputError`; the tool turns those into
 * `{ error }` and lets anything else propagate.
 */

// ical.js ships ESM-shaped types that do not describe its CommonJS export.
/** @type {any} */
const ICAL = require('ical.js');

class CalendarInputError extends Error {}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const HOUR_MS = 3600_000;

/**
 * @param {string} value
 * @param {string} label
 * @returns {Date}
 */
function parseInstant(value, label) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new CalendarInputError(`Invalid ${label}: ${value}`);
    return d;
}

/**
 * A date-only ICAL time. A literal YYYY-MM-DD prefix is taken as written (the
 * caller's calendar day); anything else is read as an instant, in UTC.
 * @param {string} value
 * @param {string} label
 */
function parseDay(value, label) {
    const m = DAY_RE.exec(String(value));
    if (m) return ICAL.Time.fromDateString(`${m[1]}-${m[2]}-${m[3]}`);
    return ICAL.Time.fromDateString(parseInstant(value, label).toISOString().slice(0, 10));
}

/** @param {string} value @param {string} label */
function parseTimed(value, label) {
    return ICAL.Time.fromJSDate(parseInstant(value, label), true);
}

/**
 * @param {any} t
 * @param {number} days
 */
function plusDays(t, days) {
    const c = t.clone();
    c.adjust(days, 0, 0, 0);
    return c;
}

/**
 * Resolve start/end for a new event. All-day ends are exclusive in iCal, so a
 * missing end, or an end on the start day, becomes start + 1 day.
 * @param {{ start: string, end?: string, allDay?: boolean }} range
 */
function resolveRange({ start, end, allDay }) {
    if (allDay) {
        const s = parseDay(start, 'start');
        let e = end ? parseDay(end, 'end') : plusDays(s, 1);
        if (e.compare(s) === 0) e = plusDays(s, 1);
        if (e.compare(s) < 0) throw new CalendarInputError('end must be after start');
        return { startTime: s, endTime: e };
    }
    const s = parseTimed(start, 'start');
    const e = end ? parseTimed(end, 'end') : ICAL.Time.fromJSDate(new Date(s.toJSDate().getTime() + HOUR_MS), true);
    if (e.toUnixTime() < s.toUnixTime()) throw new CalendarInputError('end must not be before start');
    return { startTime: s, endTime: e };
}

/** @param {any} vevent @param {string} email */
function addAttendee(vevent, email) {
    const prop = new ICAL.Property('attendee', vevent);
    prop.setParameter('role', 'REQ-PARTICIPANT');
    prop.setParameter('partstat', 'NEEDS-ACTION');
    prop.setValue(`mailto:${email}`);
    vevent.addProperty(prop);
}

/** @param {any} vevent @param {Record<string, string | undefined | null>} fields */
function applyTextFields(vevent, fields) {
    for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (value === null || value === '') vevent.removeAllProperties(name);
        else vevent.updatePropertyWithValue(name, value);
    }
}

/**
 * @param {{ uid: string, summary?: string, start: string, end?: string, description?: string,
 *   location?: string, attendees?: string[], allDay?: boolean }} ev
 */
function buildVCalendarEvent({ uid, summary, start, end, description, location, attendees, allDay }) {
    const { startTime, endTime } = resolveRange({ start, end, allDay });
    const cal = new ICAL.Component(['vcalendar', [], []]);
    cal.updatePropertyWithValue('prodid', '-//Bee Flow//Nextcloud Calendar Tool//EN');
    cal.updatePropertyWithValue('version', '2.0');
    cal.updatePropertyWithValue('calscale', 'GREGORIAN');

    const vevent = new ICAL.Component('vevent');
    const event = new ICAL.Event(vevent);
    event.uid = uid;
    applyTextFields(vevent, { summary, description, location });
    event.startDate = startTime;
    event.endDate = endTime;
    vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));

    if (Array.isArray(attendees)) {
        for (const a of attendees) if (a) addAttendee(vevent, String(a));
    }

    cal.addSubcomponent(vevent);
    return cal.toString();
}

/**
 * Attendee list: keep the ones still wanted (with their state), drop the rest, add new ones.
 * @param {import('ical.js').Component} vevent
 * @param {string[]} wanted
 */
function syncAttendees(vevent, wanted) {
    const want = new Map(wanted.filter(Boolean).map((a) => [String(a).toLowerCase(), String(a)]));
    for (const prop of vevent.getAllProperties('attendee')) {
        const email = String(prop.getFirstValue() || '').replace(/^mailto:/i, '').toLowerCase();
        if (want.has(email)) want.delete(email);
        else vevent.removeProperty(prop);
    }
    for (const email of want.values()) addAttendee(vevent, email);
}

/**
 * Wall-clock time of a UTC instant in an IANA zone, as a floating ICAL time.
 * Returns null when the zone name is unknown to the runtime.
 * @param {any} utcTime @param {string} tzid
 */
function wallClockIn(utcTime, tzid) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(utcTime.toJSDate());
        /** @param {string} type */
        const n = (type) => Number(parts.find((p) => p.type === type)?.value);
        return new ICAL.Time({ year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute'), second: n('second') });
    } catch (_) {
        return null;
    }
}

/**
 * Write a new DTSTART/DTEND. A stored TZID is kept: the instant is converted to
 * that zone's wall-clock time, so recurrence, EXDATE and DST keep their meaning.
 * @param {any} vevent @param {'dtstart' | 'dtend'} name @param {any} time
 */
function writeTime(vevent, name, time) {
    const event = new ICAL.Event(vevent);
    const setter = name === 'dtstart' ? 'startDate' : 'endDate';
    const tzid = vevent.getFirstProperty(name)?.getParameter('tzid');
    const local = tzid && !time.isDate ? wallClockIn(time, tzid) : null;
    event[setter] = local || time;
    if (local) vevent.getFirstProperty(name).setParameter('tzid', tzid);
}

/**
 * New start/end for an update; only what changes is returned.
 * @param {import('ical.js').Event} event
 * @param {{ summary?: string; description?: string; location?: string; start?: string; end?: string; attendees?: string[]; allDay?: boolean; }} patch
 */
function resolveUpdateRange(event, patch) {
    const wasAllDay = !!event.startDate.isDate;
    const allDay = patch.allDay === undefined ? wasAllDay : !!patch.allDay;
    if (allDay !== wasAllDay && patch.start === undefined) {
        throw new CalendarInputError('start is required to change allDay');
    }
    if (patch.start === undefined && patch.end === undefined) return {};
    const oldSpan = event.endDate.toUnixTime() - event.startDate.toUnixTime();
    let startTime = event.startDate;
    if (patch.start !== undefined) startTime = allDay ? parseDay(patch.start, 'start') : parseTimed(patch.start, 'start');
    let endTime;
    if (patch.end !== undefined) {
        endTime = allDay ? parseDay(patch.end, 'end') : parseTimed(patch.end, 'end');
    } else if (allDay !== wasAllDay) {
        endTime = allDay ? plusDays(startTime, 1) : ICAL.Time.fromJSDate(new Date(startTime.toJSDate().getTime() + HOUR_MS), true);
    } else {
        endTime = startTime.clone();
        endTime.fromUnixTime(startTime.toUnixTime() + oldSpan);
        endTime.isDate = allDay;
    }
    if (allDay && endTime.compare(startTime) === 0) endTime = plusDays(startTime, 1);
    if (endTime.toUnixTime() < startTime.toUnixTime()) throw new CalendarInputError('end must not be before start');
    return { startTime: patch.start !== undefined ? startTime : undefined, endTime };
}

/**
 * Apply `patch` to the first (master) VEVENT of `icsText` and return the new ICS.
 * An undefined field is left alone; an empty string clears a text field.
 * @param {string} icsText
 * @param {{ summary?: string, description?: string, location?: string, start?: string,
 *   end?: string, attendees?: string[], allDay?: boolean }} patch
 */
function updateVCalendarEvent(icsText, patch) {
    let root;
    try {
        root = new ICAL.Component(ICAL.parse(icsText));
    } catch (_) {
        throw new CalendarInputError('Could not read the stored event');
    }
    const vevents = root.getAllSubcomponents('vevent');
    const vevent = vevents.find((/** @type {import('ical.js').Component} */ v) => !v.hasProperty('recurrence-id')) || vevents[0];
    if (!vevent) throw new CalendarInputError('No VEVENT found in the stored event');
    const event = new ICAL.Event(vevent);

    const { startTime, endTime } = resolveUpdateRange(event, patch);
    const timeChanged = !!(startTime || endTime);
    if (timeChanged && (vevent.hasProperty('exdate') || vevents.some((/** @type {import('ical.js').Component} */ v) => v !== vevent && v.hasProperty('recurrence-id')))) {
        throw new CalendarInputError('Moving a series with exceptions is not supported; change the exceptions in Nextcloud.');
    }
    applyTextFields(vevent, { summary: patch.summary, description: patch.description, location: patch.location });
    if (startTime) writeTime(vevent, 'dtstart', startTime);
    if (endTime) writeTime(vevent, 'dtend', endTime);
    if (Array.isArray(patch.attendees)) syncAttendees(vevent, patch.attendees);
    if (timeChanged) {
        vevent.updatePropertyWithValue('sequence', Number(vevent.getFirstPropertyValue('sequence') || 0) + 1);
        vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
    }
    vevent.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true));
    return root.toString();
}

module.exports = { CalendarInputError, buildVCalendarEvent, updateVCalendarEvent };
