/**
 * navGroupSchema.mts with a nav-group key marked since 3 in KEY_MARKS (with a toolSchema), put in
 * BEFORE the tool schemas load (they are module constants). Every test file runs in its own
 * process, so nothing else sees the mark.
 * Run: node --test appStudio/builderTools/navGroupSchema.fixture.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { KEY_MARKS } = require('../componentSpecs');

KEY_MARKS.navGroup.zz_tag = { since: 3, shape: 'new|beta', description: 'A tag shown beside the group label.', toolSchema: { type: 'string', enum: ['new', 'beta'] } };
after(() => { delete KEY_MARKS.navGroup.zz_tag; });

const { TOOL_SCHEMAS } = require('./schemas');
const { stripNavGroupExtensions } = require('./navGroupSchema.mts');
const { baseToolSchemaHashes, pinnedOnly } = require('../../testUtils/appCatalogExtensions.testkit');
const pinned = require('./__tests__/toolSchemaHashes.base.json');

const tool = () => TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_nav_groups');

test('the marked key joins the nav-group item after the base keys', () => {
    const props = tool().function.parameters.properties.groups.items.properties;
    assert.deepEqual(Object.keys(props), ['id', 'label', 'icon', 'screens', 'zz_tag']);
    assert.deepEqual(props.zz_tag.enum, ['new', 'beta']);
    assert.match(props.zz_tag.description, /^A tag shown beside the group label\. Read its entry/);
});

test('a stripped copy is the base again, and the pinned base bytes hold', () => {
    const copy = JSON.parse(JSON.stringify(tool()));
    stripNavGroupExtensions(copy);
    assert.ok(!('zz_tag' in copy.function.parameters.properties.groups.items.properties));
    const now = baseToolSchemaHashes();
    assert.deepEqual(pinnedOnly(now.full, pinned.full), pinned.full);
});
