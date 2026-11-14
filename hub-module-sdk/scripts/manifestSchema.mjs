/**
 * manifestSchema.mjs: check a module manifest against MANIFEST.schema.json.
 *
 * pack.mjs calls this before it writes a package, so a manifest the schema
 * refuses never becomes a .bfmod. The product's verifier
 * (server/modules/packageVerify.js) enforces the load-bearing subset again at
 * install; this is the authoring-time check of the whole shape.
 *
 * The schema is draft-07, and it uses a small part of it: type, properties,
 * required, additionalProperties, items, enum, pattern, minimum, minLength and
 * maxLength. That part is implemented here, so the SDK needs no validator
 * dependency. A keyword outside it makes `validate` throw rather than pass: the
 * schema cannot grow a rule this file silently ignores.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'MANIFEST.schema.json');

/**
 * The part of a JSON Schema node this validator reads.
 * @typedef {object} SchemaNode
 * @property {string} [type]
 * @property {Record<string, SchemaNode>} [properties]
 * @property {string[]} [required]
 * @property {boolean | SchemaNode} [additionalProperties]
 * @property {SchemaNode} [items]
 * @property {unknown[]} [enum]
 * @property {string} [pattern]
 * @property {number} [minimum]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 */

/** Keywords that carry a rule. */
const RULES = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'pattern', 'minimum', 'minLength', 'maxLength']);
/** Keywords that describe and check nothing. */
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);

/** @returns {SchemaNode} the manifest schema shipped with the SDK */
export function loadManifestSchema() {
    return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

/**
 * The JSON Schema type name of a parsed JSON value.
 * @param {unknown} value
 */
function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
}

/**
 * @param {string} type  what the schema asks for
 * @param {string} actual  what typeOf found
 */
const typeMatches = (type, actual) => type === actual || (type === 'number' && actual === 'integer');

/**
 * The indefinite article a type name takes: an array, an integer, an object; a string.
 * @param {string} name
 */
const article = (name) => (['a', 'e', 'i', 'o'].some((vowel) => name.startsWith(vowel)) ? 'an' : 'a');

/**
 * Collect every way `value` breaks `schema`, as sentences that name the place.
 * @param {SchemaNode} schema
 * @param {unknown} value
 * @param {string} at  where `value` sits in the manifest, e.g. `server.workers[0]`
 * @param {string[]} problems
 */
function check(schema, value, at, problems) {
    for (const keyword of Object.keys(schema)) {
        if (!RULES.has(keyword) && !ANNOTATIONS.has(keyword)) {
            throw new Error(`manifestSchema: the schema uses "${keyword}" at ${at}, which this validator does not implement`);
        }
    }
    const actual = typeOf(value);
    if (schema.type && !typeMatches(schema.type, actual)) {
        problems.push(`${at} must be ${article(schema.type)} ${schema.type}, not ${article(actual)} ${actual}`);
        return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        problems.push(`${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    }
    if (typeof value === 'string') {
        // nosemgrep: ajinabraham.njsscan.dos.regex_injection.regex_injection_dos -- the pattern is the SDK's own MANIFEST.schema.json, tested on the author's own manifest when they pack it
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${at} does not match ${schema.pattern}`);
        if (schema.minLength != null && value.length < schema.minLength) problems.push(`${at} must be at least ${schema.minLength} characters`);
        if (schema.maxLength != null && value.length > schema.maxLength) problems.push(`${at} must be at most ${schema.maxLength} characters`);
    }
    if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) {
        problems.push(`${at} must be at least ${schema.minimum}`);
    }
    if (Array.isArray(value) && schema.items) {
        const items = schema.items;
        value.forEach((item, i) => check(items, item, `${at}[${i}]`, problems));
    }
    if (actual === 'object') {
        const object = /** @type {Record<string, unknown>} */ (value);
        const properties = schema.properties || {};
        for (const key of schema.required || []) {
            if (!(key in object)) problems.push(`${at === 'manifest' ? '' : `${at}.`}${key} is required`);
        }
        for (const [key, child] of Object.entries(object)) {
            const where = at === 'manifest' ? key : `${at}.${key}`;
            const known = properties[key];
            if (known) check(known, child, where, problems);
            else if (schema.additionalProperties === false) problems.push(`${where} is not a field of the manifest schema`);
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, child, where, problems);
        }
    }
}

/**
 * Every way `manifest` breaks the schema; an empty list means it is valid.
 * @param {unknown} manifest
 * @param {SchemaNode} [schema]
 * @returns {string[]}
 */
export function validateManifest(manifest, schema = loadManifestSchema()) {
    /** @type {string[]} */
    const problems = [];
    check(schema, manifest, 'manifest', problems);
    return problems;
}

/**
 * Throw one Error that lists every problem, or return when there is none.
 * @param {unknown} manifest
 */
export function assertValidManifest(manifest) {
    const problems = validateManifest(manifest);
    if (problems.length > 0) {
        throw new Error(`manifest.json does not match MANIFEST.schema.json:\n  - ${problems.join('\n  - ')}`);
    }
}
