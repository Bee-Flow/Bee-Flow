/**
 * The AI builder writes `pagination` (since 3) through the ordinary component
 * tools: the spec decides what is accepted, canonicalize writes it only when
 * set, and the definition is then stored as schema 3. A value the type does
 * not offer is a validation error, as for any enum prop.
 *
 * Run: cd server && node --test appStudio/builderTools.pagination.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { applyToolCall } = require('./builderTools');
const { emptyDefinition } = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const ops = require('./definitionOps');

const freshWrap = () => ({ userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_page', def: emptyDefinition('Paged') });
const SOURCE = { kind: 'records', tableId: 'tbl_tick01', limit: 20 };

test('app_add_components / app_update_component carry pagination; leaving it out writes nothing', async () => {
    const wrap = freshWrap();
    const parentId = wrap.def.screens[0].sections[0].id;
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { tempId: 'tbl', type: 'table', props: { source: SOURCE, pagination: 'prevNext', columns: [{ key: 'title' }] } },
            { tempId: 'lst', type: 'list', props: { source: SOURCE } },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const def = canonicalizeAppDefinition(wrap.def).def;
    assert.strictEqual(ops.findNode(def, r.ids.tbl).node.props.pagination, 'prevNext');
    assert.ok(!('pagination' in ops.findNode(def, r.ids.lst).node.props), 'an unset later prop is not written');
    assert.strictEqual(def.schemaVersion, 3);

    const u = await applyToolCall('app_update_component', { id: r.ids.lst, props: { pagination: 'loadMore' } }, wrap);
    assert.ok(!u.error, JSON.stringify(u));
    assert.strictEqual(ops.findNode(wrap.def, r.ids.lst).node.props.pagination, 'loadMore');
});

test('a definition without pagination stays schema 2; a mode the type lacks is refused by the validator', () => {
    const plain = emptyDefinition('Plain');
    plain.screens[0].sections[0].children.push({ id: 'cmp_grid01', type: 'data_grid', props: { source: SOURCE }, style: { span: 12 } });
    assert.strictEqual(canonicalizeAppDefinition(plain).def.schemaVersion, 2);
    const bad = JSON.parse(JSON.stringify(plain));
    bad.screens[0].sections[0].children[0].props.pagination = 'prevNext';
    const v = validateAppDefinition(canonicalizeAppDefinition(bad).def, {});
    assert.ok(v.errors.some((e) => e.code === 'prop.enum' && e.path.endsWith('.props.pagination')), JSON.stringify(v.errors));
});
