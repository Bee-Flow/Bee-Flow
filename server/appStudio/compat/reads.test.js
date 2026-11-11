'use strict';

/**
 * Compat corpus: every data read a stored app makes (its on-screen bindings and its saved
 * datasets) compiles to the same SQL and params, per role and in both dialects. readSql.mts
 * says how the descriptor is built and what is recorded when a read is not SQL.
 *
 * Green means: no stored app reads different rows after a change, and no role's access
 * filter moved.
 *
 * Run: cd server && node --test appStudio/compat/reads.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { corpusNames, readCorpus, readFrozen } = require('./corpus.mts');
const { readsSection } = require('./readSql.mts');

for (const name of corpusNames()) {
    const frozen = readFrozen(name);
    if (!frozen.reads) continue;
    test(`${name}: compiled reads`, () => {
        const actual = readsSection(readCorpus(name));
        assert.deepStrictEqual(actual.map((r) => r.at), frozen.reads.map((r) => r.at), `${name}: the list of reads changed`);
        actual.forEach((read, i) => {
            assert.deepStrictEqual(read, frozen.reads[i], `${name}: read ${read.at} compiles differently`);
        });
    });
}
