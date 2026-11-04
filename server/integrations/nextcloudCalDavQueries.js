// @typecheck strict
/**
 * The CalDAV request bodies of the Nextcloud calendar tools
 * (./nextcloudCalendarTools.js): the PROPFIND that lists calendars and the
 * calendar-query REPORT that lists events.
 */

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
    <oc:owner-principal/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`;

/**
 * A calendar-query REPORT. With a range, the server is asked to EXPAND
 * recurring events (RFC 4791 9.6.5): without it, a series matches when any of
 * its occurrences falls in the range, but comes back as the stored master
 * VEVENT, so a weekly meeting created in January was listed with its January
 * start. Expanded, every occurrence in the range is its own VEVENT (in UTC,
 * with a RECURRENCE-ID), moved occurrences included.
 * @param {string | null} rangeStart
 * @param {string | null} rangeEnd
 */
function calendarQueryReport(rangeStart, rangeEnd) {
    const hasRange = !!(rangeStart && rangeEnd);
    const range = hasRange
        ? `<c:time-range start="${rangeStart}" end="${rangeEnd}"/>`
        : '';
    const calendarData = hasRange
        ? `<c:calendar-data><c:expand start="${rangeStart}" end="${rangeEnd}"/></c:calendar-data>`
        : '<c:calendar-data/>';
    return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    ${calendarData}
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">${range}</c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

module.exports = { PROPFIND_CALENDARS, calendarQueryReport };
