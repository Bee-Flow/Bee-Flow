'use strict';

/**
 * Compat corpus: every action's steps keep their ordinals and kinds (the browser posts only a
 * step ordinal; the server resolves it from its own copy), stored and canonical, and an app
 * with a public page sends an anonymous visitor exactly the definition it sent before.
 *
 * Green means: an open browser tab, a phone, and a public page that loaded an app before a
 * change still name the same step after it, and the public page shows (and hides) the same.
 *
 * Run: cd server && node --test appStudio/compat/stepsAndPublic.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { corpusNames, readCorpus, readFrozen } = require('./corpus.mts');
const { ordinalSection, publicSection } = require('./expectations.mts');

for (const name of corpusNames()) {
    const entry = readCorpus(name);
    const frozen = readFrozen(name);

    test(`${name}: step ordinals per action`, () => {
        const actual = ordinalSection(entry);
        for (const id of Object.keys(frozen.ordinals.stored)) {
            assert.deepStrictEqual(actual.stored[id], frozen.ordinals.stored[id], `${name}: action ${id} numbers its steps differently`);
        }
        assert.deepStrictEqual(actual, frozen.ordinals);
    });

    if (frozen.publicDefinition) {
        test(`${name}: public definition`, () => {
            assert.deepStrictEqual(publicSection(entry), frozen.publicDefinition, `${name}: an anonymous visitor would receive a different definition`);
        });
    }
}
