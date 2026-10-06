/**
 * A `find_rows` cursor stored as a bare "{{…}}" string — the shape the AI
 * builder used to store — is a template, read like the binding it stands for.
 *
 * readCursor handed the string to resolveValue, which treats a bare string as
 * a literal: the cursor became the text "{{steps.page1.output.nextCursor}}",
 * which decodes to nothing, so page 2 silently served page 1 again. The
 * validator and portability already read such a cursor as a template
 * (refSurfaces.js, stepIdRewrite.js); the runner now does too.
 *
 * Run: cd server && node --test core/automationRunner/execDatatable.cursor.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { _test } = require('./execDatatable');

const { readCursor } = _test;
const RUN = { steps: { page1: { output: { nextCursor: 'eyJrIjpbMSwiYSJdfQ' } } }, secrets: { token: 'nope' } };

test('a bare "{{…}}" cursor is interpolated', () => {
    assert.strictEqual(readCursor('{{steps.page1.output.nextCursor}}', RUN), 'eyJrIjpbMSwiYSJdfQ');
    assert.strictEqual(readCursor('{{ steps["page1"].output.nextCursor }}', RUN), 'eyJrIjpbMSwiYSJdfQ');
});

test('a placeholder that resolves to nothing is page 1, and secrets never fill a cursor', () => {
    assert.strictEqual(readCursor('{{steps.missing.output.nextCursor}}', RUN), null);
    assert.strictEqual(readCursor('{{secrets.token}}', RUN), null);
});

test('binding objects and a plain cursor string keep working', () => {
    assert.strictEqual(readCursor({ kind: 'ref', path: 'steps.page1.output.nextCursor' }, RUN), 'eyJrIjpbMSwiYSJdfQ');
    assert.strictEqual(readCursor({ kind: 'template', value: '{{steps.page1.output.nextCursor}}' }, RUN), 'eyJrIjpbMSwiYSJdfQ');
    assert.strictEqual(readCursor('eyJrIjpbMiwiYiJdfQ', RUN), 'eyJrIjpbMiwiYiJdfQ');
    assert.strictEqual(readCursor('', RUN), null);
    assert.strictEqual(readCursor(undefined, RUN), null);
});
