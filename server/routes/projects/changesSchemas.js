'use strict';
/**
 * What the change-feed routes (routes/projects/changes.js) accept.
 *
 * Closed, like every schema under /api/projects: a key a route does not read
 * is refused by name, and every refusal is a sentence.
 */

const { worded, bodyOf, queryOf, closedObject, choice, wholeNumber } = require('../../core/http/schemaParts');

const SINCE = 'since is "visit", "unread" or a date and time (ISO 8601).';

/** GET /:id/changes?since=visit|unread|<iso>&group=item|person */
const ChangesQuery = queryOf({
    since: worded(SINCE).trim()
        .refine((v) => v === 'visit' || v === 'unread' || (/^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))), SINCE)
        .optional(),
    group: choice(['item', 'person'], 'group is "item" or "person".').optional(),
}, 'The list of changes');

/** GET /:id/changes/log?limit=&offset= */
const ChangeLogQuery = queryOf({
    limit: wholeNumber('limit is a whole number from 1 to 100.', { min: 1, max: 100 }).optional(),
    offset: wholeNumber('offset is a whole number, 0 or more.', { min: 0, max: 100_000 }).optional(),
}, 'The change log');

/** POST /:id/visit and POST /:id/seen — they carry nothing. */
const VisitBody = bodyOf({}, 'A visit');
const SeenBody = bodyOf({}, 'Marking everything as seen');

const ITEM_TYPE = 'The item type is notebook, document or meeting.';
const ITEM_ID = 'An item id is the id of a notebook, document or meeting in this project.';

/** POST /:id/items/:type/:itemId/seen */
const ItemParams = closedObject({
    id: worded('A project id is required.').min(1, 'A project id is required.'),
    type: choice(['notebook', 'document', 'meeting'], ITEM_TYPE),
    itemId: worded(ITEM_ID).trim().min(1, ITEM_ID).max(200, ITEM_ID),
}, 'This address');

const VERSION_ID = 'versionId is the id of the version you were shown.';
const ItemSeenBody = bodyOf({
    versionId: worded(VERSION_ID).trim().min(1, VERSION_ID).max(200, VERSION_ID).nullable().optional(),
}, 'Marking an item as seen');

module.exports = { ChangesQuery, ChangeLogQuery, VisitBody, SeenBody, ItemParams, ItemSeenBody };
