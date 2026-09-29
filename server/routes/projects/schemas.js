'use strict';
/**
 * What the project routes accept (routes/projects.js and ./packaging.js).
 *
 * Every body and query is closed: a misspelled key is a 400 naming it, not a
 * 200 that ignored it. Three things these schemas close that the handlers
 * read wrongly before:
 *
 *   - `attach: "false"` on PUT /:id/resources filed the resource INTO the
 *     project (a non-empty string is truthy) — the opposite of what was asked.
 *   - a role the ladder does not have (`"edtor"`, `"owner"`, or no role at
 *     all) went through `normalizePermission`, which answers `viewer` for
 *     anything it does not know: PUT /:id/members/:memberId DEMOTED an editor
 *     under a 200, and POST /:id/share invited as viewer.
 *   - a negative `offset` reached SQL as `OFFSET -5` and came back a 500.
 *
 * The caps a handler already answers itself (at most 50 knowledge bases, at
 * most 200 conversations per request) stay in the handler, with its words;
 * whether a `kind` is movable is the membership registry's answer.
 */

const { z, worded, bodyOf, queryOf, choice, flag, wholeNumber, closedObject } = require('../../core/http/schemaParts');

const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;
const INSTRUCTIONS_MAX = 8000;
const ID_MAX = 200;

const NAME_TEXT = 'Name is required';
const text = (max, message) => worded(message).max(max, message);
const anId = (message) => worded(message).trim().min(1, message).max(ID_MAX, message);

// Blank is not a name: PUT {"name": ""} used to blank the project's name.
const name = worded(NAME_TEXT)
    .refine((v) => v.trim().length > 0, NAME_TEXT)
    .refine((v) => v.length <= NAME_MAX, `Name exceeds ${NAME_MAX} characters`);

// A list, or null for "none". A single id sent as text used to skip the
// access check (it only looks at lists) and was stored as a JSON string.
const KB_TEXT = 'knowledgeBaseIds is a list of knowledge base ids.';
const knowledgeBaseIds = z.preprocess(
    (v) => (v === null ? [] : v),
    z.array(worded(KB_TEXT).min(1, KB_TEXT).max(ID_MAX, KB_TEXT), { invalid_type_error: KB_TEXT }),
);

const settings = {
    description: text(DESCRIPTION_MAX, `Description exceeds ${DESCRIPTION_MAX} characters`).nullish(),
    customInstructions: text(INSTRUCTIONS_MAX, `Custom instructions exceed ${INSTRUCTIONS_MAX} characters`).nullish(),
    color: text(64, 'color is a colour of at most 64 characters, like #6366f1.').nullish(),
    icon: text(64, 'icon is an emoji or a short icon name.').nullish(),
    knowledgeBaseIds: knowledgeBaseIds.optional(),
    extractMemories: flag('extractMemories is true or false.').nullish(),
};

const CreateBody = bodyOf({ name, ...settings }, 'Creating a project');

const UpdateBody = bodyOf({
    name: name.optional(),
    ...settings,
    // Optimistic concurrency: the version the editor loaded.
    version: wholeNumber('version is the whole number the project was loaded with.').nullish(),
}, 'Updating a project');

const ROLE_TEXT = 'role must be viewer or editor';
const ROLES = ['viewer', 'editor', 'view', 'edit'];

const ShareBody = bodyOf({
    sharedWithType: choice(['user', 'group'], 'sharedWithType must be user or group'),
    sharedWithId: anId('sharedWithType and sharedWithId required'),
    permission: choice(ROLES, 'permission must be viewer or editor').optional(),
}, 'Sharing a project');

const MemberRoleBody = bodyOf({ role: choice(ROLES, ROLE_TEXT) }, 'Changing a role');

const CONVERSATION_TYPE_TEXT = 'type is "direct" or "agent".';
const conversationType = choice(['direct', 'agent'], CONVERSATION_TYPE_TEXT);
const TypeQuery = queryOf({ type: conversationType.optional() }, 'This request');

const PAGE = {
    limit: wholeNumber('limit is a whole number.', { min: 0 }).optional(),
    offset: wholeNumber('offset is a whole number, 0 or more.', { min: 0 }).optional(),
};
const PageQuery = queryOf(PAGE, 'This list');

const SummaryQuery = queryOf({
    ids: text(ID_MAX * 60, 'ids is a comma-separated list of project ids.').optional(),
    since: text(64, 'since is a date, like 2026-09-24T00:00:00Z.').optional(),
    checks: choice(['0', '1'], 'checks is 0 to skip the completeness checks.').optional(),
}, 'The Solutions overview');

const StreamQuery = queryOf({
    since: wholeNumber('since is the id of the last event you received.', { min: 0 }).optional(),
}, 'The project stream');

const ShareThreadBody = bodyOf({
    conversationId: anId('conversationId is required'),
    type: conversationType.optional(),
}, 'Sharing a conversation');

const TypingBody = bodyOf({
    conversationId: text(ID_MAX, 'conversationId is the id of a conversation.').nullish(),
}, 'A typing signal');

// `kind` and `id` stay optional here: the handler answers their absence
// itself, and the registry decides which kinds exist.
const ResourceBody = bodyOf({
    kind: text(64, 'kind is the name of a resource kind.').optional(),
    id: text(ID_MAX, 'id is the id of the resource.').optional(),
    attach: flag('attach is true (file in) or false (take out).').optional(),
}, 'Filing a resource');

const CONVERSATIONS_TEXT = 'assign and unassign are lists of { id, type }.';
const conversationRef = closedObject({
    id: anId('Every conversation needs an id.'),
    type: conversationType.optional(),
}, 'A conversation');
const ConversationsBody = bodyOf({
    assign: z.array(conversationRef, { invalid_type_error: CONVERSATIONS_TEXT }).optional(),
    unassign: z.array(conversationRef, { invalid_type_error: CONVERSATIONS_TEXT }).optional(),
}, 'Assigning conversations');

// ── Blueprint packaging ──────────────────────────────────────────────

const ExportBody = bodyOf({ save: flag('save is true or false.').optional() }, 'Exporting a Blueprint');

// Either a saved Blueprint's id, or the manifest of a file. The handler says
// so when neither is there; the manifest's own shape is the installer's.
const source = {
    blueprintId: text(ID_MAX, 'blueprintId is the id of a saved Blueprint.').optional(),
    manifest: z.record(z.unknown(), { invalid_type_error: 'manifest is a Blueprint file, a JSON object.' }).optional(),
};
const UpgradeBody = bodyOf(source, 'Upgrading from a Blueprint');
const InstallBody = bodyOf({
    ...source,
    name: text(NAME_MAX, `name is the new Solution's name, at most ${NAME_MAX} characters.`).optional(),
    // projects/packaging/resolutions.js rebuilds every row from a fixed key set.
    resolutions: z.unknown(),
}, 'Installing a Blueprint');

module.exports = {
    CreateBody, UpdateBody, ShareBody, MemberRoleBody, TypeQuery, PageQuery, SummaryQuery,
    StreamQuery, ShareThreadBody, TypingBody, ResourceBody, ConversationsBody,
    ExportBody, UpgradeBody, InstallBody,
};
