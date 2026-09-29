'use strict';
/**
 * What an App Studio app's runtime may send — the requests the app itself
 * makes while someone uses it. Shared by the signed-in routes
 * (studioAppsRun.js, studioAppData.js) and the public ones
 * (studioAppPublic.js), because the public transport rewrites the very same
 * requests onto /api/public-app/<token>/… (publicAppTransport.js), bodies
 * unchanged.
 *
 * Closed at the top level. The bags inside (`formValues`, `vars`) are the
 * app's own form fields and variables: their keys are whatever the author
 * declared, and sanitizeBag is what bounds them. What these close:
 *
 *   - `wait: "false"` on an action run still waited up to a minute.
 *   - `?draft=yes` ran the PUBLISHED definition while the owner was editing
 *     the draft; only `1` and `true` ever meant draft.
 *   - `?filter=` that is not JSON was dropped, so a filtered list showed
 *     every row the viewer may read, as if they were the filtered ones.
 */

const { z, worded, bodyOf, queryOf, choice, wholeNumber } = require('../../core/http/schemaParts');

const bag = (name) => z.record(z.unknown(), { invalid_type_error: `${name} is an object of named values.` });

const DraftQuery = queryOf({
    draft: choice(['0', '1', 'true', 'false'], 'draft is 1 to run the saved draft.').optional(),
}, 'An app request');

/** One server step of an action (…/actions/:actionId/step). */
const StepBody = bodyOf({
    stepIndex: wholeNumber('stepIndex is the position of the step in the action.'),
    formValues: bag('formValues').nullish(),
    vars: bag('vars').nullish(),
    // The loop's current row and the trigger's value: client-supplied, bounded
    // by the body-size guard, read by the executor as scope roots.
    item: z.unknown(),
    index: wholeNumber('index is the loop position, 0 or more.').nullish(),
    value: z.unknown(),
}, 'An action step');

/** A whole action handed to its automation (…/actions/:actionId/run). */
const RunBody = bodyOf({
    formValues: bag('formValues').nullish(),
    wait: z.boolean({ invalid_type_error: 'wait is true or false.' }).optional(),
}, 'An action run');

/** A turn of an app's AI chat component (…/ai/chat). */
const ChatBody = bodyOf({
    nodeId: worded('nodeId is the id of the chat component.').max(200, 'nodeId is the id of the chat component.'),
    messages: z.array(z.object({
        role: worded('role is user or assistant.').max(20, 'role is user or assistant.').optional(),
        content: z.unknown(),
    }).passthrough(), { required_error: 'messages is the conversation so far.', invalid_type_error: 'messages is the conversation so far.' }),
}, 'An AI chat turn');

const JSON_TEXT = (name) => `${name} is JSON, as the app runtime sends it.`;
const jsonText = (name) => worded(JSON_TEXT(name)).max(20_000, JSON_TEXT(name)).refine((v) => {
    try { JSON.parse(v); return true; } catch { return false; }
}, JSON_TEXT(name));

/** A page of a table (…/data/tables/:tableId/records). */
const RecordsQuery = queryOf({
    filter: jsonText('filter').optional(),
    sort: jsonText('sort').optional(),
    cursor: worded('cursor is the value the previous page handed back.').max(500, 'cursor is the value the previous page handed back.').optional(),
    limit: wholeNumber('limit is a whole number, 1 or more.', { min: 1 }).optional(),
    // The editor's preview asks for a sample; the page size already covers it.
    sample: choice(['0', '1'], 'sample is 1 for an editor preview.').optional(),
}, 'A table page');

module.exports = { DraftQuery, StepBody, RunBody, ChatBody, RecordsQuery };
