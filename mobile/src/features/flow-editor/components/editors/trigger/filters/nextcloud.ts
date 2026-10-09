/**
 * The Nextcloud filters — the web's NextcloudFileFilterFields,
 * NextcloudShareFilterFields, NextcloudActivityFilterFields,
 * NextcloudNotificationFilterFields, NextcloudFormsSubmittedFilterFields,
 * NextcloudTablesRowFilterFields, NextcloudTagFilterFields and
 * NextcloudCalendarMutationFilterFields.
 */

import { msg } from '@/features/flow-editor/components/editors/declarative/spec';

import { filterNote, numberFilter, raw, selectFilter, textFilter, tickFilter, type FilterForm } from './fields';

const NAME_CONTAINS = msg('automations.trigger_filters.name_contains', 'Name contains');
const ACTOR = msg('automations.trigger_filters.actor_equals', 'Actor equals');
const NC_USER_ID = msg('automations.trigger_filters.nextcloud_user_id', 'Nextcloud user id.');

export const NEXTCLOUD_FILE: FilterForm = {
    title: msg('automations.trigger_filters.nextcloud_file_filter_all_optional', 'Nextcloud file filter (all optional)'),
    fields: [
        textFilter('inFolder', msg('automations.trigger_filters.in_folder', 'In folder'), {
            example: '/Invoices',
            hint: msg('automations.trigger_filters.path_prefix_e_g_invoices_files', 'Path prefix, e.g. /Invoices. Files outside this folder are skipped.'),
        }),
        textFilter('extension', msg('automations.trigger_filters.extension', 'Extension'), {
            example: 'pdf',
            hint: msg('automations.trigger_filters.without_dot_e_g_pdf', 'Without dot, e.g. pdf.'),
        }),
        textFilter('nameContains', NAME_CONTAINS),
        tickFilter(
            'excludeOwnUploads',
            msg('automations.trigger_filters.exclude_my_own_actions', 'Exclude my own actions'),
            msg('automations.trigger_filters.skip_files_i_created_edited', 'Skip files I created/edited'),
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
    title: msg('automations.trigger_filters.nextcloud_share_received_filter', 'Nextcloud share.received filter'),
    fields: [
        textFilter('actorEquals', msg('automations.trigger_filters.sharer_actor_equals', 'Sharer (actor) equals'), {
            hint: msg('automations.trigger_filters.nextcloud_username_uid_of_the_person', 'Nextcloud username (uid) of the person who shared the item.'),
        }),
        selectFilter('kindEquals', msg('automations.trigger_filters.kind', 'Kind'), [
            { value: '', label: msg('automations.trigger_filters.any_file_or_folder', 'Any (file or folder)') },
            raw('file'),
            raw('folder'),
        ]),
        textFilter('nameContains', NAME_CONTAINS),
    ],
};

export const NEXTCLOUD_ACTIVITY: FilterForm = {
    title: msg('automations.trigger_filters.nextcloud_activity_filter_advanced', 'Nextcloud activity filter (advanced)'),
    fields: [
        textFilter('type', msg('automations.trigger_filters.activity_type', 'Activity type'), {
            example: 'comments',
            hint: msg(
                'automations.trigger_filters.raw_activity_slug_e_g_file',
                'Raw activity slug (e.g. file_created, comments, deck). Leave empty to match every type — and prefer file.new / file.changed / share.received as dedicated triggers.',
            ),
        }),
        textFilter('objectNameContains', msg('automations.trigger_filters.object_name_contains', 'Object name contains')),
        textFilter('actorEquals', ACTOR),
    ],
};

export const NEXTCLOUD_NOTIFICATION: FilterForm = {
    title: msg('automations.trigger_filters.nextcloud_notification_filter', 'Nextcloud notification filter'),
    fields: [
        textFilter('app', msg('automations.trigger_filters.app', 'App'), {
            example: 'spreed',
            hint: msg('automations.trigger_filters.source_app_id_e_g_spreed', 'Source app id (e.g. spreed, files_sharing, dav, updatenotification).'),
        }),
        textFilter('subjectContains', msg('automations.trigger_filters.subject_contains', 'Subject contains')),
    ],
};

export const NEXTCLOUD_FORMS_SUBMITTED: FilterForm = {
    title: msg('automations.trigger_filters.nextcloud_form_filter_all_optional', 'Nextcloud form filter (all optional)'),
    fields: [
        numberFilter('formId', msg('automations.trigger_filters.form_id', 'Form ID'), {
            example: '51',
            hint: msg('automations.trigger_filters.numeric_id_leave_empty_to_fire', 'Numeric id — leave empty to fire for every form you can see. Find it with the “List forms” action.'),
        }),
        textFilter('formHash', msg('automations.trigger_filters.form_hash', 'Form hash'), {
            example: 'abc123def456',
            hint: msg('automations.trigger_filters.the_token_in_the_form_s', "The token in the form's share link — an alternative to the numeric id."),
        }),
        textFilter('titleContains', msg('automations.trigger_filters.title_contains', 'Title contains')),
        textFilter('submittedByEquals', msg('automations.trigger_filters.submitted_by', 'Submitted by'), {
            hint: msg('automations.trigger_filters.nextcloud_user_id_anonymous_submissions_have', 'Nextcloud user id. Anonymous submissions have no user, so this never matches them.'),
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
    title: msg('automations.trigger_filters.nextcloud_tables_row_filter_all_optional', 'Nextcloud Tables row filter (all optional)'),
    fields: [
        numberFilter('tableId', msg('automations.trigger_filters.table_id', 'Table ID'), {
            example: '34',
            hint: msg('automations.trigger_filters.numeric_id_find_it_with_the', 'Numeric id — find it with the “List tables” action.'),
        }),
        numberFilter('columnId', msg('automations.trigger_filters.column_id', 'Column ID'), {
            example: '13',
            hint: msg(
                'automations.trigger_filters.numeric_column_id_to_test_a',
                'Numeric column id to test a value against — from “List table columns”. The event carries column ids, not titles.',
            ),
        }),
        textFilter('valueEquals', msg('automations.trigger_filters.value_equals', 'Value equals'), { example: 'approved' }),
        textFilter('valueContains', msg('automations.trigger_filters.value_contains', 'Value contains')),
        tickFilter(
            'changedOnly',
            msg('automations.trigger_filters.only_when_that_column_changed', 'Only when that column changed'),
            msg('automations.trigger_filters.ignore_edits_that_left_this_column', 'Ignore edits that left this column alone'),
        ),
        filterNote(
            'changedOnlyHint',
            msg(
                'automations.trigger_filters.row_updates_fire_on_any_edit',
                'Row updates fire on any edit. Tick this to fire only when the column above actually changed value.',
            ),
        ),
        textFilter('actorEquals', msg('automations.trigger_filters.changed_by', 'Changed by'), { hint: NC_USER_ID }),
    ],
};

export const NEXTCLOUD_TAG: FilterForm = {
    title: msg('automations.trigger_filters.nextcloud_tag_filter_all_optional', 'Nextcloud tag filter (all optional)'),
    fields: [
        numberFilter('tagId', msg('automations.trigger_filters.tag_id', 'Tag ID'), {
            example: '3',
            hint: msg('automations.trigger_filters.numeric_id_from_the_list_tags', "Numeric id — from the “List tags” action. Nextcloud's tag event carries ids only, never the tag name."),
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
    title: msg('automations.trigger_filters.nextcloud_calendar_filter_all_optional', 'Nextcloud calendar filter (all optional)'),
    fields: [
        numberFilter('calendarId', msg('automations.trigger_filters.calendar_id_2', 'Calendar ID'), {
            hint: msg('automations.trigger_filters.numeric_id_of_the_calendar_leave', 'Numeric id of the calendar. Leave empty for all calendars.'),
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
