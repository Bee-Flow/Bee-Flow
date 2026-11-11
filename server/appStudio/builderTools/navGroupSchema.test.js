/**
 * navGroupSchema.mts: the keys of one nav group in app_set_nav_groups, base keys in the pinned
 * wording, a nav-group key marked since 3 after them. With a mark in KEY_MARKS before the tool
 * schemas load (they are module constants): navGroupSchema.fixture.test.js.
 * Run: node --test appStudio/builderTools/navGroupSchema.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const N = require('./navGroupSchema.mts');
const { KEY_MARKS } = require('../componentSpecs');
const { isExtensionSince } = require('../catalogTiers.mts');
const { TOOL_SCHEMAS } = require('./schemas');

const itemProps = () => TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_nav_groups').function.parameters.properties.groups.items.properties;

test('the nav-group item is the base four in the pinned order, then the marked keys', () => {
    assert.deepEqual(Object.keys(itemProps()), ['id', 'label', 'icon', 'screens', ...N.navGroupExtensionProps().map(([k]) => k)]);
    assert.deepEqual(itemProps().label, { type: 'string', description: 'The heading shown in the nav (max 40 chars).' });
});

test('every shipped nav-group mark reaches the schema: a mark needs a toolSchema', () => {
    for (const [key, mark] of Object.entries(KEY_MARKS.navGroup)) {
        if (!isExtensionSince(/** @type {any} */ (mark).since)) continue;
        assert.ok(itemProps()[key], `keys/navGroup/${key}.js has no toolSchema, so app_set_nav_groups does not offer it`);
    }
});

test('a marked key: its toolSchema (a copy), a gloss and where to read the entry', () => {
    const toolSchema = { type: 'string', enum: ['new', 'beta'] };
    const marks = {
        label: { since: 3, shape: 'x', description: 'Never: a base key.', toolSchema: { type: 'number' } },
        zz_tag: { since: 3, shape: 'new|beta', description: 'A tag shown beside the label. More here.', toolSchema },
        zz_plain: { since: 3, shape: 'formula', description: 'No schema of its own.' },
        zz_values: { valuesSince: { a: 3 }, shape: 'a', description: 'Values only.', toolSchema: { type: 'string' } },
    };
    const out = Object.fromEntries(N.navGroupExtensionProps(marks));
    assert.deepEqual(Object.keys(out), ['zz_tag']);
    assert.deepEqual(out.zz_tag, {
        type: 'string', enum: ['new', 'beta'],
        description: 'A tag shown beside the label. Read its entry before you use it: app_inspect_catalog {extensions:["nav.groups[].zz_tag"]}.',
    });
    assert.notEqual(out.zz_tag.enum, toolSchema.enum, 'a copy');
});

test('strip touches only app_set_nav_groups and only marked keys', () => {
    const copy = JSON.parse(JSON.stringify(TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_nav_groups')));
    copy.function.parameters.properties.groups.items.properties.zz_fake = { type: 'string' };
    N.stripNavGroupExtensions(copy);
    assert.ok(copy.function.parameters.properties.groups.items.properties.zz_fake);
    const other = { function: { name: 'app_set_theme', parameters: { type: 'object', properties: {} } } };
    N.stripNavGroupExtensions(other);
    assert.deepEqual(other.function.parameters.properties, {});
});
