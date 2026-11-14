#!/usr/bin/env node
/**
 * gen-api-types — the request types of every server route, for agent-hub.
 *
 *   node scripts/gen-api-types.mjs           # (re)write the generated file
 *   node scripts/gen-api-types.mjs --check   # exit 1 if it is out of date
 *
 * Source: docs/static/openapi.json, which scripts/gen-api-reference.mjs writes
 *         from the running server's router (the zod schemas of each route's
 *         `validate({ body, query, params })`, converted to JSON Schema).
 * Output: agent-hub/src/api/apiTypes.generated.ts, one interface member per
 *         operation, keyed `'<METHOD> <path template>'`, with its path params,
 *         query and request body as TypeScript types. agent-hub/src/api/
 *         typedRequest.ts builds the URL from that key and sends the request.
 *
 * The spec describes no responses, so every `response` is `unknown`: a caller
 * states the type it reads. A route without a declared query or body schema
 * gets the loose `UndeclaredQuery` / `unknown`: the server reads those by hand,
 * if at all, so nothing here can say more.
 *
 * Reads only the JSON file, never the server, so check:fast can run --check
 * (`npm run lint:api-types`). A route or schema change: `npm run
 * gen:api-reference`, then `npm run gen:api-types`, and commit both.
 *
 * Zero dependencies of its own: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SPEC_REL = 'docs/static/openapi.json';
export const OUT_REL = 'agent-hub/src/api/apiTypes.generated.ts';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const IDENT = /^[A-Za-z_$][\w$]*$/;

const literal = (v) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v));
const propName = (k) => (IDENT.test(k) ? k : literal(k));
const unique = (parts) => [...new Set(parts)];
const union = (parts) => {
    const u = unique(parts);
    if (u.includes('unknown')) return 'unknown';
    return u.length ? u.join(' | ') : 'never';
};
const wrap = (t) => (/[|&]/.test(t) && !/^[{(]/.test(t) ? `(${t})` : t);

/** The members of an object type, one per line at `pad`. */
function objectMembers(schema, pad) {
    const required = new Set(schema.required || []);
    const inner = `${pad}    `;
    const lines = Object.keys(schema.properties || {}).sort().map((k) =>
        `${inner}${propName(k)}${required.has(k) ? '' : '?'}: ${toTs(schema.properties[k], inner)};`);
    return lines;
}

function objectType(schema, pad) {
    const extra = schema.additionalProperties;
    const hasProps = schema.properties && Object.keys(schema.properties).length > 0;
    if (!hasProps) {
        if (extra === false) return 'Record<string, never>';
        const value = extra && typeof extra === 'object' ? toTs(extra, pad) : 'unknown';
        const keys = schema.propertyNames && Array.isArray(schema.propertyNames.enum) ? schema.propertyNames.enum : null;
        return keys ? `Partial<Record<${union(keys.map(literal))}, ${value}>>` : `Record<string, ${value}>`;
    }
    const lines = objectMembers(schema, pad);
    // A loose object (or one with an index schema) also takes keys it does not name.
    if (extra !== false) lines.push(`${pad}    [key: string]: unknown;`);
    return `{\n${lines.join('\n')}\n${pad}}`;
}

function typeOf(name, schema, pad) {
    switch (name) {
        case 'string': return 'string';
        case 'number':
        case 'integer': return 'number';
        case 'boolean': return 'boolean';
        case 'null': return 'null';
        case 'array':
            if (Array.isArray(schema.prefixItems)) return `[${schema.prefixItems.map((s) => toTs(s, pad)).join(', ')}]`;
            return `Array<${schema.items ? toTs(schema.items, pad) : 'unknown'}>`;
        case 'object': return objectType(schema, pad);
        default: return 'unknown';
    }
}

/** A JSON Schema (the subset zod's toJSONSchema writes) as a TypeScript type. */
export function toTs(schema, pad = '') {
    if (!schema || typeof schema !== 'object') return 'unknown';
    if ('const' in schema) return literal(schema.const);
    if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
        return union((schema.anyOf || schema.oneOf).map((s) => toTs(s, pad)));
    }
    if (Array.isArray(schema.allOf)) return schema.allOf.map((s) => wrap(toTs(s, pad))).join(' & ');
    if (Array.isArray(schema.type)) return union(schema.type.map((t) => typeOf(t, schema, pad)));
    if (schema.type) return typeOf(schema.type, schema, pad);
    if (schema.properties || schema.additionalProperties !== undefined) return objectType(schema, pad);
    return 'unknown';
}

/** A path parameter: a URL segment, so a number is as good as a string unless the schema names the values. */
function paramType(schema) {
    const t = toTs(schema);
    return t === 'string' ? 'string | number' : t;
}

/**
 * One operation as `Op<Params, Query, Body>`, the trailing defaults left out: most routes
 * declare nothing, and spelling out the empty parts would triple the file.
 */
function operationType(op, pad) {
    const inner = `${pad}    `;
    const params = (op.parameters || []).filter((p) => p.in === 'path');
    const query = (op.parameters || []).filter((p) => p.in === 'query');
    const paramsType = params.length
        ? `{ ${params.map((p) => `${propName(p.name)}: ${paramType(p.schema)}`).join('; ')} }`
        : 'NoParams';
    let queryType = 'UndeclaredQuery';
    if (query.length) {
        const lines = [...query].sort((a, b) => a.name.localeCompare(b.name)).map((p) =>
            `${inner}${propName(p.name)}${p.required ? '' : '?'}: ${toTs(p.schema, inner)};`);
        queryType = `{\n${lines.join('\n')}\n${pad}}`;
    }
    const bodySchema = op.requestBody && op.requestBody.content && op.requestBody.content['application/json']
        ? op.requestBody.content['application/json'].schema
        : null;
    const parts = [paramsType, queryType, bodySchema ? toTs(bodySchema, pad) : 'unknown'];
    const defaults = ['NoParams', 'UndeclaredQuery', 'unknown'];
    while (parts.length && parts[parts.length - 1] === defaults[parts.length - 1]) parts.pop();
    return parts.length ? `Op<${parts.join(', ')}>` : 'Op';
}

/** Every operation of the spec, sorted by path, then method. */
export function operationsOf(spec) {
    const out = [];
    for (const p of Object.keys(spec.paths || {}).sort()) {
        for (const m of METHODS) {
            const op = spec.paths[p][m];
            if (op) out.push({ key: `${m.toUpperCase()} ${p}`, op });
        }
    }
    return out;
}

export function render(spec) {
    const ops = operationsOf(spec);
    const lines = [
        `// GENERATED from ${SPEC_REL} by scripts/gen-api-types.mjs, do not edit.`,
        '// After a route or schema change: npm run gen:api-reference, then npm run gen:api-types.',
        '//',
        '// One member per server operation, keyed \'<METHOD> <path template>\'. `params` are the',
        '// path parameters, `query` and `body` the zod schemas of the route\'s validate(); a route',
        '// that declares none reads them by hand, so they stay loose. The spec describes no',
        '// responses: `response` is unknown and the caller states what it reads.',
        '',
        '/** The query of a route that declares no query schema. */',
        'type UndeclaredQuery = Record<string, string | number | boolean | null | undefined>;',
        '/** The path parameters of a route without any. */',
        'export type NoParams = Record<string, never>;',
        '',
        '/** One operation: its path parameters, query and request body; the response is not described. */',
        'interface Op<P = NoParams, Q = UndeclaredQuery, B = unknown> {',
        '    params: P;',
        '    query: Q;',
        '    body: B;',
        '    response: unknown;',
        '}',
        '',
        `/** ${ops.length} operations. */`,
        'export interface ApiOperations {',
    ];
    for (const { key, op } of ops) lines.push(`    ${literal(key)}: ${operationType(op, '    ')};`);
    lines.push('}', '', 'export type ApiOperationKey = keyof ApiOperations;', '');
    return lines.join('\n');
}

export function run({ root = ROOT, check = false, log = console.log, error = console.error } = {}) {
    const spec = JSON.parse(fs.readFileSync(path.join(root, SPEC_REL), 'utf8'));
    const next = render(spec);
    const out = path.join(root, OUT_REL);
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (check) {
        if (current === next) {
            log(`api types: ${OUT_REL} matches ${SPEC_REL}`);
            return 0;
        }
        error(`api types: ${OUT_REL} is out of date with ${SPEC_REL}. Run \`npm run gen:api-types\` and commit it (do not edit it by hand).`);
        return 1;
    }
    if (current !== next) fs.writeFileSync(out, next);
    log(`api types: ${OUT_REL} ${current === next ? 'unchanged' : 'written'} (${operationsOf(spec).length} operations)`);
    return 0;
}

if (isEntryPoint(import.meta.url)) process.exit(run({ check: process.argv.includes('--check') }));
