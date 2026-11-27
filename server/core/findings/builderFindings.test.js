// @typecheck
'use strict';
/**
 * core/findings/builderFindings: the deep link of a finding and the empty-knowledge-base rule,
 * core so Studio Home's attention list gives both without the projects module. Its source of the
 * empty knowledge base (routes/studio/attentionChecks.js kbEmptyInUse) is no longer gated on it.
 *
 * Run: cd server && node --test core/findings/builderFindings.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deepLinkFor, emptyKnowledgeBaseFinding } = require('./builderFindings');

test('a finding with a kind and an id links to its builder screen, escaped', () => {
    assert.equal(deepLinkFor({ targetRef: { kind: 'app', id: 'a1' } }), '/app/studio/apps/a1');
    assert.equal(deepLinkFor({ targetRef: { kind: 'kb', id: 'x/../y?z' } }), '/app/studio/knowledge/x%2F..%2Fy%3Fz');
    assert.equal(deepLinkFor({ targetRef: { kind: 'meeting', id: 7 } }), '/app/studio/meeting-notes/7');
});

test('no id, an unknown kind or no target: no link', () => {
    assert.equal(deepLinkFor({ targetRef: { kind: 'app', id: null } }), null);
    assert.equal(deepLinkFor({ targetRef: { kind: 'solution', id: 'p1' } }), null);
    assert.equal(deepLinkFor({}), null);
    assert.equal(deepLinkFor(null), null);
});

test('the empty knowledge base in use is advice, named after the base', () => {
    const f = emptyKnowledgeBaseFinding({ id: 'kb1', name: 'Handbook' });
    assert.equal(f.code, 'knowledge_base.empty_in_use');
    assert.equal(f.severity, 'warning');
    assert.equal(f.blockedAt, undefined);
    assert.deepEqual(f.targetRef, { kind: 'kb', id: 'kb1', title: 'Handbook' });
    assert.match(f.message, /^"Handbook" is used for answers but holds no documents/);
    assert.match(emptyKnowledgeBaseFinding({ id: 'kb2' }).message, /^"A knowledge base"/);
});

test('Studio Home\'s empty-knowledge-base source runs without the projects module', () => {
    const { SOURCES, evaluateKbEmptyInUse, KB_READ_ROLES } = require('../../routes/studio/attentionChecks');
    const source = SOURCES.find((s) => s.key === 'kbEmptyInUse');
    assert.ok(source);
    assert.deepEqual(source.needs ?? [], [], 'gated on no module');
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [{ kb: { id: 'kb1', name: 'Handbook', documentCount: 0 }, usageRows: [{ role: KB_READ_ROLES[0] }], usagePartial: [] }],
    });
    assert.deepEqual(gaps, []);
    assert.deepEqual(findings.map((f) => f.code), ['knowledge_base.empty_in_use']);
    assert.equal(deepLinkFor(findings[0]), '/app/studio/knowledge/kb1');
});
