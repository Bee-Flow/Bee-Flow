'use strict';

/**
 * Compat corpus: canonicalize still produces the frozen bytes for every stored app, a second
 * pass changes nothing, the schema version is what it was, and a template install keeps the
 * hash that makes it eligible for a template upgrade.
 *
 * Green means: an app saved today without a change stores the same bytes it stored on the day
 * its corpus file was captured. A failure names the top-level keys, screens and actions whose
 * bytes moved; for an input that was already canonical it also shows the full diff.
 *
 * Run: cd server && node --test appStudio/compat/canonical.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { corpusNames, readCorpus, readFrozen } = require('./corpus.mts');
const { canonicalSection, canonicalOf, schemaSection, installSection } = require('./expectations.mts');

const HINT = 'a stored app would be rewritten on its next save. If that is deliberate, it is a decision for the owner, not a refreeze (README.md)';

function movedParts(expected, actual) {
    const keys = [...new Set([...Object.keys(expected.parts), ...Object.keys(actual.parts)])];
    return keys.filter((k) => expected.parts[k] !== actual.parts[k]);
}

for (const name of corpusNames()) {
    const entry = readCorpus(name);
    const frozen = readFrozen(name);

    test(`${name}: canonical bytes and idempotence`, () => {
        const actual = canonicalSection(entry);
        const expected = frozen.canonical;
        if (expected.inputIsCanonical && !actual.inputIsCanonical) {
            assert.deepStrictEqual(canonicalOf(entry.definition), entry.definition, `${name}: the stored input is no longer canonical; ${HINT}`);
        }
        assert.deepStrictEqual(actual, expected, `${name}: canonical form moved in ${movedParts(expected, actual).join(', ') || 'key order or length'}; ${HINT}`);
    });

    test(`${name}: schema version`, () => {
        assert.deepStrictEqual(schemaSection(entry), frozen.schemaVersion);
    });

    if (frozen.installHash) {
        test(`${name}: template install hash`, () => {
            const actual = installSection(entry);
            assert.deepStrictEqual(actual, frozen.installHash, `${name}: the install hash moved, so an installed app stops being upgradable`);
            assert.equal(actual.afterResave, actual.stored, `${name}: a save without a change would end template upgrades for this app`);
        });
    }
}
