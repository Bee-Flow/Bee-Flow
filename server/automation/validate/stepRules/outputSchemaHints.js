// @typecheck strict
/**
 * An ai_step's output schema as the validator shows it in a finding: the shape
 * a person reads, the explicit schema to paste, and the flat example for
 * fields nothing can infer a shape for.
 */

const { isObject } = require('../helpers');

const MAX_SHAPE_CHARS = 400;
const MAX_SCHEMA_HINT_CHARS = 600;

/**
 * A key as the shape writes it: bare when it reads as a name, else quoted.
 * @param {string} k
 */
const shapeKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

/**
 * A JSON Schema as a person reads it: `{customer: {contacts: [{email:
 * string}]}, line_items: [{sku: string}]}`. Capped, so a huge inferred schema
 * cannot swamp the message.
 * @param {Record<string, any>} schema
 */
function schemaShape(schema) {
    /**
     * @param {Record<string, any>} s
     * @param {number} depth
     * @returns {string}
     */
    const walk = (s, depth) => {
        if (!isObject(s) || depth > 6) return 'string';
        if (s.type === 'array') return s.items ? `[${walk(s.items, depth + 1)}]` : '[]';
        if (s.type === 'object' && isObject(s.properties)) {
            return `{${Object.entries(s.properties).map(([k, v]) => `${shapeKey(k)}: ${walk(v, depth + 1)}`).join(', ')}}`;
        }
        return typeof s.type === 'string' ? s.type : 'string';
    };
    const out = walk(schema, 0);
    return out.length > MAX_SHAPE_CHARS ? `${out.slice(0, MAX_SHAPE_CHARS - 1)}…` : out;
}

/**
 * `outputSchema: {…}` for the hint: the inferred schema itself, or its first fields when it is long.
 * @param {Record<string, any>} schema
 */
function explicitSchemaHint(schema) {
    let json = JSON.stringify(schema);
    if (json.length > MAX_SCHEMA_HINT_CHARS && isObject(schema.properties)) {
        const first = Object.fromEntries(Object.entries(schema.properties).slice(0, 3));
        json = JSON.stringify({ type: 'object', properties: first });
    }
    return `outputSchema: ${json}. Numbers as {"type":"number"}.`;
}

/**
 * The flat example for fields the runner cannot infer a shape for.
 * @param {string[]} fields
 */
function flatSchemaHint(fields) {
    return `outputSchema: {"type":"object","properties":{${fields.slice(0, 3).map(f => `${JSON.stringify(f)}:{"type":"string"}`).join(',')}}}. Numbers as {"type":"number"}.`;
}

module.exports = { schemaShape, explicitSchemaHint, flatSchemaHint };
