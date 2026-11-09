// @typecheck
/**
 * kb/model.buildDocumentFilters: the WHERE of the document list.
 *
 * The sender filter went into ILIKE as typed, so a sender containing `_` or
 * `%` (j_doe@example.test) matched as a wildcard and listed mail from other
 * senders. The title filter (`q`) next to it was already escaped.
 *
 * Run: cd server && node --test stores/kb/model.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDocumentFilters } = require('./model');

test('sender is literal text in ILIKE: % and _ are escaped', () => {
    const { clauses, vals } = buildDocumentFilters('kb1', { sender: 'j_doe%' });
    assert.deepEqual(clauses, ['knowledge_base_id = $1', `metadata->>'from' ILIKE $2`]);
    assert.deepEqual(vals, ['kb1', '%j\\_doe\\%%']);
});

test('a plain sender and the title filter keep their shape', () => {
    const { clauses, vals } = buildDocumentFilters('kb1', { sender: 'alice', q: '50%' });
    assert.deepEqual(clauses, ['knowledge_base_id = $1', `metadata->>'from' ILIKE $2`, 'title ILIKE $3']);
    assert.deepEqual(vals, ['kb1', '%alice%', '%50\\%%']);
});
