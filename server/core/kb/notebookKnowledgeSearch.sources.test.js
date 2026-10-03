/**
 * Mapping a retrieved chunk to its notebook source: the source id (stored as the
 * chunk's source_uri) is exact and wins; the fuzzy name match is only a fallback.
 *
 * Run: node --test core/kb/notebookKnowledgeSearch.sources.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { findSourceForChunk } = require('./notebookKnowledgeSearch');

const SOURCES = [
    { id: 'id-report', name: 'Report' },
    { id: 'id-annual', name: 'Annual Report 2024' },
];

test('an exact source id beats any name that happens to be a substring', () => {
    // The old fuzzy match could attach this chunk to "Report" or "Annual Report 2024"
    // depending on list order; the id settles it.
    assert.strictEqual(findSourceForChunk({ source_uri: 'id-annual', title: 'Annual Report 2024' }, SOURCES).id, 'id-annual');
    assert.strictEqual(findSourceForChunk({ source_uri: 'id-report', title: 'Annual Report 2024' }, SOURCES).id, 'id-report');
});

test('an id wins even when the title points at another source', () => {
    assert.strictEqual(findSourceForChunk({ source_uri: 'id-report', title: 'Annual Report 2024' }, SOURCES).name, 'Report');
});

test('falls back to the name, then to a substring, only when no id matches', () => {
    assert.strictEqual(findSourceForChunk({ source_uri: 'Report' }, SOURCES).id, 'id-report');
    assert.strictEqual(findSourceForChunk({ source_uri: 'unknown', title: 'docs/Annual Report 2024' }, SOURCES).id, 'id-annual');
    assert.strictEqual(findSourceForChunk({ title: 'My Annual Report 2024 (copy)' }, SOURCES).id, 'id-annual');
});

test('no match and bad input give null', () => {
    assert.strictEqual(findSourceForChunk({ source_uri: 'zzz', title: 'zzz' }, SOURCES), null);
    assert.strictEqual(findSourceForChunk({}, SOURCES), null);
    assert.strictEqual(findSourceForChunk({ source_uri: 'id-report' }, []), null);
    assert.strictEqual(findSourceForChunk(null, SOURCES), null);
});
