// @typecheck
'use strict';
/**
 * What the co-editing routes (routes/projects/collab.js) and the project
 * stream's document parameters accept.
 *
 * Closed, like every schema under /api/projects: a key a route does not read
 * is refused by name, and every refusal is a sentence. The bytes inside the
 * base64 strings are checked by core/collab/wire.js (strict base64, a full Yjs
 * decode, size caps); these schemas bound the strings themselves so an
 * oversized body is refused before anything is decoded.
 */

const { z, worded, bodyOf, queryOf, closedObject, choice, wholeNumber, flag } = require('../../core/http/schemaParts');
const { defaultLimits, base64Length } = require('../../core/collab/limits');

const LIMITS = defaultLimits();
const ID_MAX = 200;
// One update string may be as long as a whole request may be (the route's
// Content-Length guard): the per-update cap is core/collab/wire.js's, which
// answers 413 UPDATE_TOO_LARGE with a code the client acts on. A tighter cap
// here once refused updates the service accepts with a bare 400.
const UPDATE_B64_MAX = base64Length(LIMITS.maxBodyBytes);
// base64 of a 64 KB state vector.
const SV_B64_MAX = 90_000;
// base64 of a capped awareness state (2 KB) with its header.
const AWARENESS_B64_MAX = 4_000;
const MAX_UPDATES = LIMITS.maxUpdatesPerPost;
const CLIENT_ID_MAX = 0xFFFFFFFF;

const anId = (/** @type {string} */ message) => worded(message).trim().min(1, message).max(ID_MAX, message);
const b64 = (/** @type {number} */ max, /** @type {string} */ message) => worded(message).max(max, message);

const DOC_ID = 'A document id is the id the server returned when the document was opened.';

/** POST /:id/docs — open (or create) the co-edited document of a resource. */
const OpenBody = bodyOf({
    kind: choice(['notebook', 'document'], 'kind is notebook or document.'),
    resourceId: anId('resourceId is the id of a notebook or page filed in this project.'),
}, 'Opening a document');

/** /:id/docs/:docId/... */
const DocParams = closedObject({
    id: anId('A project id is required.'),
    docId: anId(DOC_ID),
}, 'This address');

/** POST /:id/docs/:docId/sync — the client's Yjs state vector ('' when it has nothing yet). */
const SyncBody = bodyOf({
    sv: b64(SV_B64_MAX, 'sv is the base64 state vector of your copy (empty when you have none).'),
}, 'A sync request');

/** POST /:id/docs/:docId/updates */
const UpdatesBody = bodyOf({
    clientId: wholeNumber('clientId is the Yjs client id of your copy.', { min: 0, max: CLIENT_ID_MAX }),
    updates: z.array(b64(UPDATE_B64_MAX, `Each update is a base64 Yjs update; a request carries at most ${Math.round(LIMITS.maxBodyBytes / 1024)} KB.`), {
        required_error: 'updates is a list of base64 Yjs updates.',
        invalid_type_error: 'updates is a list of base64 Yjs updates.',
    }).min(1, 'Send at least one update.').max(MAX_UPDATES, `Send at most ${MAX_UPDATES} updates at once.`),
    awareness: b64(AWARENESS_B64_MAX, 'awareness is a base64 presence update.').optional(),
}, 'Sending changes');

const AWARENESS_ONE = 'A presence request carries exactly one of update, query or leave.';

/** POST /:id/docs/:docId/awareness — `{update}` or `{query: true}` or `{leave: clientId}`. */
const AwarenessBody = bodyOf({
    update: b64(AWARENESS_B64_MAX, 'update is a base64 presence update.').optional(),
    query: flag('query is true to ask who is here.').optional(),
    leave: wholeNumber('leave is the client id that is leaving.', { min: 0, max: CLIENT_ID_MAX }).optional(),
}, 'A presence request').refine(
    (b) => [b.update !== undefined, b.query === true, b.leave !== undefined].filter(Boolean).length === 1,
    { message: AWARENESS_ONE },
);

/**
 * GET /:id/stream — the project feed cursor, and optionally one co-edited
 * document to follow on the same connection.
 */
const StreamQuery = queryOf({
    since: wholeNumber('since is the id of the last event you received.', { min: 0 }).optional(),
    doc: anId(DOC_ID).optional(),
    docSince: wholeNumber('docSince is the last document update you hold.', { min: 0 }).optional(),
}, 'The project stream');

module.exports = { OpenBody, DocParams, SyncBody, UpdatesBody, AwarenessBody, StreamQuery, MAX_UPDATES, UPDATE_B64_MAX };
