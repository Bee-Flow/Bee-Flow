// @typecheck strict
/**
 * Request schemas of routes/cowork.js (see the header there for what they close).
 * Kept apart so the route file stays what it is: the routes.
 */

const { z, typeError, datetimeWithOffset } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');

const VALID_REPEAT_INTERVALS = new Set([
    'hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly',
]);
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Request schemas (see the header) ────────────────────────────────

/**
 * A body that also accepts no body at all: Express 5 leaves `req.body` undefined then.
 * @param {Record<string, import('zod').ZodType>} shape
 */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/**
 * '' from a cleared form field means the same as null.
 * @param {import('zod').ZodNullable<import('zod').ZodString> | import('zod').ZodNullable<import('zod').ZodEnum<{ [x: string]: string; }>>} schema
 */
const blankIsNull = (schema) => z.preprocess((v) => (v === '' ? null : v), schema);

// An unknown zone would make the runner's Intl.DateTimeFormat throw on every
// tick — a schedule that silently never runs. Reject it at the door.
/**
 * @param {string} value
 */
function isKnownTimezone(value) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return true;
    } catch (_) {
        return false;
    }
}

const REPEAT_TEXT = `repeatInterval is one of ${[...VALID_REPEAT_INTERVALS].join(', ')}, or null.`;
const repeatIntervalField = blankIsNull(
    z.enum([...VALID_REPEAT_INTERVALS], { error: () => REPEAT_TEXT }).nullable(),
);

// A weekday is its three-letter token or (a start of) its English name:
// `mon`, `Monday`, `tues`. `slice(0, 3)` alone also let `month` and
// `sunshine` through, and dropped `ma`/`di` without a word.
const DAYS_TEXT = 'daysOfWeek is a list of weekdays (sun, mon, tue, wed, thu, fri, sat), or null.';
const weekday = worded(DAYS_TEXT).transform((v, ctx) => {
    const word = v.trim().toLowerCase();
    const name = word.length >= 3 ? DAY_NAMES.find((d) => d.startsWith(word)) : null;
    if (!name) {
        ctx.addIssue({ code: 'custom', message: `"${v}" is not a weekday. ${DAYS_TEXT}` });
        return z.NEVER;
    }
    return name.slice(0, 3);
});
// An EMPTY list means "no day restriction", which is stored as null.
const daysOfWeekField = z.array(weekday, { error: typeError({ invalid: DAYS_TEXT }) }).nullable()
    .transform((list) => (list && list.length > 0 ? Array.from(new Set(list)) : null));

const TIME_TEXT = 'timeOfDay is a 24-hour time like 09:00, or null.';
const timeOfDayField = blankIsNull(worded(TIME_TEXT).regex(/^([01]\d|2[0-3]):[0-5]\d$/, TIME_TEXT).nullable());

const TZ_TEXT = 'timezone is an IANA zone name like Europe/Amsterdam.';
const timezoneField = blankIsNull(
    worded(TZ_TEXT).refine(isKnownTimezone, { error: (iss) => `Unknown timezone: ${iss.input}` }).nullable(),
);

// Which apps THIS item may use. `null` means "no per-item restriction", i.e.
// fall back to the user's workspace-wide list — the behaviour every schedule
// had before the column existed. An EMPTY array is a real answer ("this one
// may use nothing") and must not collapse to null.
const APPS_TEXT = 'enabledApps is a list of app ids, or null.';
const enabledAppsField = z.array(worded(APPS_TEXT), { error: typeError({ invalid: APPS_TEXT }) }).nullable()
    .transform((list) => (list === null ? null : Array.from(new Set(list.map((v) => v.trim()).filter(Boolean)))));

// What starts an item. `filter` has the shape of the automation app-event
// trigger's filter (gmail: from, to, subjectContains, labelIds, hasAttachment,
// excludeFromSelf ...; msgraph: mailbox 'me' or a shared address, plus its
// fields), and is interpreted by the same matchers, so unknown keys are kept.
const TRIGGER_KIND_TEXT = "triggerKind is 'schedule' or 'app_event'.";
const TRIGGER_TEXT = "trigger is { provider: 'gmail' | 'msgraph', event: 'mail.new', filter?: object }, or null.";
const MAX_FILTER_BYTES = 4000;
const triggerField = z.object({
    provider: z.enum(['gmail', 'msgraph'], { error: () => TRIGGER_TEXT }),
    event: z.literal('mail.new', { error: () => TRIGGER_TEXT }),
    filter: z.record(z.string(), z.unknown(), { error: () => 'trigger.filter is an object.' })
        .refine((f) => JSON.stringify(f).length <= MAX_FILTER_BYTES, { error: 'trigger.filter is too large.' })
        .nullish(),
}, { error: typeError({ invalid: TRIGGER_TEXT }) }).strict();

const TITLE_TEXT = 'Title is required.';
const PROMPT_TEXT = 'Prompt is required.';
const NEXT_RUN_TEXT = 'nextRunAt is required: an ISO timestamp with a time zone, like 2026-09-23T07:00:00.000Z.';
const scheduleFields = {
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(500, 'A title is at most 500 characters.'),
    prompt: worded(PROMPT_TEXT).trim().min(1, PROMPT_TEXT),
    nextRunAt: worded(NEXT_RUN_TEXT).regex(datetimeWithOffset, NEXT_RUN_TEXT).optional(),
    triggerKind: z.enum(['schedule', 'app_event'], { error: () => TRIGGER_KIND_TEXT }).optional(),
    trigger: triggerField.nullish(),
    repeatInterval: repeatIntervalField.optional(),
    // Open text on purpose: see the header.
    modelTier: worded('modelTier names a model tier.').trim().max(100, 'modelTier is at most 100 characters.').nullish(),
    timezone: timezoneField.optional(),
    daysOfWeek: daysOfWeekField.optional(),
    timeOfDay: timeOfDayField.optional(),
    agentId: worded('agentId names one of your agents.').trim().max(200, 'agentId is at most 200 characters.').nullish(),
    enabledApps: enabledAppsField.optional(),
};

const CreateBody = z.object({
    ...scheduleFields,
    startNow: z.boolean({ error: typeError({ invalid: 'startNow is true or false.' }) }).optional(),
}).strict().superRefine((b, ctx) => {
    const issue = (/** @type {string} */ path, /** @type {string} */ message) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (b.triggerKind === 'app_event') {
        if (!b.trigger) issue('trigger', 'An event-triggered item needs a trigger: ' + TRIGGER_TEXT);
        if (!b.agentId) issue('agentId', 'An event-triggered item runs an agent: agentId is required.');
        if (b.startNow === true) issue('startNow', 'An event-triggered item starts on its event, not on startNow.');
    } else {
        if (!b.nextRunAt) issue('nextRunAt', NEXT_RUN_TEXT);
        if (b.trigger) issue('trigger', "trigger only goes with triggerKind 'app_event'.");
    }
});

// Every field optional: an update names only what it changes.
const UpdateBody = z.object({
    ...scheduleFields,
    title: scheduleFields.title.optional(),
    prompt: scheduleFields.prompt.optional(),
    isActive: z.boolean({ error: typeError({ invalid: 'isActive is true or false.' }) }).optional(),
}).strict();

// toggle / run-now act on the schedule as it is.
const NoBody = bodyOf({});

const BRIEF_TEXT = 'A brief is required';
const ComposeBody = z.object({
    brief: worded(BRIEF_TEXT).trim().min(1, BRIEF_TEXT),
    // Validated below, with a fallback rather than a 400 (see the header).
    timezone: worded(TZ_TEXT).nullish(),
}).strict();

const LIMIT_TEXT = 'limit is a whole number from 1 to 100.';
const OFFSET_TEXT = 'offset is a whole number, 0 or more.';
const RunsQuery = z.object({
    limit: z.coerce.number({ error: typeError({ invalid: LIMIT_TEXT }) }).int(LIMIT_TEXT).min(1, LIMIT_TEXT).max(100, LIMIT_TEXT).optional(),
    offset: z.coerce.number({ error: typeError({ invalid: OFFSET_TEXT }) }).int(OFFSET_TEXT).min(0, OFFSET_TEXT).optional(),
}).strict();

module.exports = { CreateBody, UpdateBody, NoBody, ComposeBody, RunsQuery, isKnownTimezone, TRIGGER_TEXT, NEXT_RUN_TEXT };
