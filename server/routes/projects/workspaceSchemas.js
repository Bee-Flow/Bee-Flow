'use strict';
/**
 * What the project workspace routes (routes/projects/workspace.js) accept.
 *
 * Closed, like every schema under /api/projects: a key a route does not read
 * is refused by name, and every refusal is a sentence. The upload itself is
 * multipart and is checked by the route (one field, `file`, at most 20 MB);
 * these cover the JSON bodies, the query strings and the ids in the path.
 */

const { z, worded, bodyOf, queryOf, closedObject, wholeNumber } = require('../../core/http/schemaParts');

/** GET /:id/files — takes nothing. */
const FilesQuery = queryOf({}, 'The project file list');

const FILE_ID = 'A file id is the id of one of this project\'s files.';
/** DELETE /:id/files/:fileId */
const FileParams = closedObject({
    id: worded('A project id is required.').min(1, 'A project id is required.'),
    fileId: worded(FILE_ID).trim().uuid(FILE_ID),
}, 'This address');

/** DELETE /:id/files/:fileId — no body, no query. */
const NoBody = bodyOf({}, 'Removing a file');
const NoQuery = queryOf({}, 'Removing a file');

/** GET /:id/my-chats?limit= */
const MyChatsQuery = queryOf({
    limit: wholeNumber('limit is a whole number from 1 to 200.', { min: 1, max: 200 }).optional(),
}, 'The list of your chats in this project');

/** POST /:id/presence — a ping; it carries nothing. */
const PresenceBody = bodyOf({}, 'A presence ping');

module.exports = { z, FilesQuery, FileParams, NoBody, NoQuery, MyChatsQuery, PresenceBody };
