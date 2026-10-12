/**
 * A datatable `cursor` stored as a bare "{{…}}" string (the shape the AI
 * builder used to store) is checked like the binding object it stands for:
 * its placeholder must name a step that exists and has already run, and an
 * id rename (import, Blueprint install) must reach it.
 *
 * Run: cd server && node --test automation/validate/stepRules/referenceScoping.cursor.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('../../validate');
const { rekeyDefinition } = require('../../portability');

function def(cursor) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'page1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', limit: 50 },
            { id: 'page2', type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', limit: 50, cursor },
        ],
        edges: [{ from: 'trg', to: 'page1' }, { from: 'page1', to: 'page2' }],
    };
}

const refFindings = (d) => {
    const r = validateDefinition(d);
    return [...r.errors, ...r.warnings].filter(e => /^ref\./.test(e.code));
};

test('a bare-string cursor naming an existing earlier step is clean', () => {
    assert.deepStrictEqual(refFindings(def('{{steps.page1.output.nextCursor}}')), []);
    assert.deepStrictEqual(refFindings(def('{{ steps["page1"].output.nextCursor }}')), []);
});

test('a bare-string cursor naming a step that does not exist is reported', () => {
    const found = refFindings(def('{{steps.pagex.output.nextCursor}}'));
    assert.ok(found.some(e => e.code === 'ref.unknown_step'), JSON.stringify(found));
});

test('a rekey renames the step inside a bare-string cursor', () => {
    const { definition, renameMap } = rekeyDefinition(def('{{steps.page1.output.nextCursor}}'));
    const page2 = definition.steps.find(s => s.type === 'datatable' && s.cursor);
    assert.notStrictEqual(renameMap.root.page1, 'page1');
    assert.strictEqual(page2.cursor, `{{steps.${renameMap.root.page1}.output.nextCursor}}`);
});
