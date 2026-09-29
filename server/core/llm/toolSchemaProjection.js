// @typecheck
/**
 * Tool schemas as a chat template can actually render them.
 *
 * A self-hosted runtime does not hand the model our JSON Schema — its chat
 * template renders the tool list into the system turn, and a template only
 * knows a handful of keywords. Measured on Gemma 4's template (llama-server
 * `/props`, 2026-09-17): only `description | type | enum | items | properties
 * | required | nullable` survive. Everything else is either dropped or, worse,
 * rendered as the literal it is not:
 *   · `type: ['string', 'null']` comes out as the text `['STRING', 'NULL']`
 *     (`app_bind_action.actionId`) — the model reads a type it has never seen;
 *   · `default`, `format`, `examples`, `title`, `$comment` and the numeric /
 *     length bounds are simply invisible, so they cost the model nothing but
 *     cost the request bytes and, on a hand-written schema, drift silently.
 *
 * So the local adapter projects the tools before sending them to a Gemma 4
 * model: a `[T, 'null']` union becomes `type: T, nullable: true` (which the
 * template renders), and the invisible keywords are dropped.
 *
 * The union is NOT also kept as an `anyOf` for a grammar. The first cut did
 * that, on the premise that llama.cpp's json-schema-to-grammar would read it;
 * it does not apply here — with Gemma 4 the runtime's grammar forces the
 * tool-call STRUCTURE only, never the argument schema (maintainer statement,
 * Apr 2026) — and the template is not neutral about the key either. Verified
 * on the live router's /apply-template (2026-09-18): the template filters
 * unknown keys at a property node, but under array `items` it renders every
 * key verbatim (`items:{anyOf:[{<|"|>type<|"|>:…}],…}` — fenced pseudo-JSON
 * the model has never seen in a declaration), and on an object WITHOUT
 * `properties` it renders the node's own keys as fields, so the anyOf became
 * a phantom property named `anyOf` with an empty type. Nothing reads it,
 * two positions leak it: it is gone. `type: T, nullable: true` written
 * directly in a schema is therefore exactly what the projection produces.
 *
 * Two rules keep this safe:
 *   1. Keywords are removed at SCHEMA NODES only — never inside `properties`
 *      as property NAMES. A tool whose argument is literally called `format`
 *      or `maxItems` keeps it.
 *   2. `additionalProperties` is left alone on purpose. It leaks into the
 *      rendered text, but it measurably helped the model keep
 *      `builder_add_steps.steps.items` closed, so it stays.
 *
 * Pure and non-mutating: TOOL_SCHEMAS are module constants shared with the
 * MCP endpoints and the cloud providers, which want the untouched originals.
 */

'use strict';

// Keywords with no rendering on the Gemma 4 template and no effect on the
// tool-call structure the runtime's grammar enforces. Approved list — see the
// 2026-09-17 plan; `additionalProperties` is deliberately NOT here.
const UNRENDERABLE_KEYS = new Set([
    'default', 'format', 'examples', 'title', '$comment',
    'pattern', 'minimum', 'maximum', 'minItems', 'maxItems',
]);

// Keywords whose value is ONE schema node.
const SINGLE_SCHEMA_KEYS = new Set([
    'items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames',
]);
// Keywords whose value is a LIST of schema nodes.
const LIST_SCHEMA_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
// Keywords whose value is a MAP of name → schema node. The keys of these maps
// are names, never keywords, and are copied verbatim.
const MAP_SCHEMA_KEYS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);

// The families whose template needs the projection. Keyed on the `family`
// describeLocalModel reports, so the adapter and this module agree.
const PROJECTED_FAMILIES = new Set(['Gemma 4']);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * One schema node → the same node as the template can render it. Recurses
 * through every position that holds a schema; leaves values it does not
 * recognise (enum lists, required lists, descriptions, booleans) verbatim.
 */
function projectSchemaNode(node) {
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (UNRENDERABLE_KEYS.has(key)) continue;
        if (MAP_SCHEMA_KEYS.has(key) && isPlainObject(value)) {
            const mapped = {};
            for (const name of Object.keys(value)) mapped[name] = projectSchemaNode(value[name]);
            out[key] = mapped;
        } else if (LIST_SCHEMA_KEYS.has(key) && Array.isArray(value)) {
            out[key] = value.map(projectSchemaNode);
        } else if (SINGLE_SCHEMA_KEYS.has(key) && isPlainObject(value)) {
            out[key] = projectSchemaNode(value);
        } else {
            out[key] = value;
        }
    }
    return liftNullUnion(out);
}

/**
 * `type: [T, 'null']` → `type: T, nullable: true`, the two keys the template
 * renders, and nothing else added (see the module header for why there is
 * no `anyOf`). Everything else on the node — items, enum, properties, an
 * `anyOf` the author wrote — stays where it was. Any other type list (two
 * concrete types, three entries) is left as the author wrote it.
 */
function liftNullUnion(node) {
    if (!Array.isArray(node.type) || node.type.length !== 2 || !node.type.includes('null')) return node;
    const concrete = node.type.find(t => t !== 'null');
    if (typeof concrete !== 'string') return node;
    return { ...node, type: concrete, nullable: true };
}

/**
 * Project a tool list. Every tool comes back as a NEW object with its
 * `function.parameters` projected; tools without parameters, and entries that
 * are not function tools, pass through untouched (same reference).
 *
 * @param {Array} tools - OpenAI-format tool definitions
 * @returns {Array} projected copies
 */
function stripUnrenderableKeys(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.map((tool) => {
        const params = tool && tool.function && tool.function.parameters;
        if (!isPlainObject(params)) return tool;
        return { ...tool, function: { ...tool.function, parameters: projectSchemaNode(params) } };
    });
}

/**
 * The adapter-facing entry: project only for the families whose template
 * needs it, and hand every other model its tools exactly as given.
 *
 * @param {Array} tools
 * @param {{ family?: string|null }} [opts] - `family` as describeLocalModel reports it
 */
function projectToolsForTemplate(tools, { family } = {}) {
    if (!family || !PROJECTED_FAMILIES.has(family)) return tools;
    return stripUnrenderableKeys(tools);
}

module.exports = {
    UNRENDERABLE_KEYS,
    PROJECTED_FAMILIES,
    projectSchemaNode,
    stripUnrenderableKeys,
    projectToolsForTemplate,
};
