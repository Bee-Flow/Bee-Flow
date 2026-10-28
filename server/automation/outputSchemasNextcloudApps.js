// @typecheck strict
/**
 * Output schemas of the other Nextcloud APP tools: activity, notifications,
 * user status, tables, talk and teams.
 * Read off the handlers' success returns in integrations/nextcloud*. Same
 * contract as ./outputSchemas.js (`shape`, `sample`, `echo`); the coverage
 * test (outputSchemas.nextcloudCoverage.test.js) fails on a nextcloud_* tool
 * that has an entry in none of the schema files.
 */
'use strict';

const NOW = 1791100000; // a fixed unix time, so a sample never changes between dry runs
const STATUS = '{ userId, status (online|away|dnd|invisible|offline), message, messageId, icon, clearAt, statusIsUserDefined, messageIsPredefined }';
const SAMPLE_STATUS = { userId: 'alice', status: 'dnd', message: 'In a workshop', messageId: null, icon: '🎓', clearAt: NOW + 3600, statusIsUserDefined: true, messageIsPredefined: false };
const TABLE = 'object { id, title, emoji, ownership, isShared, archived, rowsCount, columnsCount }';
const SAMPLE_TABLE = { id: 7, title: 'Invoices', emoji: '🧾', ownership: 'alice', isShared: false, archived: false, rowsCount: 0, columnsCount: 0 };
const TALK_ROOM = '{ token, type, name, description, unreadMessages, unreadMention, lastActivity, lastMessage, participantType, canStartCall, readOnly, hasCall, callFlag, callRecording, callStartTime, objectType, objectId }';
const SAMPLE_TALK_ROOM = { token: '78dp7n2a', type: 2, name: 'Ops', description: '', unreadMessages: 0, unreadMention: false, lastActivity: NOW, lastMessage: null, participantType: 1, canStartCall: true, readOnly: 0, hasCall: false, callFlag: 0, callRecording: 0, callStartTime: 0, objectType: '', objectId: '' };
const TALK_MESSAGE = '{ id, actor, actorId, actorType, timestamp, message, messageParameters (an object, or [] when there are none), systemMessage, parent, reactions }';
const SAMPLE_TALK_MESSAGE = { id: 91, actor: 'Alice', actorId: 'alice', actorType: 'users', timestamp: NOW, message: 'Morning all', messageParameters: [], systemMessage: null, parent: null, reactions: {} };
const TEAM = '{ id, name, description, memberCount, myLevel, personal }';
const SAMPLE_TEAM = { id: 'tEaM1d', name: 'Finance', description: '', memberCount: 3, myLevel: 'owner', personal: false };

/** @type {Record<string, import('./outputSchemas').OutputSchema>} */
const OUTPUT_SCHEMAS_NEXTCLOUD_APPS = {
    // ── Activity ──────────────────────────────────────────────────
    nextcloud_activity_list_for_file: {
        shape: { fileId: 'integer|string', count: 'integer', activities: 'array of { id, type, subject, message, actor, objectType, objectId, objectName, link, datetime }' },
        sample: { fileId: 4211, count: 1, activities: [{ id: 42, type: 'file_changed', subject: 'You changed Report.pdf', message: '', actor: 'alice', objectType: 'files', objectId: 4211, objectName: '/Documents/Report.pdf', link: 'https://cloud.example.com/f/4211', datetime: '2026-10-28T09:00:00+00:00' }] },
        echo: { fileId: 'fileId' },
    },

    // ── Notifications ─────────────────────────────────────────────
    nextcloud_notifications_list: {
        shape: { count: 'integer', notifications: 'array of { id, app, user, datetime, objectType, objectId, subject, message, link, icon, actions: [{ label, link, type, primary }] }' },
        sample: { count: 1, notifications: [{ id: 88, app: 'files_sharing', user: 'alice', datetime: '2026-10-28T09:00:00+00:00', objectType: 'remote_share', objectId: '12', subject: 'Bob shared Q3.pdf with you', message: '', link: 'https://cloud.example.com/f/4211', icon: null, actions: [] }] },
    },
    nextcloud_notifications_dismiss: {
        shape: { success: 'boolean', id: 'integer' },
        sample: { success: true, id: 88 },
        echo: { id: 'id' },
    },
    nextcloud_notifications_dismiss_all: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },

    // ── User status ───────────────────────────────────────────────
    nextcloud_status_get: {
        // FLAT: the status fields at the top.
        shape: { userId: 'string', status: 'string', message: 'string|null', messageId: 'string|null', icon: 'string|null', clearAt: 'integer|null', statusIsUserDefined: 'boolean', messageIsPredefined: 'boolean' },
        sample: SAMPLE_STATUS,
    },
    nextcloud_status_set: {
        shape: { success: 'boolean', status: `object ${STATUS}|null` },
        sample: { success: true, status: SAMPLE_STATUS },
        echo: { 'status.status': 'availability', 'status.message': 'message', 'status.icon': 'emoji' },
    },
    nextcloud_status_clear: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },
    nextcloud_status_set_predefined: {
        shape: { success: 'boolean', status: `object ${STATUS}|null` },
        sample: { success: true, status: { ...SAMPLE_STATUS, status: 'online', message: 'In a meeting', messageId: 'meeting', icon: '📅', messageIsPredefined: true, statusIsUserDefined: false } },
        echo: { 'status.messageId': 'messageId' },
    },

    // ── Tables ────────────────────────────────────────────────────
    nextcloud_tables_update: {
        shape: { success: 'boolean', table: TABLE },
        sample: { success: true, table: SAMPLE_TABLE },
        echo: { 'table.title': 'title', 'table.emoji': 'emoji' },
    },
    nextcloud_tables_delete: {
        shape: { success: 'boolean', tableId: 'integer|string' },
        sample: { success: true, tableId: 7 },
        echo: { tableId: 'tableId' },
    },
    nextcloud_tables_create_column: {
        shape: { success: 'boolean', column: 'object { id, title, type, subtype, mandatory, description, selectionOptions (selection columns), numberDecimals (number columns) }' },
        sample: { success: true, column: { id: 21, title: 'Amount', type: 'number', subtype: null, mandatory: false, description: '', numberDecimals: 2 } },
        echo: { 'column.title': 'title', 'column.type': 'type' },
    },
    nextcloud_tables_delete_column: {
        shape: { success: 'boolean', columnId: 'integer' },
        sample: { success: true, columnId: 21 },
        echo: { columnId: 'columnId' },
    },
    nextcloud_tables_list_rows: {
        // `values` is keyed by column TITLE; every column is present (null when empty).
        shape: { tableId: 'integer|string', count: 'integer', truncated: 'boolean', columns: 'array of string (column titles)', rows: 'array of { id, tableId, createdBy, createdAt, lastEditBy, lastEditAt, values }' },
        sample: { tableId: 4, count: 1, truncated: false, columns: ['Date', 'Supplier', 'Total'], rows: [{ id: 31, tableId: 4, createdBy: 'alice', createdAt: '2026-10-28 10:00:00', lastEditBy: 'alice', lastEditAt: '2026-10-28 10:00:00', values: { Date: '2026-10-19', Supplier: 'Example BV', Total: 1554.25 } }] },
        echo: { tableId: 'tableId' },
    },
    nextcloud_tables_delete_row: {
        shape: { success: 'boolean', rowId: 'integer' },
        sample: { success: true, rowId: 31 },
        echo: { rowId: 'rowId' },
    },

    // ── Talk ──────────────────────────────────────────────────────
    nextcloud_talk_get_room: {
        // FLAT: the room's fields at the top.
        shape: { token: 'string', type: 'integer', name: 'string', description: 'string', unreadMessages: 'integer', unreadMention: 'boolean', lastActivity: 'integer', lastMessage: 'object { id, actor, message, timestamp }|null', participantType: 'integer', canStartCall: 'boolean', readOnly: 'integer', hasCall: 'boolean', callFlag: 'integer', callRecording: 'integer', callStartTime: 'integer', objectType: 'string', objectId: 'string' },
        sample: SAMPLE_TALK_ROOM,
        echo: { token: 'token' },
    },
    nextcloud_talk_create_room: {
        shape: { success: 'boolean', room: `object ${TALK_ROOM}` },
        sample: { success: true, room: { ...SAMPLE_TALK_ROOM, token: 'n3wr00m1', name: 'Project kick-off' } },
        echo: { 'room.name': 'roomName' },
    },
    nextcloud_talk_list_participants: {
        shape: { token: 'string', count: 'integer', participants: 'array of { attendeeId, actorType, actorId, displayName, participantType, inCall, lastPing }' },
        sample: { token: '78dp7n2a', count: 1, participants: [{ attendeeId: 5, actorType: 'users', actorId: 'alice', displayName: 'Alice', participantType: 1, inCall: 0, lastPing: NOW }] },
        echo: { token: 'token' },
    },
    nextcloud_talk_start_recording: {
        shape: { success: 'boolean', started: 'boolean', status: 'integer (1 video, 2 audio)' },
        sample: { success: true, started: true, status: 1 },
    },
    nextcloud_talk_stop_recording: {
        shape: { success: 'boolean', stopped: 'boolean' },
        sample: { success: true, stopped: true },
    },
    nextcloud_talk_list_messages: {
        shape: { token: 'string', count: 'integer', messages: `array of ${TALK_MESSAGE}` },
        sample: { token: '78dp7n2a', count: 1, messages: [SAMPLE_TALK_MESSAGE] },
        echo: { token: 'token' },
    },
    nextcloud_talk_search_messages: {
        shape: { query: 'string', count: 'integer', messages: 'array of { title, subline, resourceUrl, icon, attributes, token }' },
        sample: { query: 'invoice', count: 1, messages: [{ title: 'Alice', subline: 'The invoice is in the folder', resourceUrl: 'https://cloud.example.com/call/78dp7n2a#message_91', icon: '', attributes: { conversation: '78dp7n2a', messageId: '91' }, token: '78dp7n2a' }] },
        echo: { query: 'query' },
    },
    nextcloud_talk_delete_message: {
        shape: { success: 'boolean', messageId: 'integer' },
        sample: { success: true, messageId: 91 },
        echo: { messageId: 'messageId' },
    },
    nextcloud_talk_add_reaction: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },
    nextcloud_talk_remove_reaction: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },
    nextcloud_talk_mark_read: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },
    nextcloud_talk_create_poll: {
        shape: { success: 'boolean', pollId: 'integer|null', question: 'string', options: 'array of string' },
        sample: { success: true, pollId: 14, question: 'Lunch on Friday?', options: ['Yes', 'No'] },
        echo: { question: 'question', options: 'options' },
    },
    nextcloud_talk_get_poll: {
        // `votes` is keyed by the 0-based option index; it is {} (never []) without votes.
        shape: { pollId: 'integer', question: 'string', options: 'array of string', votes: 'object (option index -> votes)', numVoters: 'integer|null', status: 'string (open|closed)', resultMode: 'integer|null' },
        sample: { pollId: 14, question: 'Lunch on Friday?', options: ['Yes', 'No'], votes: { 0: 3, 1: 1 }, numVoters: 4, status: 'open', resultMode: 0 },
        echo: { pollId: 'pollId' },
    },
    nextcloud_talk_vote_poll: {
        shape: { success: 'boolean', pollId: 'integer', optionIds: 'array of integer' },
        sample: { success: true, pollId: 14, optionIds: [0] },
        echo: { pollId: 'pollId', optionIds: 'optionIds' },
    },
    nextcloud_talk_close_poll: {
        shape: { success: 'boolean', pollId: 'integer', status: 'string (closed)' },
        sample: { success: true, pollId: 14, status: 'closed' },
        echo: { pollId: 'pollId' },
    },
    nextcloud_talk_share_file: {
        shape: { success: 'boolean', token: 'string', path: 'string', shareId: 'integer|null' },
        sample: { success: true, token: '78dp7n2a', path: '/Reports/Q3.pdf', shareId: 41 },
        echo: { token: 'token', path: 'path' },
    },

    // ── Teams ─────────────────────────────────────────────────────
    nextcloud_teams_list: {
        shape: { count: 'integer', teams: `array of ${TEAM}` },
        sample: { count: 1, teams: [SAMPLE_TEAM] },
    },
    nextcloud_teams_get: {
        shape: { team: `object ${TEAM}` },
        sample: { team: SAMPLE_TEAM },
        echo: { 'team.id': 'teamId' },
    },
    nextcloud_teams_list_members: {
        // `id` is the Teams member handle (remove / set level take it), not the user id.
        shape: { teamId: 'string', count: 'integer', members: 'array of { id, userId, displayName, level, type }' },
        sample: { teamId: 'tEaM1d', count: 1, members: [{ id: 'm3mb3r1', userId: 'alice', displayName: 'Alice', level: 'owner', type: 1 }] },
        echo: { teamId: 'teamId' },
    },
    nextcloud_teams_create: {
        shape: { success: 'boolean', team: `object ${TEAM}` },
        sample: { success: true, team: { ...SAMPLE_TEAM, id: 'n3wT3am', name: 'Project X', memberCount: 1 } },
        echo: { 'team.name': 'name' },
    },
    nextcloud_teams_add_members: {
        shape: { success: 'boolean', teamId: 'string', added: 'array of string (user ids)', skipped: 'array of string (already members)', errors: 'array of { userId, error }' },
        sample: { success: true, teamId: 'tEaM1d', added: ['bob'], skipped: [], errors: [] },
        echo: { teamId: 'teamId', added: 'userIds' },
    },
    nextcloud_teams_remove_member: {
        shape: { success: 'boolean', teamId: 'string', memberId: 'string' },
        sample: { success: true, teamId: 'tEaM1d', memberId: 'm3mb3r2' },
        echo: { teamId: 'teamId', memberId: 'memberId' },
    },
    nextcloud_teams_set_member_level: {
        shape: { success: 'boolean', teamId: 'string', memberId: 'string', level: 'string' },
        sample: { success: true, teamId: 'tEaM1d', memberId: 'm3mb3r2', level: 'moderator' },
        echo: { teamId: 'teamId', memberId: 'memberId', level: 'level' },
    },
    nextcloud_teams_update: {
        shape: { success: 'boolean', teamId: 'string', updated: 'array of string (name|description)' },
        sample: { success: true, teamId: 'tEaM1d', updated: ['name'] },
        echo: { teamId: 'teamId' },
    },
    nextcloud_teams_delete: {
        shape: { success: 'boolean', teamId: 'string' },
        sample: { success: true, teamId: 'tEaM1d' },
        echo: { teamId: 'teamId' },
    },
    nextcloud_share_with_team: {
        shape: { success: 'boolean', id: 'integer|string', shareId: 'integer|string', path: 'string', teamId: 'string', permissions: 'integer' },
        sample: { success: true, id: 42, shareId: 42, path: '/Reports/Q3.pdf', teamId: 'tEaM1d', permissions: 1 },
        echo: { path: 'path', teamId: 'teamId', permissions: 'permissions' },
    },
};

module.exports = { OUTPUT_SCHEMAS_NEXTCLOUD_APPS };
