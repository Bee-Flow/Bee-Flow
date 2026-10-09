/**
 * The Google filters: Gmail's new mail and label added, Google Calendar's
 * changed and upcoming event, Drive's new file and a changed spreadsheet —
 * the web's GmailFilterFields, GmailLabelFilterFields,
 * CalendarChangedFilterFields, CalendarUpcomingFilterFields,
 * DriveFileNewFilterFields and SheetsChangedFilterFields.
 */

import { msg } from '@/features/flow-editor/components/editors/declarative/spec';

import { ANY, filterNote, filterOf, listFilter, numberFilter, raw, selectFilter, textFilter, tickFilter, type FilterForm } from './fields';

const FROM = msg('automations.trigger_filters.from_contains', 'From contains');
const SUBJECT = msg('automations.trigger_filters.subject_contains', 'Subject contains');
const CALENDAR_ID = msg('automations.trigger_filters.calendar_id', 'Calendar id');
const ATTENDEE = msg('automations.trigger_filters.attendee_email_contains', 'Attendee email contains');
const NAME_CONTAINS = msg('automations.trigger_filters.name_contains', 'Name contains');

export const GMAIL: FilterForm = {
    title: msg('automations.trigger_filters.gmail_filter_all_optional_and_across', 'Gmail filter (all optional, AND across keys)'),
    fields: [
        textFilter('from', FROM, { example: 'boss@example.com' }),
        textFilter('to', msg('automations.trigger_filters.to_contains', 'To contains')),
        textFilter('subjectContains', SUBJECT),
        textFilter('subjectRegex', msg('automations.trigger_filters.subject_regex', 'Subject regex'), {
            hint: msg('automations.trigger_filters.js_regex_capped_at_200_chars', 'JS regex. Capped at 200 chars; invalid patterns fail closed.'),
        }),
        tickFilter('hasAttachment', msg('automations.trigger_filters.has_attachment', 'Has attachment'), msg('automations.trigger_filters.only_emails_with_attachments', 'Only emails with attachments')),
        tickFilter('excludeFromSelf', msg('automations.trigger_filters.exclude_self_sent', 'Exclude self-sent'), msg('automations.trigger_filters.skip_emails_i_sent', 'Skip emails I sent')),
        numberFilter('maxAgeMinutes', msg('automations.trigger_filters.max_age_minutes', 'Max age (minutes)'), {
            min: 1,
            hint: msg(
                'automations.trigger_filters.drop_messages_older_than_this_useful',
                "Drop messages older than this. Useful so a long-paused poller doesn't flood with backlog on resume.",
            ),
        }),
    ],
};

export const GMAIL_LABEL: FilterForm = {
    title: msg('automations.trigger_filters.gmail_label_added_filter_label_id', 'Gmail label.added filter (labelId is required)'),
    fields: [
        textFilter('labelId', msg('automations.trigger_filters.label_id', 'Label id'), {
            example: 'Label_3',
            hint: msg(
                'automations.trigger_filters.gmail_label_ids_look_like_label',
                'Gmail label ids look like Label_3 or system ids like IMPORTANT / STARRED. Use a gmail_search step once to find the id if needed.',
            ),
        }),
        textFilter('from', FROM),
        textFilter('subjectContains', SUBJECT),
        listFilter('excludeLabelIds', msg('automations.trigger_filters.exclude_labels', 'Exclude labels'), {
            hint: msg('automations.trigger_filters.drops_messages_that_already_carry_any', 'Drops messages that already carry any of these labels.'),
        }),
    ],
};

export const CALENDAR_CHANGED: FilterForm = {
    title: msg('automations.trigger_filters.calendar_event_changed_filter_all_optional', 'Calendar event.changed filter (all optional)'),
    fields: [
        textFilter('calendarId', CALENDAR_ID, {
            example: 'primary',
            hint: msg('automations.trigger_filters.default_primary_use_a_different_calendar', "Default 'primary'. Use a different calendar id if you've connected secondary calendars."),
        }),
        selectFilter('statusEquals', msg('automations.trigger_filters.status', 'Status'), [ANY, raw('confirmed'), raw('cancelled'), raw('tentative')]),
        textFilter('attendeeEmailContains', ATTENDEE),
    ],
};

export const CALENDAR_UPCOMING: FilterForm = {
    title: msg('automations.trigger_filters.calendar_event_upcoming_filter', 'Calendar event.upcoming filter'),
    fields: [
        numberFilter('leadMinutes', msg('automations.trigger_filters.lead_minutes', 'Lead minutes'), {
            min: 1,
            max: 240,
            shown: 15,
            hint: msg('automations.trigger_filters.fire_this_many_minutes_before_the', 'Fire this many minutes before the event starts. Default 15.'),
        }),
        textFilter('calendarId', CALENDAR_ID, { example: 'primary' }),
        tickFilter(
            'includeAllDay',
            msg('automations.trigger_filters.include_all_day_events', 'Include all-day events'),
            msg('automations.trigger_filters.yes_fire_on_all_day_events', 'Yes — fire on all-day events too'),
        ),
        textFilter('attendeeEmailContains', ATTENDEE),
    ],
};

export const DRIVE_FILE_NEW: FilterForm = {
    title: msg('automations.trigger_filters.drive_file_new_filter_all_optional', 'Drive file.new filter (all optional)'),
    fields: [
        textFilter('folderId', msg('automations.trigger_filters.folder_id', 'Folder id'), {
            hint: msg(
                'automations.trigger_filters.drive_folder_id_find_via_drive',
                'Drive folder id. Find via drive_search or by copying from the URL: drive.google.com/drive/folders/<id>.',
            ),
        }),
        textFilter('mimeType', msg('automations.trigger_filters.mime_type', 'MIME type'), {
            example: 'application/pdf',
            hint: msg('automations.trigger_filters.e_g_application_pdf_image_jpeg', 'e.g. application/pdf, image/jpeg, application/vnd.google-apps.document.'),
        }),
        textFilter('nameContains', NAME_CONTAINS),
        tickFilter(
            'excludeOwnUploads',
            msg('automations.trigger_filters.exclude_my_own_uploads', 'Exclude my own uploads'),
            msg('automations.trigger_filters.skip_files_i_uploaded', 'Skip files I uploaded'),
        ),
    ],
};

/**
 * Two modes in one form: with a spreadsheet id it watches that sheet's rows,
 * without one it fires whenever any reachable spreadsheet is edited. The
 * closing note only means something in the first mode, so (like the web) it
 * shows only once an id is set.
 */
export const SHEETS_CHANGED: FilterForm = {
    title: msg('automations.trigger_filters.google_sheets_filter_all_optional', 'Google Sheets filter (all optional)'),
    fields: [
        textFilter('spreadsheetId', msg('automations.trigger_filters.spreadsheet_id', 'Spreadsheet ID'), {
            example: '1AbCDeFgHiJkLmNoPqRsTuV',
            hint: msg(
                'automations.trigger_filters.from_the_sheet_url_docs_google',
                "From the sheet URL: docs.google.com/spreadsheets/d/<id>/edit. Set this to watch the sheet's contents row by row; leave empty to fire whenever any of your spreadsheets is edited.",
            ),
        }),
        textFilter('sheet', msg('automations.trigger_filters.sheet_tab', 'Sheet / tab'), {
            example: 'Budget',
            hint: msg('automations.trigger_filters.tab_name_e_g_budget_only', 'Tab name, e.g. Budget. Only with a spreadsheet picked; default is the first tab.'),
        }),
        textFilter('range', msg('automations.trigger_filters.range', 'Range'), {
            example: 'A1:D100',
            hint: msg('automations.trigger_filters.a1_notation_without_the_tab_name', 'A1 notation without the tab name, e.g. A1:D100, or C:C to watch one column. Default: the whole tab.'),
        }),
        {
            ...filterNote(
                'sheetsRowNote',
                msg(
                    'mobile.flow.filter.sheets_row_note',
                    'A changed row fires with row (its values), rowIndex, and the previous value under previous. Row numbers are positions — inserting a row at the top reads as edits to the rows below it.',
                ),
            ),
            visibleWhen: (draft) => !!filterOf(draft).spreadsheetId,
        },
    ],
};
