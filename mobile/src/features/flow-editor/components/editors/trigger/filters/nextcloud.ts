/**
 * The Nextcloud filters — the web's NextcloudFileFilterFields,
 * NextcloudShareFilterFields, NextcloudActivityFilterFields,
 * NextcloudNotificationFilterFields, NextcloudFormsSubmittedFilterFields,
 * NextcloudTablesRowFilterFields, NextcloudTagFilterFields and
 * NextcloudCalendarMutationFilterFields.
 */

import { msg } from '@/features/flow-editor/components/editors/declarative/spec';

import { filterNote, numberFilter, raw, selectFilter, textFilter, tickFilter, type FilterForm } from './fields';

const NAME_CONTAINS = msg('mobile.flow.filter.name_contains', 'Name contains');
const ACTOR = msg('mobile.flow.filter.actor_equals', 'Actor equals');
const NC_USER_ID = msg('mobile.flow.filter.nc_user_id', 'Nextcloud user id.');

export const NEXTCLOUD_FILE: FilterForm = {
    title: msg('mobile.flow.filter.nc_file_title', 'Nextcloud file filter (all optional)'),
    fields: [
        textFilter('inFolder', msg('mobile.flow.filter.in_folder', 'In folder'), {
            example: '/Invoices',
            hint: msg('mobile.flow.filter.in_folder_hint', 'Path prefix, e.g. /Invoices. Files outside this folder are skipped.'),
        }),
        textFilter('extension', msg('mobile.flow.filter.extension', 'Extension'), {
            example: 'pdf',
            hint: msg('mobile.flow.filter.extension_hint', 'Without dot, e.g. pdf.'),
        }),
        textFilter('nameContains', NAME_CONTAINS),
        tickFilter(
            'excludeOwnUploads',
            msg('mobile.flow.filter.exclude_own_actions', 'Exclude my own actions'),
            msg('mobile.flow.filter.exclude_own_actions_box', 'Skip files I created/edited'),
        ),
        filterNote(
            'manualRuns',
            msg(
                'mobile.flow.filter.nc_file_manual_note',
                'Manual runs use a null trigger payload — set a sample under Settings → Manual trigger payload to test bindings.',
            ),
        ),
    ],
};

export const NEXTCLOUD_SHARE: FilterForm = {
    title: msg('mobile.flow.filter.nc_share_title', 'Nextcloud share.received filter'),
    fields: [
        textFilter('actorEquals', msg('mobile.flow.filter.sharer', 'Sharer (actor) equals'), {
            hint: msg('mobile.flow.filter.sharer_hint', 'Nextcloud username (uid) of the person who shared the item.'),
        }),
        selectFilter('kindEquals', msg('mobile.flow.filter.kind', 'Kind'), [
            { value: '', label: msg('mobile.flow.filter.any_file_or_folder', 'Any (file or folder)') },
            raw('file'),
            raw('folder'),
        ]),
        textFilter('nameContains', NAME_CONTAINS),
    ],
};

export const NEXTCLOUD_ACTIVITY: FilterForm = {
    title: msg('mobile.flow.filter.nc_activity_title', 'Nextcloud activity filter (advanced)'),
    fields: [
        textFilter('type', msg('mobile.flow.filter.activity_type', 'Activity type'), {
            example: 'comments',
            hint: msg(
                'mobile.flow.filter.activity_type_hint',
                'Raw activity slug (e.g. file_created, comments, deck). Leave empty to match every type — and prefer file.new / file.changed / share.received as dedicated triggers.',
            ),
        }),
        textFilter('objectNameContains', msg('mobile.flow.filter.object_name_contains', 'Object name contains')),
        textFilter('actorEquals', ACTOR),
    ],
};

export const NEXTCLOUD_NOTIFICATION: FilterForm = {
    title: msg('mobile.flow.filter.nc_notification_title', 'Nextcloud notification filter'),
    fields: [
        textFilter('app', msg('mobile.flow.filter.app', 'App'), {
            example: 'spreed',
            hint: msg('mobile.flow.filter.app_hint', 'Source app id (e.g. spreed, files_sharing, dav, updatenotification).'),
        }),
        textFilter('subjectContains', msg('mobile.flow.filter.subject_contains', 'Subject contains')),
    ],
};

export const NEXTCLOUD_FORMS_SUBMITTED: FilterForm = {
    title: msg('mobile.flow.filter.nc_forms_title', 'Nextcloud form filter (all optional)'),
    fields: [
        numberFilter('formId', msg('mobile.flow.filter.form_id', 'Form ID'), {
            example: '51',
            hint: msg('mobile.flow.filter.form_id_hint', 'Numeric id — leave empty to fire for every form you can see. Find it with the “List forms” action.'),
        }),
        textFilter('formHash', msg('mobile.flow.filter.form_hash', 'Form hash'), {
            example: 'abc123def456',
            hint: msg('mobile.flow.filter.form_hash_hint', "The token in the form's share link — an alternative to the numeric id."),
        }),
        textFilter('titleContains', msg('mobile.flow.filter.title_contains', 'Title contains')),
        textFilter('submittedByEquals', msg('mobile.flow.filter.submitted_by', 'Submitted by'), {
            hint: msg('mobile.flow.filter.submitted_by_hint', 'Nextcloud user id. Anonymous submissions have no user, so this never matches them.'),
        }),
        filterNote(
            'answersNote',
            msg(
                'mobile.flow.filter.nc_forms_note',
                'The answers are not in the trigger payload — follow this with the Get form submissions action, and give it Trigger ▸ Form id and Trigger ▸ Submission id with Insert data.',
            ),
        ),
    ],
};

export const NEXTCLOUD_TABLES_ROW: FilterForm = {
    title: msg('mobile.flow.filter.nc_tables_title', 'Nextcloud Tables row filter (all optional)'),
    fields: [
        numberFilter('tableId', msg('mobile.flow.filter.table_id', 'Table ID'), {
            example: '34',
            hint: msg('mobile.flow.filter.table_id_hint', 'Numeric id — find it with the “List tables” action.'),
        }),
        numberFilter('columnId', msg('mobile.flow.filter.column_id', 'Column ID'), {
            example: '13',
            hint: msg(
                'mobile.flow.filter.column_id_hint',
                'Numeric column id to test a value against — from “List table columns”. The event carries column ids, not titles.',
            ),
        }),
        textFilter('valueEquals', msg('mobile.flow.filter.value_equals', 'Value equals'), { example: 'approved' }),
        textFilter('valueContains', msg('mobile.flow.filter.value_contains', 'Value contains')),
        tickFilter(
            'changedOnly',
            msg('mobile.flow.filter.changed_only', 'Only when that column changed'),
            msg('mobile.flow.filter.changed_only_box', 'Ignore edits that left this column alone'),
        ),
        filterNote(
            'changedOnlyHint',
            msg(
                'mobile.flow.filter.changed_only_hint',
                'Row updates fire on any edit. Tick this to fire only when the column above actually changed value.',
            ),
        ),
        textFilter('actorEquals', msg('mobile.flow.filter.changed_by', 'Changed by'), { hint: NC_USER_ID }),
    ],
};

export const NEXTCLOUD_TAG: FilterForm = {
    title: msg('mobile.flow.filter.nc_tag_title', 'Nextcloud tag filter (all optional)'),
    fields: [
        numberFilter('tagId', msg('mobile.flow.filter.tag_id', 'Tag ID'), {
            example: '3',
            hint: msg('mobile.flow.filter.tag_id_hint', "Numeric id — from the “List tags” action. Nextcloud's tag event carries ids only, never the tag name."),
        }),
        filterNote(
            'pathNote',
            msg(
                'mobile.flow.filter.nc_tag_note',
                'The event carries no file path either — follow it with a Files action given Trigger ▸ File id (Insert data) if you need the path or contents.',
            ),
        ),
    ],
};

export const NEXTCLOUD_CALENDAR: FilterForm = {
    title: msg('mobile.flow.filter.nc_calendar_title', 'Nextcloud calendar filter (all optional)'),
    fields: [
        numberFilter('calendarId', msg('mobile.flow.filter.calendar_id_numeric', 'Calendar ID'), {
            hint: msg('mobile.flow.filter.calendar_id_numeric_hint', 'Numeric id of the calendar. Leave empty for all calendars.'),
        }),
        filterNote(
            'metadataNote',
            msg(
                'mobile.flow.filter.nc_calendar_note',
                "Nextcloud's calendar webhook carries object metadata only — there is no summary, start or end in it, so those cannot be filtered on here. Follow the trigger with Get calendar event to read the actual event, or use Calendar event upcoming if you want to match on the title.",
            ),
        ),
    ],
};
