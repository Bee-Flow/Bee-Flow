/**
 * `<provider>.<event>` → its filter form, the web's FILTER_FORM_BY_KEY
 * (triggerFilters.jsx), in the web's order. A combination with no form shows
 * none: the runtime still applies the stored filter. Pinned by
 * triggerFilters.lockstep.test.ts.
 */

import type { FilterForm } from './fields';
import { CALENDAR_CHANGED, CALENDAR_UPCOMING, DRIVE_FILE_NEW, GMAIL, GMAIL_LABEL } from './google';
import {
    NEXTCLOUD_ACTIVITY,
    NEXTCLOUD_CALENDAR,
    NEXTCLOUD_FILE,
    NEXTCLOUD_FORMS_SUBMITTED,
    NEXTCLOUD_NOTIFICATION,
    NEXTCLOUD_SHARE,
    NEXTCLOUD_TABLES_ROW,
    NEXTCLOUD_TAG,
} from './nextcloud';
import { MEETING_NOTES_PROCESSED, SUPPORT_TICKET_RESOLVED } from './other';

export const FILTER_FORMS: Readonly<Record<string, FilterForm>> = {
    'gmail.mail.new': GMAIL,
    'gmail.label.added': GMAIL_LABEL,
    'google-calendar.event.changed': CALENDAR_CHANGED,
    'google-calendar.event.upcoming': CALENDAR_UPCOMING,
    'google-drive.file.new': DRIVE_FILE_NEW,
    'nextcloud.file.new': NEXTCLOUD_FILE,
    'nextcloud.file.changed': NEXTCLOUD_FILE,
    'nextcloud.file.deleted': NEXTCLOUD_FILE,
    'nextcloud.file.renamed': NEXTCLOUD_FILE,
    'nextcloud.file.tagged': NEXTCLOUD_TAG,
    'nextcloud.file.untagged': NEXTCLOUD_TAG,
    'nextcloud.forms.submitted': NEXTCLOUD_FORMS_SUBMITTED,
    'nextcloud.tables.row.added': NEXTCLOUD_TABLES_ROW,
    'nextcloud.tables.row.updated': NEXTCLOUD_TABLES_ROW,
    'nextcloud.calendar.event.created': NEXTCLOUD_CALENDAR,
    'nextcloud.calendar.event.changed': NEXTCLOUD_CALENDAR,
    'nextcloud.share.received': NEXTCLOUD_SHARE,
    'nextcloud.activity.new': NEXTCLOUD_ACTIVITY,
    'nextcloud.notification.new': NEXTCLOUD_NOTIFICATION,
    'support.ticket.resolved': SUPPORT_TICKET_RESOLVED,
    'meeting-notes.meeting.processed': MEETING_NOTES_PROCESSED,
};

/** The form for a provider's event, or null. */
export function filterFormFor(provider: string, event: string): FilterForm | null {
    const key = `${provider}.${event}`;
    return Object.prototype.hasOwnProperty.call(FILTER_FORMS, key) ? (FILTER_FORMS[key] as FilterForm) : null;
}

export type { FilterForm } from './fields';
export { filterOf, putFilter, splitList } from './fields';
