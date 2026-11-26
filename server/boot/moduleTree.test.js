'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { assertSoundModuleTree, MAX_NAMED } = require('./moduleTree');

/** Run the check against a given list of clashes and record what it did. */
function run(clashes) {
    const lines = [];
    const exits = [];
    const sound = assertSoundModuleTree({
        duplicates: () => clashes,
        log: { error: (msg) => lines.push(msg) },
        exit: (code) => exits.push(code),
    });
    return { sound, lines, exits };
}

test('a sound tree logs nothing and does not stop the process', () => {
    assert.deepStrictEqual(run([]), { sound: true, lines: [], exits: [] });
});

test('a duplicate tree path stops the process with one error line that names it', () => {
    const r = run([{ treePath: 'lib/a.js', roots: ['m1', null] }, { treePath: 'lib/a.js', roots: ['m2', null] }]);
    assert.strictEqual(r.sound, false);
    assert.deepStrictEqual(r.exits, [1]);
    assert.strictEqual(r.lines.length, 1);
    assert.ok(r.lines[0].includes('1 tree path(s)'), r.lines[0]);
    assert.ok(r.lines[0].includes('lib/a.js'), r.lines[0]);
    assert.ok(!r.lines[0].includes('\n'), 'one line');
});

test('the line names at most ten tree paths and counts the rest', () => {
    const clashes = Array.from({ length: MAX_NAMED + 3 }, (_, i) => ({ treePath: `f${i}.js`, roots: ['m1', null] }));
    const [line] = run(clashes).lines;
    assert.ok(line.includes('f9.js') && !line.includes('f10.js'), line);
    assert.ok(line.includes('and 3 more'), line);
});

test('the default check is the resolver\'s, and the real tree of this checkout is sound', () => {
    assert.strictEqual(assertSoundModuleTree({ exit: () => assert.fail('the checkout has duplicate tree paths') }), true);
});
