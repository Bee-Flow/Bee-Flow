/**
 * factsNextcloud.mts: the facts of the Nextcloud integration pages, one per
 * Nextcloud app (see facts.mts for what a fact is).
 */

import { g, type IntegrationFacts, type ToolGroup } from './factsShape.mts';

const nc = (toolset: string, groups: ToolGroup[], prefix: string | null, related: string[]): IntegrationFacts => ({
    toolset, groups, nextcloud: true, related,
    ...(prefix === null ? {} : { events: [{ provider: 'nextcloud', prefix }] }),
});

export const NEXTCLOUD: Record<string, IntegrationFacts> = {
    nextcloud: {
        toolset: 'NEXTCLOUD_TOOLS',
        nextcloud: true,
        groups: [
            g('find', 'nextcloud_list_files', 'nextcloud_search_files', 'nextcloud_folder_tree', 'nextcloud_search', 'nextcloud_read_file'),
            g('create', 'nextcloud_upload_file', 'nextcloud_create_document', 'nextcloud_create_spreadsheet', 'nextcloud_create_presentation', 'nextcloud_convert_file'),
            g('organise', 'nextcloud_create_folder', 'nextcloud_move', 'nextcloud_copy', 'nextcloud_delete',
                'nextcloud_list_tags', 'nextcloud_create_tag', 'nextcloud_tag_file', 'nextcloud_untag_file', 'nextcloud_find_files_by_tag'),
            g('share', 'nextcloud_list_groups', 'nextcloud_create_share', 'nextcloud_share_with_user', 'nextcloud_share_with_group',
                'nextcloud_share_by_email', 'nextcloud_list_shares', 'nextcloud_update_share', 'nextcloud_delete_share', 'nextcloud_direct_link'),
            g('comments', 'nextcloud_list_file_comments', 'nextcloud_add_file_comment'),
            g('restore', 'nextcloud_list_trash', 'nextcloud_restore_from_trash', 'nextcloud_permanent_delete_trash', 'nextcloud_list_versions', 'nextcloud_restore_version'),
        ],
        events: [{ provider: 'nextcloud', prefix: 'file.' }, { provider: 'nextcloud', prefix: 'share.' }],
        related: ['nextcloud-activity', 'nextcloud-talk', 'nextcloud-tables', 'google-drive', 'onedrive'],
    },
    'nextcloud-calendar': nc('NEXTCLOUD_CALENDAR_TOOLS', [
        g('read', 'nextcloud_calendar_list', 'nextcloud_calendar_list_events', 'nextcloud_calendar_search_events', 'nextcloud_calendar_get_event'),
        g('change', 'nextcloud_calendar_create_event', 'nextcloud_calendar_update_event', 'nextcloud_calendar_delete_event'),
    ], 'calendar.', ['nextcloud-tasks', 'google-calendar', 'ms-calendar']),
    'nextcloud-contacts': nc('NEXTCLOUD_CONTACTS_TOOLS', [
        g('find', 'nextcloud_contacts_list_addressbooks', 'nextcloud_contacts_list', 'nextcloud_contacts_search', 'nextcloud_contacts_get'),
        g('change', 'nextcloud_contacts_create', 'nextcloud_contacts_update', 'nextcloud_contacts_delete'),
    ], null, ['nextcloud-mail', 'google-contacts', 'ms-contacts']),
    'nextcloud-deck': nc('NEXTCLOUD_DECK_TOOLS', [
        g('read', 'nextcloud_deck_list_boards', 'nextcloud_deck_get_board', 'nextcloud_deck_list_stacks', 'nextcloud_deck_list_cards',
            'nextcloud_deck_search_cards', 'nextcloud_deck_get_card', 'nextcloud_deck_list_comments'),
        g('cards', 'nextcloud_deck_create_card', 'nextcloud_deck_update_card', 'nextcloud_deck_archive_card', 'nextcloud_deck_delete_card',
            'nextcloud_deck_assign_label', 'nextcloud_deck_remove_label', 'nextcloud_deck_add_comment'),
        g('board', 'nextcloud_deck_create_stack', 'nextcloud_deck_update_stack', 'nextcloud_deck_delete_stack'),
    ], 'deck.', ['nextcloud-tasks', 'nextcloud-talk', 'youtrack']),
    'nextcloud-mail': nc('NEXTCLOUD_MAIL_TOOLS', [
        g('read', 'nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes', 'nextcloud_mail_search', 'nextcloud_mail_read', 'nextcloud_mail_read_attachment'),
        g('send', 'nextcloud_mail_send'),
        g('sort', 'nextcloud_mail_set_flags', 'nextcloud_mail_move', 'nextcloud_mail_save_attachment'),
    ], null, ['nextcloud-contacts', 'nextcloud', 'gmail', 'outlook']),
    'nextcloud-notifications': nc('NEXTCLOUD_NOTIFICATIONS_TOOLS', [
        g('read', 'nextcloud_notifications_list'),
        g('dismiss', 'nextcloud_notifications_dismiss', 'nextcloud_notifications_dismiss_all'),
        g('send', 'nextcloud_notifications_send'),
    ], 'notification.', ['nextcloud-activity', 'nextcloud-talk']),
    'nextcloud-talk': nc('NEXTCLOUD_TALK_TOOLS', [
        g('read', 'nextcloud_talk_list_rooms', 'nextcloud_talk_get_room', 'nextcloud_talk_list_participants', 'nextcloud_talk_list_messages', 'nextcloud_talk_search_messages'),
        g('post', 'nextcloud_talk_send_message', 'nextcloud_talk_share_file', 'nextcloud_talk_add_reaction', 'nextcloud_talk_remove_reaction',
            'nextcloud_talk_delete_message', 'nextcloud_talk_mark_read'),
        g('polls', 'nextcloud_talk_create_poll', 'nextcloud_talk_get_poll', 'nextcloud_talk_vote_poll', 'nextcloud_talk_close_poll'),
        g('rooms', 'nextcloud_talk_create_room', 'nextcloud_talk_start_recording', 'nextcloud_talk_stop_recording'),
    ], 'talk.', ['nextcloud-deck', 'nextcloud-notifications', 'fireflies']),
    'nextcloud-tasks': nc('NEXTCLOUD_TASKS_TOOLS', [
        g('read', 'nextcloud_tasks_list_lists', 'nextcloud_tasks_list', 'nextcloud_tasks_search', 'nextcloud_tasks_get'),
        g('change', 'nextcloud_tasks_create', 'nextcloud_tasks_update', 'nextcloud_tasks_complete', 'nextcloud_tasks_delete'),
    ], null, ['nextcloud-calendar', 'nextcloud-deck']),
    'nextcloud-notes': nc('NEXTCLOUD_NOTES_TOOLS', [
        g('read', 'nextcloud_notes_list', 'nextcloud_notes_search', 'nextcloud_notes_get', 'nextcloud_notes_list_categories'),
        g('change', 'nextcloud_notes_create', 'nextcloud_notes_append', 'nextcloud_notes_update', 'nextcloud_notes_delete'),
    ], null, ['nextcloud-tasks', 'google-keep']),
    'nextcloud-activity': nc('NEXTCLOUD_ACTIVITY_TOOLS', [
        g('read', 'nextcloud_activity_list', 'nextcloud_activity_list_for_file'),
    ], 'activity.', ['nextcloud', 'nextcloud-notifications']),
    'nextcloud-tables': nc('NEXTCLOUD_TABLES_TOOLS', [
        g('read', 'nextcloud_tables_list', 'nextcloud_tables_list_columns', 'nextcloud_tables_list_rows'),
        g('rows', 'nextcloud_tables_create_row', 'nextcloud_tables_update_row', 'nextcloud_tables_delete_row'),
        g('shape', 'nextcloud_tables_create', 'nextcloud_tables_update', 'nextcloud_tables_delete', 'nextcloud_tables_create_column', 'nextcloud_tables_delete_column'),
    ], 'tables.', ['nextcloud-forms', 'google-sheets']),
    'nextcloud-forms': nc('NEXTCLOUD_FORMS_TOOLS', [
        g('read', 'nextcloud_forms_list', 'nextcloud_forms_get', 'nextcloud_forms_get_submissions'),
        g('build', 'nextcloud_forms_create', 'nextcloud_forms_add_question', 'nextcloud_forms_update_settings', 'nextcloud_forms_delete'),
    ], 'forms.', ['nextcloud-tables', 'nextcloud-deck']),
    'nextcloud-teams': nc('NEXTCLOUD_TEAMS_TOOLS', [
        g('read', 'nextcloud_teams_list', 'nextcloud_teams_get', 'nextcloud_teams_list_members'),
        g('manage', 'nextcloud_teams_create', 'nextcloud_teams_add_members', 'nextcloud_teams_remove_member',
            'nextcloud_teams_set_member_level', 'nextcloud_teams_update', 'nextcloud_teams_delete'),
        g('share', 'nextcloud_share_with_team'),
    ], null, ['nextcloud', 'nextcloud-talk']),
    'nextcloud-status': nc('NEXTCLOUD_STATUS_TOOLS', [
        g('read', 'nextcloud_status_get'),
        g('set', 'nextcloud_status_set', 'nextcloud_status_set_predefined', 'nextcloud_status_clear'),
    ], null, ['nextcloud-calendar', 'nextcloud-talk']),
};
