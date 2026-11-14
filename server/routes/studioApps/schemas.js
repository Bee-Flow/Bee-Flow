// @typecheck strict
/**
 * What the App Studio management routes accept (routes/studioApps/).
 *
 * The zod bodies and queries the parts of the /api/studio-apps router
 * validate against.
 */

const { z, worded, bodyOf, queryOf, closedObject, choice, wholeNumber, typeError } = require('../../core/http/schemaParts');

// ── What the app-management routes accept ────────────────────────────
// Closed bodies and queries. What they close: `isPublished: "false"` on
// PATCH /:id/publish PUBLISHED the app (`!!"false"`), and a single group sent
// as text (`sharedGroups: "g1"`) became an org-wide publish on the first
// publish; `enabled: "false"` put the app IN the Nextcloud menu; `?draft=yes`
// served the published copy to an owner who asked for the draft. The two
// import routes stay open: their body may be the exported file itself, which
// sanitizeImport/sanitizeAppImport read field by field.
/**
 * @param {string} message
 * @param {number} max
 */
const appText = (message, max) => worded(message).max(max, message);
/**
 * @param {string} name
 * @param {number} max
 */
const nullableText = (name, max) => appText(`${name} is text of at most ${max} characters.`, max).nullish();
const CreateAppBody = bodyOf({
    name: nullableText('name', 500),
    description: nullableText('description', 10_000),
    icon: nullableText('icon', 200),
    accentColor: nullableText('accentColor', 64),
    templateId: nullableText('templateId', 200),
}, 'Creating an app');
const UpdateAppBody = bodyOf({
    name: appText('name must be a non-empty string', 500).optional(),
    description: nullableText('description', 10_000),
    icon: nullableText('icon', 200),
    accentColor: nullableText('accentColor', 64),
    // Capped to a pill's 64 characters by the handler, as before.
    category: worded('category must be a string or null').nullish(),
}, 'Updating an app');
const DefinitionBody = bodyOf({
    definition: z.record(z.string(), z.unknown(), { error: typeError({ required: 'definition (object) is required', invalid: 'definition (object) is required' }) }),
    baseVersion: wholeNumber('baseVersion is the version the editor loaded.'),
}, 'Saving the draft');
const GROUPS_TEXT = 'sharedGroups is a list of group ids; an empty list means the whole organisation.';
const PublishBody = bodyOf({
    isPublished: z.boolean({ error: 'isPublished is true or false.' }),
    sharedGroups: z.array(appText(GROUPS_TEXT, 200), { error: typeError({ invalid: GROUPS_TEXT }) }).optional(),
}, 'Publishing an app');
const NextcloudMenuBody = bodyOf({
    enabled: z.boolean({ error: 'enabled is true or false.' }),
}, 'The Nextcloud menu');
const CheckBody = bodyOf({
    screenId: nullableText('screenId', 200),
    asRole: nullableText('asRole', 100),
}, 'Checking an app');
const DownloadQuery = queryOf({ download: choice(['0', '1'], 'download is 1 to get the file.').optional() }, 'A template export');
const RefQuery = queryOf({
    screenId: appText('screenId is the id of a screen.', 200).optional(),
    nodeId: appText('nodeId is the id of a component.', 200).optional(),
}, 'An app reference');
const DraftQuery = queryOf({ draft: choice(['0', '1'], 'draft is 1 for the saved draft.').optional() }, 'The app runtime');

// ── The run log (routes/studioApps/runLog.js) ────────────────────────
const RUN_STATUS_TEXT = 'status is running, paused, success, error, interrupted, cancelled or refused.';
const ORIGIN_TEXT = 'origin is a comma list of click, public, mcp, test, background, mailbox_hook and trigger.';
const USER_TEXT = 'user is me, others, visitors, system or the id of a person.'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a help text for the user filter, not a username
const RunsQuery = queryOf({
    actionId: appText('actionId is the id of an action of the app.', 80).regex(/^[A-Za-z0-9_-]{1,80}$/, 'actionId is the id of an action of the app.').optional(),
    status: choice(['running', 'success', 'error', 'interrupted', 'cancelled', 'refused', 'paused'], RUN_STATUS_TEXT).optional(),
    origin: appText(ORIGIN_TEXT, 120).regex(/^(click|public|mcp|test|background|mailbox_hook|trigger)(,(click|public|mcp|test|background|mailbox_hook|trigger))*$/, ORIGIN_TEXT).optional(),
    user: appText(USER_TEXT, 200).optional(),
    since: appText('since is a date and time (ISO 8601).', 40).refine((v) => !Number.isNaN(Date.parse(v)), 'since is a date and time (ISO 8601).').optional(),
    cursor: appText('cursor is the nextCursor a previous page returned.', 200).optional(),
    limit: appText('limit is a whole number from 1 to 100.', 3).regex(/^(?:[1-9]\d?|100)$/, 'limit is a whole number from 1 to 100.').optional(),
}, 'A run list');
const RUN_ID_TEXT = 'runId is the id of a run (sar_ and 32 hex characters).';
// Bounded here; the sar_<32 hex> shape is checked AFTER the app gate (an unknown shape is the
// same 404 as an unknown run), as for background jobs.
const RunParams = closedObject({
    id: appText('id is the app id.', 200).min(1, 'id is the app id.'),
    runId: appText(RUN_ID_TEXT, 64).min(1, RUN_ID_TEXT),
}, 'A run address');

// ── Server triggers (routes/studioApps/triggers.js) ──────────────────
// Bounded here; whether the app has such a trigger is answered after the app gate.
const TRIGGER_ID_TEXT = 'triggerId is the id of a trigger of the app.';
const TriggerParams = closedObject({
    id: appText('id is the app id.', 200).min(1, 'id is the app id.'),
    triggerId: appText(TRIGGER_ID_TEXT, 40).min(1, TRIGGER_ID_TEXT),
}, 'A trigger address');
const TriggerSwitchBody = bodyOf({
    enabled: z.boolean({ error: 'enabled is true or false.' }),
}, 'Switching a trigger');
// An action on the app (or its trigger, version or job) in the path, which takes no fields.
const NoBody = bodyOf({}, 'This action');

module.exports = {
    TriggerParams,
    TriggerSwitchBody,
    NoBody,
    CreateAppBody,
    UpdateAppBody,
    DefinitionBody,
    PublishBody,
    NextcloudMenuBody,
    CheckBody,
    DownloadQuery,
    RefQuery,
    DraftQuery,
    RunsQuery,
    RunParams,
};
