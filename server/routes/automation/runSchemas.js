// @typecheck strict
// The bodies and queries of the run endpoints (routes/automation/runs.js),
// split out of it. Every schema is `.strict()`.
const { z, worded, orEmpty, typeError } = require('../../core/http/schemaParts');

// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`, and on the LIST routes that is the point: a
// misspelled filter would be dropped, and a list that quietly drops a
// narrowing parameter answers a wider question than the one it was asked —
// the same failure the trigger-source check in crud.js exists to prevent.

/**
 * A body that also accepts no body at all (schemaParts' orEmpty), closed with zod's own wording.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 */
const bodyOf = (shape) => orEmpty(z.object(shape).strict());

/**
 * @param {string} name
 * @param {string} what
 */
const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();
/**
 * Comma-separated on the wire; parseRunFilters splits it.
 * @param {string} name
 */
const list = (name) => worded(`${name} is a comma-separated list.`).trim().optional();
/**
 * @param {string} name
 */
const whole = (name) => z.coerce.number({ error: typeError({ invalid: `${name} must be a number.` }) })
    .int(`${name} must be a whole number.`).optional();

const STEP_TEXT = 'triggerStepId is the id of a trigger on this automation.';
const RUN_SHAPE = {
    // What the run ENTERS with — a form submission, an inbound message. The
    // runner reads it; this route only carries it.
    triggerPayload: z.unknown().optional(),
    triggerStepId: worded(STEP_TEXT).trim().min(1, STEP_TEXT).nullish(),
};
const RunBody = bodyOf({
    ...RUN_SHAPE,
    // Handoff 5: the builder's Test button. A test run executes the WORKING
    // copy (unpublished changes included) and is marked is_test; without it a
    // manual run executes what is live.
    test: z.boolean({ error: typeError({ invalid: 'test is true or false.' }) }).optional(),
});

const SEED_TEXT = 'seedRunId is the id of a run of this automation.';
const PARTIAL_TEXT = 'mode is "only", "from" or "upTo".';
const PartialRunBody = bodyOf({
    ...RUN_SHAPE,
    // An enum, not a fall-back: `upto` for `upTo` used to run ONLY that step
    // instead of everything leading to it, and answer 200 either way.
    mode: z.enum(['only', 'from', 'upTo'], { error: () => PARTIAL_TEXT }).default('only'),
    // Re-run from a chosen run: take the replay from exactly that run (see
    // core/automationRunner/replaySeeding.seedReplayStateFromRun). Without
    // seedRunId none of the three means anything and the step runs as before.
    seedRunId: worded(SEED_TEXT).trim().min(1, SEED_TEXT).max(200, SEED_TEXT).nullish(),
    allowLiveUpstream: z.boolean({ error: typeError({ invalid: 'allowLiveUpstream is true or false.' }) }).optional(),
    confirmSideEffects: z.boolean({ error: typeError({ invalid: 'confirmSideEffects is true or false.' }) }).optional(),
});
// What a re-run from a chosen run would do, asked before doing it.
const RerunPlanQuery = z.object({
    seedRunId: worded(SEED_TEXT).trim().min(1, SEED_TEXT).max(200, SEED_TEXT),
    mode: z.enum(['only', 'from'], { error: () => 'mode is "only" or "from".' }).default('only'),
    triggerStepId: one('triggerStepId', 'the id of a trigger on this automation'),
}).strict();

const SEARCH_TEXT = 'q is a search term of at most 100 characters.';
const TESTS_TEXT = 'tests is "include", "exclude" or "only".';
const RunsQuery = z.object({
    status: list('status'),
    triggerKind: list('triggerKind'),
    trigger: list('trigger'),
    mode: list('mode'),
    automationId: one('automationId', 'the id of an automation'),
    kind: one('kind', 'an automation kind'),
    since: one('since', 'an ISO timestamp'),
    until: one('until', 'an ISO timestamp'),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
    limit: whole('limit'),
    // Handoff 5 Runs tab. `q`: run link, file name, person, words of the
    // outcome (runListing.buildRunSearch). `startedBy`: a user id, or "me".
    // `tests`: test runs in (default), out, or only.
    q: worded(SEARCH_TEXT).trim().max(100, SEARCH_TEXT).optional(),
    startedBy: one('startedBy', 'a user id or "me"'),
    tests: z.enum(['include', 'exclude', 'only'], { error: () => TESTS_TEXT }).optional(),
}).strict();

const FacetsQuery = z.object({
    range: whole('range'),
    automationId: one('automationId', 'the id of an automation'),
    kind: one('kind', 'an automation kind'),
    mode: list('mode'),
}).strict();

const StreamQuery = z.object({
    automationId: one('automationId', 'the id of an automation'),
}).strict();

const CRON_TEXT = 'A cron expression is required — the schedule to preview.';
const SchedulePreviewBody = z.object({
    cron: worded(CRON_TEXT).trim().min(1, CRON_TEXT),
    tz: worded('tz must be a time zone.').trim().min(1, 'tz must be a time zone.').prefault('Europe/Amsterdam'),
    // Clamped rather than refused: asking for more previews than the builder
    // draws is not a mistake worth a 400.
    count: z.coerce.number().catch(3)
        .transform((n) => Math.min(Math.max(Math.trunc(n) || 3, 1), 5))
        .prefault(3),
    // schedule.skipHolidays (handoff 5): leave Dutch public holidays out, as
    // the scheduler does (automation/holidays.js).
    skipHolidays: z.boolean({ error: typeError({ invalid: 'skipHolidays is true or false.' }) }).optional(),
}).strict();

const ITEMS_TEXT = 'items is the list of notice items you were shown.';
/** The items a person was shown when they confirmed the one-time connections notice. */
const SeenBody = z.object({
    items: z.array(worded(ITEMS_TEXT).trim().min(1, ITEMS_TEXT).max(100, ITEMS_TEXT), { error: () => ITEMS_TEXT }).max(100, ITEMS_TEXT),
}).strict();

module.exports = { SeenBody, RunBody, PartialRunBody, RerunPlanQuery, RunsQuery, FacetsQuery, StreamQuery, SchedulePreviewBody };
