/**
 * What the App Studio management routes accept (routes/studioApps/).
 *
 * The zod bodies and queries the parts of the /api/studio-apps router
 * validate against.
 */

const { z, worded, bodyOf, queryOf, choice, wholeNumber, typeError } = require('../../core/http/schemaParts');

// ── What the app-management routes accept ────────────────────────────
// Closed bodies and queries. What they close: `isPublished: "false"` on
// PATCH /:id/publish PUBLISHED the app (`!!"false"`), and a single group sent
// as text (`sharedGroups: "g1"`) became an org-wide publish on the first
// publish; `enabled: "false"` put the app IN the Nextcloud menu; `?draft=yes`
// served the published copy to an owner who asked for the draft. The two
// import routes stay open: their body may be the exported file itself, which
// sanitizeImport/sanitizeAppImport read field by field.
const appText = (message, max) => worded(message).max(max, message);
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

module.exports = {
    CreateAppBody,
    UpdateAppBody,
    DefinitionBody,
    PublishBody,
    NextcloudMenuBody,
    CheckBody,
    DownloadQuery,
    RefQuery,
    DraftQuery,
};
