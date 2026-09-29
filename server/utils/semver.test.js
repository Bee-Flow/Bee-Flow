/**
 * Unit tests for utils/semver.js — the dependency-free module compat gate.
 *
 * Run: node --test utils/semver.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const semver = require('./semver');

test('parse: clean version', () => {
    assert.deepStrictEqual(semver.parse('1.2.3'), {
        major: 1, minor: 2, patch: 3, prerelease: '',
    });
});

test('parse: strips leading v and build metadata, keeps prerelease', () => {
    assert.deepStrictEqual(semver.parse('v2.0.0-rc.1+build.99'), {
        major: 2, minor: 0, patch: 0, prerelease: 'rc.1',
    });
});

test('parse: junk coerces to 0 and never throws', () => {
    assert.deepStrictEqual(semver.parse('garbage'), {
        major: 0, minor: 0, patch: 0, prerelease: '',
    });
    assert.deepStrictEqual(semver.parse(''), {
        major: 0, minor: 0, patch: 0, prerelease: '',
    });
    assert.deepStrictEqual(semver.parse(null), {
        major: 0, minor: 0, patch: 0, prerelease: '',
    });
    assert.deepStrictEqual(semver.parse(undefined), {
        major: 0, minor: 0, patch: 0, prerelease: '',
    });
    // Partial / mixed junk: missing segments default to 0.
    assert.deepStrictEqual(semver.parse('1.x'), {
        major: 1, minor: 0, patch: 0, prerelease: '',
    });
    assert.deepStrictEqual(semver.parse('1'), {
        major: 1, minor: 0, patch: 0, prerelease: '',
    });
});

test('compare: numeric major.minor.patch ordering', () => {
    assert.strictEqual(semver.compare('1.0.0', '2.0.0'), -1);
    assert.strictEqual(semver.compare('2.0.0', '1.0.0'), 1);
    assert.strictEqual(semver.compare('1.2.0', '1.10.0'), -1); // numeric, not lexical
    assert.strictEqual(semver.compare('1.2.3', '1.2.3'), 0);
    assert.strictEqual(semver.compare('1.2.10', '1.2.9'), 1);
});

test('compare: prerelease is lower precedence than release', () => {
    assert.strictEqual(semver.compare('1.0.0-alpha', '1.0.0'), -1);
    assert.strictEqual(semver.compare('1.0.0', '1.0.0-alpha'), 1);
    assert.strictEqual(semver.compare('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.strictEqual(semver.compare('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
    assert.strictEqual(semver.compare('1.0.0-alpha', '1.0.0-alpha.1'), -1); // shorter run sorts lower
    assert.strictEqual(semver.compare('1.0.0-1', '1.0.0-alpha'), -1);       // numeric < alnum
    assert.strictEqual(semver.compare('1.0.0-rc.1', '1.0.0-rc.1'), 0);
});

test('gt/lt/gte/lte/eq', () => {
    assert.strictEqual(semver.gt('2.0.0', '1.9.9'), true);
    assert.strictEqual(semver.gt('1.0.0', '1.0.0'), false);
    assert.strictEqual(semver.lt('1.0.0', '1.0.1'), true);
    assert.strictEqual(semver.gte('1.0.0', '1.0.0'), true);
    assert.strictEqual(semver.gte('1.0.1', '1.0.0'), true);
    assert.strictEqual(semver.lte('1.0.0', '1.0.0'), true);
    assert.strictEqual(semver.lte('1.0.0', '0.9.0'), false);
    assert.strictEqual(semver.eq('1.2.3', 'v1.2.3+meta'), true);
    assert.strictEqual(semver.eq('1.2.3', '1.2.3-rc'), false);
});

test('satisfiesMin: null/undefined/empty min always passes', () => {
    assert.strictEqual(semver.satisfiesMin('1.0.0', null), true);
    assert.strictEqual(semver.satisfiesMin('1.0.0', undefined), true);
    assert.strictEqual(semver.satisfiesMin('1.0.0', ''), true);
    assert.strictEqual(semver.satisfiesMin('1.5.0', '1.4.0'), true);
    assert.strictEqual(semver.satisfiesMin('1.4.0', '1.4.0'), true); // inclusive
    assert.strictEqual(semver.satisfiesMin('1.3.0', '1.4.0'), false);
    // Prerelease is below its release, so it fails a min equal to the release.
    assert.strictEqual(semver.satisfiesMin('1.4.0-rc.1', '1.4.0'), false);
});

test('satisfiesMax: null/empty max always passes', () => {
    assert.strictEqual(semver.satisfiesMax('9.9.9', null), true);
    assert.strictEqual(semver.satisfiesMax('9.9.9', undefined), true);
    assert.strictEqual(semver.satisfiesMax('9.9.9', ''), true);
    assert.strictEqual(semver.satisfiesMax('1.4.0', '2.0.0'), true);
    assert.strictEqual(semver.satisfiesMax('2.0.0', '2.0.0'), true); // inclusive
    assert.strictEqual(semver.satisfiesMax('2.0.1', '2.0.0'), false);
});

test('satisfiesMin/Max never throw on junk versions', () => {
    assert.doesNotThrow(() => semver.satisfiesMin('junk', 'also-junk'));
    assert.doesNotThrow(() => semver.satisfiesMax(null, undefined));
});
