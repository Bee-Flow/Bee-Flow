// @typecheck strict
/**
 * Knowledge Bases — sources (K1): what a caller may send to create or change
 * a source. Split out of sources.js (the documents query stays there, next
 * to the shared ./docFilters it is built from); behaviour unchanged.
 *
 * Every schema is `.strict()`. A config key the router does not read is a
 * client bug, and answering 201 to it means the source is created without the
 * setting the person typed, with nothing on screen to say so.
 */

const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const { CREATABLE_KINDS, REFRESH_MODES_BY_KIND, MAX_CRAWL_PAGES } = require('./sourcePolicy');
const { FIELDS: MEETING_FIELDS } = require('../../core/kb/sources/meetingTag');

const NAME_TEXT = 'A source name must be text.';
const SourceName = worded(NAME_TEXT).trim().max(200, 'A source name is at most 200 characters.');

/** Every mode any kind admits; WHICH kind admits which is policy, not shape. */
const REFRESH_MODES = Object.freeze([...new Set(Object.values(REFRESH_MODES_BY_KIND).flat())]);
const MODE_TEXT = `A refresh mode is one of: ${REFRESH_MODES.join(', ')}.`;
const CRON_TEXT = 'A refresh schedule is a cron expression of 5 or 6 fields, like "0 7 * * *".';

/**
 * @param {string} tz
 */
const knownTimeZone = (tz) => {
    if (!tz) return true;
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; }
    catch (_) { return false; }
};

/** `null` and `''` both mean "no schedule" — what switching back to manual sends. */
const RefreshRule = z.object({
    mode: z.enum(REFRESH_MODES, { error: () => MODE_TEXT }).optional(),
    cron: worded(CRON_TEXT).trim().max(200, CRON_TEXT)
        .refine((v) => !v || /^\S+(\s+\S+){4,5}$/.test(v), CRON_TEXT)
        .nullish(),
    tz: worded('A time zone must be text.').trim().max(64, 'A time zone is at most 64 characters.')
        .refine(knownTimeZone, { error: (iss) => `Unknown time zone: ${iss.input}` })
        .nullish(),
}, { error: typeError({ invalid: 'A refresh rule is an object like { mode, cron, tz }.' }) }).strict();

const TEXT_TEXT = 'A text source needs at least three characters of text.';
const URL_TEXT = 'A web source needs an address.';
const TAG_TEXT = 'A meeting source needs a tag.';
const TABLE_TEXT = 'A table source needs a table.';
const CONFIG_TEXT = 'config is an object describing the source.';

/** The `config` each CREATABLE kind accepts; a kind absent here has no shape yet. */
const CONFIG_BY_KIND = Object.freeze({
    text: z.object({
        // Refined rather than trimmed: the snippet is stored and counted as it
        // was typed, so trimming it here would change what got saved.
        text: worded(TEXT_TEXT).refine((v) => v.trim().length >= 3, TEXT_TEXT),
        title: worded('A source title must be text.').trim().max(200).optional(),
        // shapeTextOrigin holds the allow-list, and it is the SAME one applied
        // on the way out, so the two directions cannot drift apart.
        metadata: z.unknown().optional(),
    }, { error: typeError({ invalid: CONFIG_TEXT }) }).strict(),
    upload: z.object({}, { error: typeError({ invalid: CONFIG_TEXT }) }).strict(),
    webpage: z.object({
        url: worded(URL_TEXT).trim().min(1, URL_TEXT),
        crawl: z.object({
            // Clamped rather than refused: a client asking for "everything"
            // sends a big number and means it.
            maxPages: z.coerce.number().catch(1)
                .transform((n) => Math.min(Math.max(Math.trunc(n) || 1, 1), MAX_CRAWL_PAGES)),
        }, { error: typeError({ invalid: 'crawl is an object like { maxPages }.' }) }).strict().nullish(),
    }, { error: typeError({ invalid: CONFIG_TEXT }) }).strict(),
    meeting_tag: z.object({
        tag: worded(TAG_TEXT).trim().min(1, TAG_TEXT),
        fields: z.array(
            z.enum(MEETING_FIELDS, { error: () => `A meeting field is one of: ${MEETING_FIELDS.join(', ')}.` }),
            { error: typeError({ invalid: 'fields is a list of meeting fields.' }) },
        ).optional(),
    }, { error: typeError({ invalid: CONFIG_TEXT }) }).strict(),
    datatable: z.object({
        datatableId: worded(TABLE_TEXT).trim().min(1, TABLE_TEXT),
        columns: z.array(worded('A column name must be text.'), { error: typeError({ invalid: 'columns is a list of column names.' }) }).optional(),
        titleColumn: worded('titleColumn must be the name of a column.').trim().min(1, 'titleColumn must be the name of a column.').optional(),
    }, { error: typeError({ invalid: CONFIG_TEXT }) }).strict(),
});

/**
 * A source's `config` is whatever its KIND says it is, so it is parsed once
 * the kind is known and its issues are reported under `config.<field>`.
 *
 * A kind with no schema is handed on untouched: "that kind is not available
 * yet" is a feature-flag answer carrying the list a client may offer
 * (`kind_not_available`, which the Studio renders), not a malformed request.
 * @template {{ kind: string, config?: unknown }} T
 * @param {T} body
 * @param {import('zod').RefinementCtx} ctx
 */
function withKindConfig(body, ctx) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_BY_KIND, body.kind)) return body;
    const parsed = CONFIG_BY_KIND[/** @type {keyof typeof CONFIG_BY_KIND} */ (body.kind)].safeParse(body.config === undefined ? {} : body.config);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
        return z.NEVER;
    }
    return { ...body, config: parsed.data };
}

const KIND_TEXT = `A source needs a kind — one of: ${CREATABLE_KINDS.join(', ')}.`;
const BODY_TEXT = 'A source is described by an object.';

const CreateSourceBody = z.object({
    kind: worded(KIND_TEXT).trim().min(1, KIND_TEXT),
    name: SourceName.optional(),
    config: z.unknown().optional(),
    refresh: RefreshRule.optional(),
}, { error: typeError({ required: BODY_TEXT, invalid: BODY_TEXT }) }).strict().transform(withKindConfig);

const NAME_BLANK = 'A source name cannot be blank.';
const PatchSourceBody = z.object({
    name: SourceName.min(1, NAME_BLANK).optional(),
    refresh: RefreshRule.optional(),
}, { error: typeError({ required: BODY_TEXT, invalid: BODY_TEXT }) }).strict();

module.exports = { CreateSourceBody, PatchSourceBody };
