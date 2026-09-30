/**
 * The Google filters: Gmail's new mail and label added, Google Calendar's
 * changed and upcoming event, and Drive's new file — the web's
 * GmailFilterFields, GmailLabelFilterFields, CalendarChangedFilterFields,
 * CalendarUpcomingFilterFields and DriveFileNewFilterFields.
 */

import { msg } from '@/features/flow-editor/components/editors/declarative/spec';

import { ANY, listFilter, numberFilter, raw, selectFilter, textFilter, tickFilter, type FilterForm } from './fields';

const FROM = msg('mobile.flow.filter.from_contains', 'From contains');
const SUBJECT = msg('mobile.flow.filter.subject_contains', 'Subject contains');
const CALENDAR_ID = msg('mobile.flow.filter.calendar_id', 'Calendar id');
const ATTENDEE = msg('mobile.flow.filter.attendee_contains', 'Attendee email contains');
const NAME_CONTAINS = msg('mobile.flow.filter.name_contains', 'Name contains');

export const GMAIL: FilterForm = {
    title: msg('mobile.flow.filter.gmail_title', 'Gmail filter (all optional, AND across keys)'),
    fields: [
        textFilter('from', FROM, { example: 'boss@example.com' }),
        textFilter('to', msg('mobile.flow.filter.to_contains', 'To contains')),
        textFilter('subjectContains', SUBJECT),
        textFilter('subjectRegex', msg('mobile.flow.filter.subject_regex', 'Subject regex'), {
            hint: msg('mobile.flow.filter.subject_regex_hint', 'JS regex. Capped at 200 chars; invalid patterns fail closed.'),
        }),
        tickFilter('hasAttachment', msg('mobile.flow.filter.has_attachment', 'Has attachment'), msg('mobile.flow.filter.has_attachment_box', 'Only emails with attachments')),
        tickFilter('excludeFromSelf', msg('mobile.flow.filter.exclude_self', 'Exclude self-sent'), msg('mobile.flow.filter.exclude_self_box', 'Skip emails I sent')),
        numberFilter('maxAgeMinutes', msg('mobile.flow.filter.max_age', 'Max age (minutes)'), {
            min: 1,
            hint: msg(
                'mobile.flow.filter.max_age_hint',
                "Drop messages older than this. Useful so a long-paused poller doesn't flood with backlog on resume.",
            ),
        }),
    ],
};

export const GMAIL_LABEL: FilterForm = {
    title: msg('mobile.flow.filter.gmail_label_title', 'Gmail label.added filter (labelId is required)'),
    fields: [
        textFilter('labelId', msg('mobile.flow.filter.label_id', 'Label id'), {
            example: 'Label_3',
            hint: msg(
                'mobile.flow.filter.label_id_hint',
                'Gmail label ids look like Label_3 or system ids like IMPORTANT / STARRED. Use a gmail_search step once to find the id if needed.',
            ),
        }),
        textFilter('from', FROM),
        textFilter('subjectContains', SUBJECT),
        listFilter('excludeLabelIds', msg('mobile.flow.filter.exclude_labels', 'Exclude labels'), {
            hint: msg('mobile.flow.filter.exclude_labels_hint', 'Drops messages that already carry any of these labels.'),
        }),
    ],
};

export const CALENDAR_CHANGED: FilterForm = {
    title: msg('mobile.flow.filter.calendar_changed_title', 'Calendar event.changed filter (all optional)'),
    fields: [
        textFilter('calendarId', CALENDAR_ID, {
            example: 'primary',
            hint: msg('mobile.flow.filter.calendar_id_hint', "Default 'primary'. Use a different calendar id if you've connected secondary calendars."),
        }),
        selectFilter('statusEquals', msg('mobile.flow.filter.status', 'Status'), [ANY, raw('confirmed'), raw('cancelled'), raw('tentative')]),
        textFilter('attendeeEmailContains', ATTENDEE),
    ],
};

export const CALENDAR_UPCOMING: FilterForm = {
    title: msg('mobile.flow.filter.calendar_upcoming_title', 'Calendar event.upcoming filter'),
    fields: [
        numberFilter('leadMinutes', msg('mobile.flow.filter.lead_minutes', 'Lead minutes'), {
            min: 1,
            max: 240,
            shown: 15,
            hint: msg('mobile.flow.filter.lead_minutes_hint', 'Fire this many minutes before the event starts. Default 15.'),
        }),
        textFilter('calendarId', CALENDAR_ID, { example: 'primary' }),
        tickFilter(
            'includeAllDay',
            msg('mobile.flow.filter.include_all_day', 'Include all-day events'),
            msg('mobile.flow.filter.include_all_day_box', 'Yes — fire on all-day events too'),
        ),
        textFilter('attendeeEmailContains', ATTENDEE),
    ],
};

export const DRIVE_FILE_NEW: FilterForm = {
    title: msg('mobile.flow.filter.drive_title', 'Drive file.new filter (all optional)'),
    fields: [
        textFilter('folderId', msg('mobile.flow.filter.folder_id', 'Folder id'), {
            hint: msg(
                'mobile.flow.filter.folder_id_hint',
                'Drive folder id. Find via drive_search or by copying from the URL: drive.google.com/drive/folders/<id>.',
            ),
        }),
        textFilter('mimeType', msg('mobile.flow.filter.mime_type', 'MIME type'), {
            example: 'application/pdf',
            hint: msg('mobile.flow.filter.mime_type_hint', 'e.g. application/pdf, image/jpeg, application/vnd.google-apps.document.'),
        }),
        textFilter('nameContains', NAME_CONTAINS),
        tickFilter(
            'excludeOwnUploads',
            msg('mobile.flow.filter.exclude_own_uploads', 'Exclude my own uploads'),
            msg('mobile.flow.filter.exclude_own_uploads_box', 'Skip files I uploaded'),
        ),
    ],
};
