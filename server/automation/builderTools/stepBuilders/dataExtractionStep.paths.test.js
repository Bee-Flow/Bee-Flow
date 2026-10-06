/**
 * The data_extraction builder reads its source path with the runner's
 * grammar.
 *
 * `fileLocationField` took the last segment with `split('.')`, so a source
 * whose last key is bracketed (`files[0]["path"]`, `loop.f["fileId"]`) was not
 * recognised as a file LOCATION and the extraction was built to read the words
 * of a path. The loop variable named in that refusal was cut out of the path
 * with a dotted-identifier regex as well.
 *
 * Run: cd server && node --test automation/builderTools/stepBuilders/dataExtractionStep.paths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { fileLocationField } = require('./inputBindings');
const { sanitizeDataExtractionSource } = require('./dataExtractionStep');

test('fileLocationField reads the last key with the shared grammar', () => {
    assert.strictEqual(fileLocationField({ kind: 'ref', path: 'steps.ls.output.files[0].path' }), 'steps.ls.output.files[0].path');
    assert.strictEqual(fileLocationField({ kind: 'ref', path: 'steps.ls.output.files[0]["path"]' }), 'steps.ls.output.files[0]["path"]');
    assert.strictEqual(fileLocationField({ kind: 'ref', path: "loop.f['fileId']" }), "loop.f['fileId']");
    // A key that merely ends in a location word is text, not a location.
    assert.strictEqual(fileLocationField({ kind: 'ref', path: 'steps.ls.output["file.path"].text' }), null);
    assert.strictEqual(fileLocationField({ kind: 'ref', path: 'steps.read.output.content' }), null);
    assert.strictEqual(fileLocationField({ kind: 'template', value: '{{steps.ls.output.path}}' }), null);
});

function draft() {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'ls', type: 'integration_action', tool: 'nextcloud_list_files', inputs: {} }],
        edges: [{ from: 'trg', to: 'ls' }],
    };
}

test('a bracketed bare source path is read as a reference, and a location is refused', () => {
    const res = sanitizeDataExtractionSource('steps["ls"].output.files[0]["path"]', draft(), {});
    assert.ok(res.error, JSON.stringify(res));
    assert.match(res.error, /LOCATION, not its text/);
});

test('the refusal names the loop variable of a bracketed loop read', () => {
    const res = sanitizeDataExtractionSource({ kind: 'ref', path: 'loop.file["path"]' }, draft(), {});
    assert.ok(res.error, JSON.stringify(res));
    assert.match(res.error, /loop\.file\.output\.content/);
});
