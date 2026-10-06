'use strict';

/**
 * App Studio binding paths (`actionResult.path`, `record.path`) use the ONE
 * path grammar the automation runtime and the app's own resolver use
 * (shared/expr/path.mjs, relative to the result or the row).
 *
 * The validator used to allow only dotted identifier segments. The client
 * resolved `body.value[0].subject` and `body["@odata.nextLink"]` in the live
 * preview, then the save failed with 422 — and Graph-, HTTP- and Jira-shaped
 * results (`@odata.nextLink`, `Content-Type`, `Story Points`) could not be
 * bound at all.
 *
 * Run: node --test appStudio/validate/bindings.paths.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateBinding } = require('./bindings');
const { getRelativePath } = require('../../automation/expr');

function pathFindings(binding) {
    const errors = [];
    const ctx = {
        pushE: (r) => errors.push(r), pushW: () => {},
        actionIds: new Set(['act_1']),
    };
    validateBinding('value', binding, 'screens[0].x.props.value', ctx);
    return errors.filter(e => e.code === 'binding.path_invalid');
}

const RESULT = {
    body: { value: [{ subject: 'Invoice 1' }], '@odata.nextLink': 'next' },
    fields: { 'Story Points': 5 },
    headers: { 'Content-Type': 'json', list: [{ name: 'Subject', value: 'Hi' }] },
};

const RESOLVABLE = [
    'body.value.0.subject',          // the old supported spelling keeps working
    'body.value[0].subject',
    'body["@odata.nextLink"]',
    'fields["Story Points"]',
    'headers.Content-Type',
    'headers.list[name="Subject"].value',
    'body.value[*].subject',
    'body.value[-1].subject',
];

for (const path of RESOLVABLE) {
    test(`a path the app resolves saves: ${path}`, () => {
        assert.deepStrictEqual(pathFindings({ kind: 'actionResult', actionId: 'act_1', path }), []);
        assert.notStrictEqual(getRelativePath(RESULT, path), undefined, 'and it resolves to a value');
    });
}

test('a path nothing can read is refused, with the spelling that would read', () => {
    const [f] = pathFindings({ kind: 'actionResult', actionId: 'act_1', path: 'fields.Story Points' });
    assert.ok(f);
    assert.strictEqual(f.severity, 'error');
    assert.match(f.hint, /fields\["Story Points"\]/);
    for (const bad of ['rows[0', 'a..b', 'rows[abc]']) {
        assert.strictEqual(pathFindings({ kind: 'actionResult', actionId: 'act_1', path: bad }).length, 1, bad);
    }
});

test('a record path follows the same grammar', () => {
    const rec = (path) => {
        const errors = [];
        validateBinding('value', { kind: 'record', tableId: 'tbl_1', path }, 'p', { pushE: (r) => errors.push(r), pushW: () => {}, actionIds: new Set() });
        return errors.filter(e => e.code === 'binding.path_invalid');
    };
    assert.deepStrictEqual(rec('maten["hoogte (cm)"]'), []);
    assert.deepStrictEqual(rec('maten.hoogte'), []);
    assert.strictEqual(rec('maten.hoogte (cm)').length, 1);
});
