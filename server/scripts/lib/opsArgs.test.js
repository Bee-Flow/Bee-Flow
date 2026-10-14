'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseOpsArgs } = require('./opsArgs');

test('no flags is a dry run', () => {
    assert.strictEqual(parseOpsArgs({}, { argv: [] }).apply, false);
});

test('--apply is the only way to mutate', () => {
    assert.strictEqual(parseOpsArgs({}, { argv: ['--apply'] }).apply, true);
});

test('a typo or an unknown flag throws instead of running as a dry run', () => {
    assert.throws(() => parseOpsArgs({}, { argv: ['--aply'] }), /Unknown option '--aply'/);
    assert.throws(() => parseOpsArgs({}, { argv: ['--apply=yes'] }));
});

test('string options keep their value; a missing or ambiguous value throws', () => {
    const opts = { orgs: { type: 'string' }, yes: { type: 'boolean' } };
    assert.strictEqual(parseOpsArgs(opts, { argv: ['--orgs', 'a,b', '--yes'] }).orgs, 'a,b');
    assert.throws(() => parseOpsArgs(opts, { argv: ['--orgs'] }), /argument missing/);
    // The old indexOf lookup read `--apply` as the org list here.
    assert.throws(() => parseOpsArgs(opts, { argv: ['--orgs', '--apply'] }), /ambiguous/);
});

test('positionals are refused unless the script asks for them', () => {
    assert.throws(() => parseOpsArgs({}, { argv: ['org-1'] }), /Unexpected argument/);
    assert.deepStrictEqual(parseOpsArgs({}, { argv: ['org-1'], positionals: true })._positionals, ['org-1']);
});
