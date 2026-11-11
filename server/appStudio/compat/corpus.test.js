'use strict';

/**
 * The compatibility corpus itself: every input has its frozen expectations, every frozen file
 * belongs to an input, the files have the shape the other compat tests read, and every built-in
 * template is in the corpus.
 *
 * Run: cd server && node --test appStudio/compat/corpus.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
    corpusNames, frozenNames, readCorpus, readFrozen, frozenPath, formatJson, isCorpusName, isObject,
} = require('./corpus.mts');
const { TEMPLATES } = require('../templates');

const FREEZE = 'node appStudio/compat/freeze.mts';

test('every corpus input has a frozen file and every frozen file has an input', () => {
    const inputs = corpusNames();
    const frozen = frozenNames();
    assert.deepEqual(inputs.filter((n) => !frozen.includes(n)), [], `corpus inputs without expectations: run ${FREEZE}`);
    assert.deepEqual(frozen.filter((n) => !inputs.includes(n)), [], 'frozen files without a corpus input');
    assert.ok(inputs.length >= 30, `the corpus shrank to ${inputs.length} files`);
});

test('corpus names are lower-case words joined by dashes', () => {
    for (const name of corpusNames()) assert.ok(isCorpusName(name), name);
});

test('every built-in template has its install in the corpus', () => {
    const names = corpusNames();
    for (const t of TEMPLATES) {
        const name = `template-${t.id.startsWith('app-') ? t.id.slice('app-'.length) : t.id}`;
        assert.ok(names.includes(name), `${t.id}: add corpus/${name}.json (README.md says how)`);
        assert.equal(readCorpus(name).about.templateId, t.id);
    }
});

/** Which sections a frozen file must carry, from what the input is. */
function expectedSections(entry) {
    const keys = ['corpus', 'canonical', 'schemaVersion', 'validation', 'ordinals'];
    if (typeof entry.about.templateId === 'string') keys.push('installHash');
    if (isObject(entry.definition) && isObject(entry.definition.publicAccess)) keys.push('publicDefinition');
    if (entry.dataModel) keys.push('reads');
    return keys.sort();
}

for (const name of corpusNames()) {
    test(`${name}: input and frozen file have the expected shape`, () => {
        const entry = readCorpus(name);
        assert.equal(typeof entry.about.source, 'string', 'about.source says where the input came from');
        assert.equal(typeof entry.about.captured, 'string', 'about.captured says when');
        assert.ok(isObject(entry.definition), 'definition is an object');
        const frozen = readFrozen(name);
        assert.ok(frozen, `no frozen file: run ${FREEZE}`);
        assert.equal(frozen.corpus, name);
        assert.deepEqual(Object.keys(frozen).sort(), expectedSections(entry));
        assert.equal(fs.readFileSync(frozenPath(name), 'utf8'), formatJson(frozen), 'frozen files are written by freeze.mts, not by hand');
    });
}
