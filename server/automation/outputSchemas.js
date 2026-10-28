// @typecheck
/**
 * Output Schemas — JSON-schema-lite definitions matching what the actual
 * integration tools return at runtime. Used by:
 *   1. The Builder agent — to know exactly what fields are available
 *      downstream (so it doesn't have to guess "items" vs "results").
 *   2. The runner — during dry-run, to synthesize realistic placeholder
 *      output for side-effect tools (which we never call in dry-run).
 *
 * These shapes were verified against the actual `return` statements in
 * server/integrations/*. When you change a tool's output shape, update
 * the matching entry here.
 *
 * The "shape" field is a flat description of the top-level fields the AI most commonly
 * needs to bind to. The "sample" field is a realistic value used for dry-run synthesis.
 */

const { OUTPUT_SCHEMAS_PART_1 } = require('./outputSchemasPart1');
const { OUTPUT_SCHEMAS_PART_2 } = require('./outputSchemasPart2');
const { OUTPUT_SCHEMAS_NEXTCLOUD_FILES } = require('./outputSchemasNextcloudFiles');
const { OUTPUT_SCHEMAS_NEXTCLOUD_GROUPWARE } = require('./outputSchemasNextcloudGroupware');
const { OUTPUT_SCHEMAS_NEXTCLOUD_APPS } = require('./outputSchemasNextcloudApps');

/**
 * One tool's entry.
 *   shape   top-level field -> a short type description ("array of { … }" marks a list a forEach can walk)
 *   sample  the dry-run placeholder, a realistic value of that shape
 *   echo    sample field (dotted path) -> the tool argument a dry run copies there, so a
 *           preview of a write shows what it would write (the path, the recipient), not a stock value
 * @typedef {{ shape?: Record<string, string>, sample?: any, echo?: Record<string, string> }} OutputSchema
 */

/** @type {Record<string, OutputSchema>} */
const OUTPUT_SCHEMAS = {
    ...OUTPUT_SCHEMAS_PART_1,
    ...OUTPUT_SCHEMAS_PART_2,
    ...OUTPUT_SCHEMAS_NEXTCLOUD_FILES,
    ...OUTPUT_SCHEMAS_NEXTCLOUD_GROUPWARE,
    ...OUTPUT_SCHEMAS_NEXTCLOUD_APPS,
};

/**
 * @param {string} toolName
 */
function getOutputSchema(toolName) {
    return OUTPUT_SCHEMAS[toolName] || null;
}

/**
 * Synthesize a typed placeholder output for dry-run when a tool has a
 * declared schema. Falls back to a name-pattern guess (so unschema'd
 * write tools still produce a plausible shape the AI can bind against),
 * and a last-resort sentinel object.
 *
 * Keyed by integration TOOL name only. A `data_extraction` step has no entry
 * here on purpose — its shape is per step, from its own `fields` — and never
 * reaches this function: execDataExtraction synthesises its dry-run output
 * from those fields itself (typed samples, `dryRunSynthesised: true`).
 *
 * Returns a deep clone so callers can mutate freely.
 * @param {string} toolName
 */
function synthesizeDryRunOutput(toolName, args) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (schema?.sample !== undefined) {
        return withEchoedInputs(JSON.parse(JSON.stringify(schema.sample)), schema.echo, args);
    }
    // Name-pattern fallback. Most write actions follow a verb suffix
    // convention; we synthesise a shape that matches what those tools
    // actually return at runtime so an automation built on top of an
    // unschema'd tool still gets a workable bind target during dry-run.
    return inferShapeFromName(toolName, args);
}

/**
 * Copy the arguments a dry run was given into the sample, where the tool would
 * answer with them: `echo` maps a sample path to an argument name. Only a
 * plain value (text, number, yes/no, or a list of those) is copied; an absent,
 * empty or structured argument leaves the sample's own value. Mutates and
 * returns `sample` (a fresh clone).
 * @template T
 * @param {T} sample
 * @param {Record<string, string> | undefined} echo
 * @param {unknown} args
 * @returns {T}
 */
function withEchoedInputs(sample, echo, args) {
    if (!echo || !sample || typeof sample !== 'object' || !args || typeof args !== 'object') return sample;
    const given = /** @type {Record<string, unknown>} */ (args);
    for (const [path, argName] of Object.entries(echo)) {
        const v = Object.prototype.hasOwnProperty.call(given, argName) ? given[argName] : undefined;
        if (isEchoable(v)) setAtPath(sample, path, Array.isArray(v) ? [...v] : v);
    }
    return sample;
}

/**
 * Set `path` (dotted) on `target` when its parent exists as a record.
 * @param {unknown} target
 * @param {string} path
 * @param {unknown} value
 */
function setAtPath(target, path, value) {
    const keys = path.split('.');
    let at = /** @type {Record<string, unknown> | null} */ (target);
    for (const k of keys.slice(0, -1)) {
        const next = at ? at[k] : null;
        at = next && typeof next === 'object' ? /** @type {Record<string, unknown>} */ (next) : null;
        if (!at) return;
    }
    if (at) at[keys[keys.length - 1]] = value;
}

/** @param {unknown} v */
const isScalar = (v) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
/** @param {unknown} v */
const isEchoable = (v) => isScalar(v) || (Array.isArray(v) && v.length > 0 && v.every(isScalar));

/**
 * What a read that found NOTHING returns, in the tool's own shape. A dry run
 * hands this on when a live read came back empty: the real answer, with every
 * list the tool declares present and empty and a missing count 0, so a forEach
 * over `.notes` iterates over nothing (which is the truth) and a binding still
 * finds its keys. Nothing is taken from the sample: a field the live answer
 * did not carry is null. Without a schema the live answer stands as it is.
 * @param {string} toolName
 * @param {unknown} [result] the live (empty) answer
 */
function emptyDryRunOutput(toolName, result) {
    const sample = OUTPUT_SCHEMAS[toolName]?.sample;
    if (Array.isArray(sample)) return Array.isArray(result) ? result : [];
    if (!sample || typeof sample !== 'object') return result;
    const isRecord = !!result && typeof result === 'object' && !Array.isArray(result);
    /** @type {Record<string, unknown>} */
    const out = isRecord ? { .../** @type {Record<string, unknown>} */ (result) } : {};
    const lists = new Set(iterableFieldsOf(toolName));
    for (const k of new Set([...Object.keys(sample), ...lists])) {
        if (lists.has(k)) out[k] = Array.isArray(out[k]) ? out[k] : [];
        else if (!(k in out)) out[k] = COUNT_KEY.test(k) ? 0 : null;
    }
    return out;
}

const COUNT_KEY = /^(count|total)$/;

const VERB_SUFFIX_SHAPES = [
    { match: /_send(_message)?$/,     sample: () => ({ sent: true, id: 'sample-id', message: 'Sent (dry-run preview).' }) },
    { match: /_reply$/,                sample: () => ({ sent: true, id: 'sample-id', message: 'Reply sent (dry-run preview).' }) },
    { match: /_compose$/,              sample: () => ({ sent: true, id: 'sample-id', message: 'Sent (dry-run preview).' }) },
    { match: /_post$/,                 sample: () => ({ id: 'sample-id', published: true, url: 'https://example.com/sample-id' }) },
    { match: /_create(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', created: true, url: 'https://example.com/sample-id' }) },
    { match: /_add(_[a-z_]+)?$/,       sample: () => ({ id: 'sample-id', added: true }) },
    { match: /_update(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', updated: true }) },
    { match: /_set(_[a-z_]+)?$/,       sample: () => ({ id: 'sample-id', set: true }) },
    { match: /_delete(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', deleted: true }) },
    { match: /_remove(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', removed: true }) },
    { match: /_move(_[a-z_]+)?$/,      sample: () => ({ id: 'sample-id', moved: true }) },
    { match: /_share(_[a-z_]+)?$/,     sample: () => ({ id: 'sample-id', shared: true, url: 'https://example.com/share/sample-id' }) },
    { match: /_write$/,                sample: () => ({ id: 'sample-id', written: true }) },
    { match: /_attach$/,               sample: () => ({ id: 'sample-id', attached: true }) },
];

/**
 * @param {string} toolName
 */
function inferShapeFromName(toolName, args) {
    if (typeof toolName !== 'string') {
        return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
    }
    for (const { match, sample } of VERB_SUFFIX_SHAPES) {
        if (match.test(toolName)) {
            return { ...sample(), _dryRun: true, _inferred: true, wouldHaveCalled: toolName };
        }
    }
    return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
}

/**
 * Lightweight description of a tool's shape, used in the Builder system
 * prompt so the AI can bind correct paths on the first try. Returns a
 * string like "results: array of { id, subject, ... }, total: integer".
 * @param {string} toolName
 */
function describeShape(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema?.shape) return null;
    if (schema.shape._string) return `(returns a string: ${schema.shape._string})`;
    return Object.entries(schema.shape).map(([k, v]) => `${k}: ${v}`).join('; ');
}

/**
 * Output field names whose value is an ARRAY — the things a per-step `forEach`
 * can iterate over (overRef = `steps.<id>.output.<field>`). Derived from the
 * declared shape (values described as "array …") plus any array fields in the
 * sample. Returns [] when the tool returns no iterable list / is unknown.
 * @param {string} toolName
 */
function iterableFieldsOf(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema) return [];
    const out = new Set();
    if (schema.shape && typeof schema.shape === 'object' && !schema.shape._string) {
        for (const [k, v] of Object.entries(schema.shape)) {
            if (k.startsWith('_')) continue;
            if (typeof v === 'string' && /array/i.test(v)) out.add(k);
        }
    }
    const sample = schema.sample;
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        for (const [k, v] of Object.entries(sample)) {
            if (Array.isArray(v)) out.add(k);
        }
    }
    return [...out];
}

/**
 * Whether a tool's output contains (or is) a list the AI can forEach over.
 * @param {string} toolName
 */
function producesList(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema) return false;
    if (Array.isArray(schema.sample)) return true;            // top-level array output
    return iterableFieldsOf(toolName).length > 0;
}

module.exports = {
    emptyDryRunOutput, OUTPUT_SCHEMAS, getOutputSchema, synthesizeDryRunOutput, describeShape, iterableFieldsOf, producesList };
