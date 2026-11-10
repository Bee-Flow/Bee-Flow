'use strict';

/**
 * Compat corpus: the validator says the same about every stored app as it did when the
 * corpus file was captured, both as publish runs it (data references are errors) and as a
 * save runs it (data references are warnings). Findings are compared as "code @ path".
 *
 * Green means: no stored app gains (or loses) an error or a warning. A new error on a corpus
 * app is an app that stops saving or publishing.
 *
 * Run: cd server && node --test appStudio/compat/validation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { corpusNames, readCorpus, readFrozen } = require('./corpus.mts');
const { validationSection } = require('./expectations.mts');

for (const name of corpusNames()) {
    test(`${name}: validator findings`, () => {
        const actual = validationSection(readCorpus(name));
        const expected = readFrozen(name).validation;
        for (const mode of ['strict', 'save']) {
            for (const kind of ['errors', 'warnings']) {
                const gained = actual[mode][kind].filter((f) => !expected[mode][kind].includes(f));
                const lost = expected[mode][kind].filter((f) => !actual[mode][kind].includes(f));
                assert.deepStrictEqual({ gained, lost }, { gained: [], lost: [] }, `${name}: ${mode} ${kind} changed`);
            }
        }
        assert.deepStrictEqual(actual, expected);
    });
}
