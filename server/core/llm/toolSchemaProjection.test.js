/**
 * Tool schemas as the Gemma 4 template can render them.
 *
 * Measured on llama-server /props (2026-09-17): only description | type |
 * enum | items | properties | required | nullable are rendered, and a
 * `type: [T,'null']` list comes out as the literal `['STRING', 'NULL']`. The
 * projection fixes the union and drops the invisible keywords — at schema
 * NODES only, never as property NAMES — and touches nothing else.
 *
 * Run: cd server && node --test --test-force-exit core/llm/toolSchemaProjection.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    UNRENDERABLE_KEYS,
    projectSchemaNode,
    stripUnrenderableKeys,
    projectToolsForTemplate,
} = require('./toolSchemaProjection');

const tool = (name, parameters) => ({ type: 'function', function: { name, description: `${name} desc`, parameters } });

// Every keyword the plan approved for stripping, each at a node where an
// author would plausibly write it.
const NOISY = {
    type: 'object',
    title: 'Noisy',
    $comment: 'internal',
    properties: {
        label: { type: 'string', default: 'x', examples: ['a'], pattern: '^[a-z]+$', minLength: 1 },
        when: { type: 'string', format: 'date-time' },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', maxLength: 20 }, minItems: 1, maxItems: 3 },
    },
    required: ['label'],
    additionalProperties: false,
};

test('the invisible keywords are dropped at schema nodes, and the rendered ones stay', () => {
    const out = projectSchemaNode(NOISY);
    assert.deepEqual(out, {
        type: 'object',
        properties: {
            label: { type: 'string', minLength: 1 },
            when: { type: 'string' },
            count: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string', maxLength: 20 } },
        },
        required: ['label'],
        additionalProperties: false,
    });
    // additionalProperties stays on purpose (it measurably helped on
    // builder_add_steps.steps.items); minLength/maxLength are not on the
    // approved list and stay too.
    assert.equal(out.additionalProperties, false);
    for (const k of UNRENDERABLE_KEYS) assert.equal(k in out, false, k);
});

test('a property NAME that spells a keyword survives — only nodes are filtered', () => {
    const schema = {
        type: 'object',
        properties: {
            format: { type: 'string', enum: ['pdf', 'docx'], default: 'pdf' },
            maxItems: { type: 'integer', minimum: 1 },
            title: { type: 'string', title: 'Title' },
            default: { type: 'boolean' },
            pattern: { type: 'object', properties: { minimum: { type: 'number' } } },
        },
        required: ['format', 'maxItems'],
    };
    const out = projectSchemaNode(schema);
    assert.deepEqual(Object.keys(out.properties), ['format', 'maxItems', 'title', 'default', 'pattern']);
    assert.deepEqual(out.properties.format, { type: 'string', enum: ['pdf', 'docx'] });
    assert.deepEqual(out.properties.maxItems, { type: 'integer' });
    assert.deepEqual(out.properties.title, { type: 'string' });
    assert.deepEqual(out.properties.pattern, { type: 'object', properties: { minimum: { type: 'number' } } });
    assert.deepEqual(out.required, ['format', 'maxItems']);
});

test('type: [T, null] becomes type: T + nullable and nothing more — the two keys the template renders', () => {
    const out = projectSchemaNode({
        type: 'object',
        properties: {
            actionId: { type: ['string', 'null'], description: 'an action id' },
            options: { type: ['array', 'null'], items: { type: 'string', enum: ['a', 'b'] } },
            access: { type: ['object', 'null'], properties: { mode: { type: 'string', default: 'public' } }, required: ['mode'] },
        },
    });
    assert.deepEqual(out.properties.actionId, { type: 'string', description: 'an action id', nullable: true });
    assert.deepEqual(out.properties.options, { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, nullable: true });
    // Nested nodes inside the lifted union were projected too (default dropped).
    assert.deepEqual(out.properties.access, { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], nullable: true });
    // No type list is left anywhere, and no anyOf was invented anywhere.
    assert.equal(JSON.stringify(out).includes('"type":['), false);
    assert.equal(JSON.stringify(out).includes('anyOf'), false);
});

test('a lifted union under `items` or on a properties-less object carries no anyOf — the template renders it verbatim there', () => {
    // Verified on the live router's /apply-template, 2026-09-18: at a
    // property node the template filters unknown keys, but under array
    // `items` every key renders as `key:value` (an anyOf became fenced
    // pseudo-JSON the model has never seen in a declaration), and an object
    // without `properties` renders its own keys as fields (the anyOf became
    // a phantom property named `anyOf` with an empty type). The first cut of
    // this projection kept an anyOf "for the grammar"; llama.cpp's Gemma 4
    // grammar never reads the argument schema, so it only leaked.
    const out = projectSchemaNode({
        type: 'object',
        properties: {
            tags: { type: 'array', items: { type: ['string', 'null'], description: 'tag' } },
            blob: { type: ['object', 'null'], description: 'opaque' },
            matrix: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } } },
        },
    });
    assert.deepEqual(out.properties.tags.items, { type: 'string', description: 'tag', nullable: true });
    assert.deepEqual(out.properties.blob, { type: 'object', description: 'opaque', nullable: true });
    assert.deepEqual(out.properties.matrix.items.items, { type: 'number', nullable: true });
    assert.deepEqual(Object.keys(out.properties.tags.items).sort(), ['description', 'nullable', 'type']);
    assert.deepEqual(Object.keys(out.properties.blob).sort(), ['description', 'nullable', 'type']);
    // An anyOf the AUTHOR wrote is theirs and stays, lifted node or not.
    const authored = projectSchemaNode({ type: ['string', 'null'], anyOf: [{ enum: ['a'] }, { enum: ['b'] }] });
    assert.deepEqual(authored, { type: 'string', anyOf: [{ enum: ['a'] }, { enum: ['b'] }], nullable: true });
});

test('other type lists, and nodes under anyOf/oneOf/$defs, are handled without inventing anything', () => {
    const out = projectSchemaNode({
        type: 'object',
        properties: {
            two: { type: ['string', 'number'], default: 1 },        // two concrete types: untouched
            three: { type: ['string', 'number', 'null'] },          // three entries: untouched
            either: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'object', properties: { url: { type: 'string', pattern: '^http' } } }] },
            one: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        },
        $defs: { thing: { type: 'object', title: 'Thing', properties: { n: { type: 'number', maximum: 9 } } } },
    });
    assert.deepEqual(out.properties.two, { type: ['string', 'number'] });
    assert.deepEqual(out.properties.three, { type: ['string', 'number', 'null'] });
    assert.deepEqual(out.properties.either.anyOf, [{ type: 'string' }, { type: 'object', properties: { url: { type: 'string' } } }]);
    assert.deepEqual(out.properties.one.oneOf, [{ type: 'integer' }, { type: 'null' }]);
    assert.deepEqual(out.$defs.thing, { type: 'object', properties: { n: { type: 'number' } } });
    // additionalProperties as a schema is projected, as a boolean is kept.
    assert.deepEqual(
        projectSchemaNode({ type: 'object', additionalProperties: { type: 'string', format: 'email' } }),
        { type: 'object', additionalProperties: { type: 'string' } },
    );
});

test('stripUnrenderableKeys never mutates its input and returns new tool objects', () => {
    const tools = [tool('noisy', NOISY), tool('bare', undefined), { type: 'function', function: { name: 'nop' } }];
    const before = JSON.stringify(tools);
    const out = stripUnrenderableKeys(tools);
    assert.equal(JSON.stringify(tools), before, 'input untouched');
    assert.notEqual(out[0], tools[0]);
    assert.notEqual(out[0].function.parameters, tools[0].function.parameters);
    assert.equal(out[0].function.name, 'noisy');
    assert.equal(out[0].function.description, 'noisy desc');
    assert.equal(out[0].function.parameters.title, undefined);
    // Tools without a parameters object pass through by reference.
    assert.equal(out[1], tools[1]);
    assert.equal(out[2], tools[2]);
    assert.equal(stripUnrenderableKeys(undefined), undefined);
});

test('projectToolsForTemplate projects only the families whose template needs it', () => {
    const tools = [tool('noisy', NOISY)];
    assert.equal(projectToolsForTemplate(tools, { family: 'Qwen3' }), tools, 'same reference');
    assert.equal(projectToolsForTemplate(tools, { family: null }), tools);
    assert.equal(projectToolsForTemplate(tools, {}), tools);
    const gemma = projectToolsForTemplate(tools, { family: 'Gemma 4' });
    assert.notEqual(gemma, tools);
    assert.equal(gemma[0].function.parameters.title, undefined);
});

// ─── the real builder schemas ────────────────────────────────────────────────
// Both builders' TOOL_SCHEMAS carry property names that spell keywords
// (`title`, `format`, `default`, `maxItems`, …) and one `[object, null]`
// union. The projection must keep every property and every tool, and the
// originals must be byte-identical afterwards: mcpBuilder and the cloud
// providers ship them untouched.

const REAL = [
    ...require('../../automation/builderTools/schemas').TOOL_SCHEMAS,
    ...require('../../appStudio/builderTools/schemas').TOOL_SCHEMAS,
];

function propertyNames(node, acc = new Set()) {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { node.forEach(n => propertyNames(n, acc)); return acc; }
    for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' && v && typeof v === 'object') {
            for (const name of Object.keys(v)) { acc.add(name); propertyNames(v[name], acc); }
        } else {
            propertyNames(v, acc);
        }
    }
    return acc;
}

function forEachSchemaNode(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => forEachSchemaNode(n, fn)); return; }
    fn(node);
    for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' && v && typeof v === 'object') Object.values(v).forEach(p => forEachSchemaNode(p, fn));
        else forEachSchemaNode(v, fn);
    }
}

test('the real builder schemas: every tool and every property name survives, the originals are untouched', () => {
    const before = JSON.stringify(REAL);
    const out = stripUnrenderableKeys(REAL);
    assert.equal(JSON.stringify(REAL), before);
    assert.deepEqual(out.map(t => t.function.name), REAL.map(t => t.function.name));
    for (let i = 0; i < REAL.length; i++) {
        const want = propertyNames(REAL[i].function.parameters);
        const got = propertyNames(out[i].function.parameters);
        assert.deepEqual([...got].sort(), [...want].sort(), REAL[i].function.name);
    }
    // The names that spell keywords are the interesting ones — prove they are there.
    const names = propertyNames(out.map(t => t.function.parameters));
    for (const n of ['title', 'description', 'type', 'required', 'format', 'default']) assert.ok(names.has(n), n);
});

test('the real builder schemas: no type list and no stripped keyword remains at any node', () => {
    const out = stripUnrenderableKeys(REAL);
    forEachSchemaNode(out.map(t => t.function.parameters), (node) => {
        assert.equal(Array.isArray(node.type), false, JSON.stringify(node).slice(0, 120));
        for (const k of UNRENDERABLE_KEYS) assert.equal(k in node, false, `${k} at ${JSON.stringify(node).slice(0, 120)}`);
    });
});

// The one null union the real schemas carried when this was measured
// (app_set_public_access.publicAccess, 2026-09-17): an OBJECT union with a
// description, a property NAMED `title` inside it (a keyword as a name, under
// a lifted node) and a nested object with an enum. Pinned as a synthetic tool
// so the shape stays covered when the schema workstream renames the tool or
// rewrites the union as `type:'object', nullable:true` — the cheaper form the
// projection module recommends.
const MEASURED_OBJECT_UNION = {
    type: 'object',
    properties: {
        appId: { type: 'string' },
        publicAccess: {
            type: ['object', 'null'],
            description: 'The public surface, or null to close it.',
            properties: {
                entryScreenId: { type: 'string', description: 'The screen a visitor lands on.' },
                screenIds: { type: 'array', items: { type: 'string' } },
                title: { type: 'string', description: 'Browser title for the public page.', default: 'App' },
                theme: {
                    type: 'object',
                    properties: { radius: { type: 'string', enum: ['none', 'sm', 'md'] } },
                },
            },
            required: ['entryScreenId'],
        },
    },
    required: ['appId', 'publicAccess'],
};

test('an object union with a description, a `title` property and a nested enum lifts to type+nullable, its properties intact', () => {
    const out = projectSchemaNode(MEASURED_OBJECT_UNION);
    const node = out.properties.publicAccess;
    assert.equal(node.type, 'object');
    assert.equal(node.nullable, true);
    assert.equal(node.description, 'The public surface, or null to close it.');
    assert.deepEqual(node.required, ['entryScreenId']);
    // The property NAMED title survives; the keyword `default` inside it is gone.
    assert.deepEqual(Object.keys(node.properties), ['entryScreenId', 'screenIds', 'title', 'theme']);
    assert.deepEqual(node.properties.title, { type: 'string', description: 'Browser title for the public page.' });
    assert.deepEqual(node.properties.theme.properties.radius, { type: 'string', enum: ['none', 'sm', 'md'] });
    assert.deepEqual(Object.keys(node).sort(), ['description', 'nullable', 'properties', 'required', 'type'], 'no anyOf, nothing else invented');
    assert.equal(JSON.stringify(out).includes('"type":['), false);
    // The outer object is untouched apart from its lifted child.
    assert.deepEqual(out.properties.appId, { type: 'string' });
    assert.deepEqual(out.required, ['appId', 'publicAccess']);
});

/** Dotted paths of every `[T, 'null']` node under `node`, walking properties, items, anyOf/oneOf and $defs. */
function nullUnionPaths(node, path = '', acc = []) {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { node.forEach((n, i) => nullUnionPaths(n, `${path}[${i}]`, acc)); return acc; }
    if (Array.isArray(node.type) && node.type.length === 2 && node.type.includes('null')) acc.push(path);
    for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' && v && typeof v === 'object') {
            for (const name of Object.keys(v)) nullUnionPaths(v[name], `${path}.properties.${name}`, acc);
        } else if (v && typeof v === 'object') {
            nullUnionPaths(v, `${path}.${k}`, acc);
        }
    }
    return acc;
}

function atPath(root, path) {
    return path.split(/\.|\[|\]/).filter(Boolean).reduce((n, key) => (n == null ? n : n[key]), root);
}

test('every null union the real builder schemas carry today is lifted — by shape, whatever the tool is called', () => {
    // Found from the ORIGINALS, so a renamed tool or a moved union is still
    // exercised; an empty list is legitimate (the schema workstream may write
    // `nullable: true` directly) and is reported, never silently passed over.
    const out = stripUnrenderableKeys(REAL);
    const found = [];
    for (let i = 0; i < REAL.length; i++) {
        for (const path of nullUnionPaths(REAL[i].function.parameters)) {
            found.push(`${REAL[i].function.name}${path}`);
            const original = atPath(REAL[i].function.parameters, path);
            const node = atPath(out[i].function.parameters, path);
            const concrete = original.type.find(t => t !== 'null');
            assert.equal(node.type, concrete, `${REAL[i].function.name}${path}: type lifted`);
            assert.equal(node.nullable, true, `${REAL[i].function.name}${path}: nullable`);
            assert.equal('anyOf' in node, 'anyOf' in original, `${REAL[i].function.name}${path}: no anyOf invented`);
            if (original.properties) {
                assert.deepEqual(Object.keys(node.properties), Object.keys(original.properties), `${REAL[i].function.name}${path}: property names`);
            }
        }
    }
    // Informational: which unions this run actually exercised. When it prints
    // nothing, MEASURED_OBJECT_UNION above is the only object-union coverage.
    console.log(`[toolSchemaProjection.test] real null unions lifted: ${found.length ? found.join(', ') : '(none — schemas write nullable directly)'}`);
});
