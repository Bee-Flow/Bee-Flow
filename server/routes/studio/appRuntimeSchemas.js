// @typecheck strict
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

const { z, worded, bodyOf, queryOf, closedObject, choice, wholeNumber, typeError } = require('../../core/http/schemaParts');
const { LIMITS } = require('../../appStudio/componentSpecs/limits');

/**
 * @param {string} name
 */
const bag = (name) => z.record(z.string(), z.unknown(), { error: typeError({ invalid: `${name} is an object of named values.` }) });

const DraftQuery = queryOf({
    draft: choice(['0', '1', 'true', 'false'], 'draft is 1 to run the saved draft.').optional(),
}, 'An app request');

const KIND_TEXT = 'kind is the kind of the step at stepIndex.';
const CALL_PATH_TEXT = `callPath is the list of call_action step positions, root first (at most ${LIMITS.MAX_CALL_DEPTH}).`;

const ERROR_TEXT = 'error is the failure an onError handler handles: { message, step, code, attempts, stepIndex }.';
/**
 * The `error` scope of a step inside an onError handler (the browser sends the
 * failure it handles). Bounded here; clampErrorScope bounds it again in ctx.
 */
const ErrorScope = z.object({
    message: z.string({ error: ERROR_TEXT }).max(500, ERROR_TEXT),
    step: z.string({ error: ERROR_TEXT }).max(60, ERROR_TEXT),
    code: z.string({ error: ERROR_TEXT }).max(60, ERROR_TEXT).nullish(),
    attempts: z.number({ error: ERROR_TEXT }).int(ERROR_TEXT).min(1, ERROR_TEXT).max(LIMITS.MAX_STEP_RETRY_TIMES + 1, ERROR_TEXT),
    stepIndex: z.number({ error: ERROR_TEXT }).int(ERROR_TEXT).min(0, ERROR_TEXT).optional(),
}, { error: ERROR_TEXT });

const RUN_KEY_TEXT = 'runKey is the run key the app made for this click (rk_ and 16 to 64 letters, digits, _ or -).';
const RunKey = worded(RUN_KEY_TEXT).regex(/^rk_[A-Za-z0-9_-]{16,64}$/, RUN_KEY_TEXT);

/** One server step of an action (…/actions/:actionId/step). */
const StepBody = bodyOf({
    stepIndex: wholeNumber('stepIndex is the position of the step in the action.'),
    // The kind the client believes that step has: checked against the definition, and required
    // once the action holds a step kind of the registry (actionSequence.resolveRequestedStep).
    kind: z.string({ error: KIND_TEXT }).min(1, KIND_TEXT).max(40, KIND_TEXT).optional(),
    formValues: bag('formValues').nullish(),
    vars: bag('vars').nullish(),
    // The loop's current row and the trigger's value: client-supplied, bounded
    // by the body-size guard, read by the executor as scope roots.
    item: z.unknown().optional(),
    index: wholeNumber('index is the loop position, 0 or more.').nullish(),
    value: z.unknown().optional(),
    // A step inside a called action (call_action): the call_action step positions,
    // root first — the URL keeps the root action — and the params it reads.
    callPath: z.array(wholeNumber(CALL_PATH_TEXT), { error: CALL_PATH_TEXT }).max(LIMITS.MAX_CALL_DEPTH, CALL_PATH_TEXT).optional(),
    params: bag('params').nullish(),
    // Inside an onError handler: the failure it handles (scope root `error`).
    error: ErrorScope.optional(),
    // The run log: the key that ties the server steps of one click together (appStudio/runLog/clickRuns.mts).
    runKey: RunKey.optional(),
    // Sent only by an app whose definition sets serverScope: 'wide', and read only for such an app
    // (appStudio/actionExecutor/wideScope.mts bounds them): the screen params, the other forms and the
    // action results this step's formulas name. Viewer input, like formValues and vars.
    screenParams: bag('screenParams').nullish(),
    forms: bag('forms').nullish(),
    actionResults: bag('actionResults').nullish(),
}, 'An action step');

const RUN_END_TEXT = 'status is success, error or cancelled.';
/**
 * The browser's end report of one run (…/actions/:actionId/runs/end). Every field optional, so
 * an empty body still reaches the app gate (and answers recorded: false).
 */
const RunEndBody = bodyOf({
    runKey: RunKey.optional(),
    status: choice(['success', 'error', 'cancelled'], RUN_END_TEXT).optional(),
    error: worded('error is the reason the run failed, at most 300 characters.').max(300, 'error is the reason the run failed, at most 300 characters.').optional(),
    handled: z.boolean({ error: 'handled is true when an onError handler dealt with a failure.' }).optional(),
}, 'The end of an action run');

/** A background action's start (…/actions/:actionId/background): the scope roots of the click. */
const BackgroundBody = bodyOf({
    formValues: bag('formValues').nullish(),
    vars: bag('vars').nullish(),
    item: z.unknown().optional(),
    index: wholeNumber('index is the loop position, 0 or more.').nullish(),
    value: z.unknown().optional(),
}, 'A background action start');

const RUN_ID_TEXT = 'jobId is the id the start answered with (sar_ and 32 hex characters).';
/**
 * …/actions/jobs/:jobId. Bounded here; the sar_<32 hex> shape is checked AFTER the app gate
 * (an unknown shape is the same 404 as an unknown job), so a malformed id never tells a
 * stranger more than "not found".
 */
const JobParams = closedObject({
    id: worded('id is the app id.').min(1, 'id is the app id.').max(200, 'id is the app id.'),
    jobId: worded(RUN_ID_TEXT).min(1, RUN_ID_TEXT).max(64, RUN_ID_TEXT),
}, 'A background job address');

const RESUME_TOKEN_TEXT = 'token is the resume token this run was paused with.';
/**
 * …/actions/jobs/:jobId/resume. The token travels in the body, never in the address. Bounded
 * here; whether it is this run's token is decided after the app gate, in constant time.
 */
const ResumeBody = bodyOf({
    token: worded(RESUME_TOKEN_TEXT).min(1, RESUME_TOKEN_TEXT).max(200, RESUME_TOKEN_TEXT),
    payload: z.unknown().optional(),
}, 'A resume of a run on hold');

/** …/actions/jobs?active=1&actionId=… : the caller's own runs. */
const JobsQuery = queryOf({
    active: choice(['0', '1'], 'active is 1 for running jobs only.').optional(),
    actionId: worded('actionId is the id of an action of the app.').regex(/^[A-Za-z0-9_-]{1,80}$/, 'actionId is the id of an action of the app.').optional(),
    draft: choice(['0', '1', 'true', 'false'], 'draft is 1 for runs of the saved draft.').optional(),
}, 'A background job list');

/** A whole action handed to its automation (…/actions/:actionId/run). */
const RunBody = bodyOf({
    formValues: bag('formValues').nullish(),
    wait: z.boolean({ error: typeError({ invalid: 'wait is true or false.' }) }).optional(),
}, 'An action run');

/** A turn of an app's AI chat component (…/ai/chat). */
const ChatBody = bodyOf({
    nodeId: worded('nodeId is the id of the chat component.').max(200, 'nodeId is the id of the chat component.'),
    messages: z.array(z.object({
        role: worded('role is user or assistant.').max(20, 'role is user or assistant.').optional(),
        content: z.unknown().optional(),
    }).passthrough(), { error: 'messages is the conversation so far.' }),
}, 'An AI chat turn');

/**
 * @param {string} name
 */
const JSON_TEXT = (name) => `${name} is JSON, as the app runtime sends it.`;
/**
 * @param {string} name
 */
const jsonText = (name) => worded(JSON_TEXT(name)).max(20_000, JSON_TEXT(name)).refine((v) => {
    try { JSON.parse(v); return true; } catch { return false; }
}, JSON_TEXT(name));

/** A page of a table (…/data/tables/:tableId/records). */
const RecordsQuery = queryOf({
    filter: jsonText('filter').optional(),
    sort: jsonText('sort').optional(),
    // How the filters join (all of them, or any one) and a free search over some columns.
    match: choice(['all', 'any'], 'match is all or any.').optional(),
    search: jsonText('search').optional(),
    // Up to three { field, dir } entries; when present it replaces sort.
    orderBy: jsonText('orderBy').optional(),
    // Up to five { field, pick?, as? }: the related row of a relation field, read under its own table's row rules.
    expand: jsonText('expand').optional(),
    // The columns to return (next to id).
    fields: jsonText('fields').optional(),
    cursor: worded('cursor is the value the previous page handed back.').max(500, 'cursor is the value the previous page handed back.').optional(),
    limit: wholeNumber('limit is a whole number, 1 or more.', { min: 1 }).optional(),
    // The editor's preview asks for a sample; the page size already covers it.
    sample: choice(['0', '1'], 'sample is 1 for an editor preview.').optional(),
    // 1 adds `total`: how many records the whole read matches (a paged list shows it).
    total: choice(['0', '1'], 'total is 1 to count the matching records.').optional(),
}, 'A table page');

/**
 * filter / sort / orderBy / expand / fields of a table page, from the JSON text RecordsQuery let
 * through. The compiler validates the shapes; `orderBy`, `expand` and `fields` are present only
 * when the request sent one.
 * @param {Record<string, unknown>} query
 * @returns {{ filters: unknown, sort: unknown, orderBy?: unknown, expand?: unknown, fields?: unknown }}
 */
function listQueryOf(query) {
    /** @param {string} name */
    const parsed = (name) => (typeof query[name] === 'string' && query[name] ? JSON.parse(/** @type {string} */ (query[name])) : undefined);
    const filter = parsed('filter');
    const orderBy = parsed('orderBy');
    /** @type {{ filters: unknown, sort: unknown, orderBy?: unknown, expand?: unknown, fields?: unknown }} */
    const out = { filters: filter !== undefined && !Array.isArray(filter) ? [filter] : filter, sort: parsed('sort') };
    if (orderBy !== undefined) out.orderBy = orderBy;
    return { ...out, ...relationQueryOf(query) };
}

/**
 * `expand` and `fields` of a table page, each only when the request sent one. RecordsQuery
 * already refused text that is not JSON; the compiler validates the shapes.
 * @param {Record<string, unknown>} query
 * @returns {{ expand?: unknown, fields?: unknown }}
 */
function relationQueryOf(query) {
    /** @type {{ expand?: unknown, fields?: unknown }} */
    const out = {};
    for (const name of /** @type {const} */ (['expand', 'fields'])) {
        const text = query[name];
        if (typeof text === 'string' && text) out[name] = JSON.parse(text);
    }
    return out;
}

module.exports = { listQueryOf, relationQueryOf, DraftQuery, StepBody, RunBody, RunEndBody, BackgroundBody, JobParams, JobsQuery, ResumeBody, ChatBody, RecordsQuery, ErrorScope };
