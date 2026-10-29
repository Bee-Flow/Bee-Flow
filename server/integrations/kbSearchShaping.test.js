'use strict';

/**
 * The pure steps around a kb_search retrieval (kbSearchShaping.js).
 *
 * Run: cd server && node --test integrations/kbSearchShaping.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    smallTalkCore, scoredResults, dedupeNearDuplicates, stripRepeatedHeadings, labelSections,
} = require('./kbSearchShaping');

test('smallTalkCore: a greeting with filler words is small talk, a question is not', () => {
    assert.equal(smallTalkCore('servicedesk assistent welkom hi'), 'welkom hi');
    assert.equal(smallTalkCore('thanks!'), 'thanks!');
    assert.equal(smallTalkCore('hi, how do I reset the VPN token on a new laptop'), null);
    assert.equal(smallTalkCore('expense policy'), null);
});

test('scoredResults: the score cut, the ids and the numbering', () => {
    const out = scoredResults([
        { id: 'r1', chunk_id: 3, score: 0.91234, title: 'Policy', content: 'a' },
        { chunk_id: 4, rerank_score: 0.2, content: 'b' },
        { chunk_id: 5, rerank_score: 0.5, source_uri: 'https://kb.example.test/x', content: 'c' },
    ], 0.35);
    assert.deepEqual(out.map((r) => [r.chunk_id, r.result_number, r.title, r.source_url, r.score]), [
        ['r1', 1, 'Policy', null, 0.912],
        [5, 2, 'https://kb.example.test/x', 'https://kb.example.test/x', 0.5],
    ]);
});

test('dedupeNearDuplicates keeps the first of near-identical bodies', () => {
    const body = 'the travel policy allows economy class flights for every trip under six hours';
    const results = scoredResults([
        { chunk_id: 1, score: 1, content: `# Travel\n${body}` },
        { chunk_id: 2, score: 1, content: `## Other heading\n${body}` },
        { chunk_id: 3, score: 1, content: 'a completely different passage about expense claims and receipts' },
    ], 0);
    assert.deepEqual(dedupeNearDuplicates(results).map((r) => r.chunk_id), [1, 3]);
});

test('stripRepeatedHeadings drops a heading an earlier chunk of the document carried, and caps', () => {
    const results = scoredResults([
        { chunk_id: 1, score: 1, title: 'Handbook', content: '# Handbook\n## Leave\nFirst part.' },
        { chunk_id: 2, score: 1, title: 'Handbook', content: '# Handbook\n## Leave\nSecond part.' },
        { chunk_id: 3, score: 1, title: 'Other', content: 'x'.repeat(20) },
    ], 0);
    stripRepeatedHeadings(results, 10);
    assert.equal(results[1].content, 'Second par…');
    assert.equal(results[2].content, 'xxxxxxxxxx…');
    assert.equal(results[0].content.length, 11);
});

test('labelSections: deepest heading and snippet, or the chunk number', () => {
    const results = scoredResults([
        { chunk_id: 1, score: 1, content: '# Handbook\n## Leave\nYou get twenty-five days of leave per year.' },
        { chunk_id: 2, score: 1, content: '## Only a heading' },
        { chunk_id: 3, score: 1, content: 'short' },
    ], 0);
    assert.deepEqual(labelSections(results).map((a) => a.sectionLabel), [
        'Leave — You get twenty-five days of leave per year',
        'Only a heading',
        'Chunk 3',
    ]);
});
