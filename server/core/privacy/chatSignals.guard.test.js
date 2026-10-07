'use strict';

/**
 * Guard: chat signals never count messages between people (amendment 24).
 *
 * Project team chats, comment threads, support, Nextcloud Talk and the
 * Nextcloud task processing all carry messages written by people for people.
 * None of them may reach the recorder. This walks the source tree the way
 * layering.test.js does, derives every edge into core/privacy/chatSignals (or
 * a future core/privacy/chatHints) from those areas, and asserts that the
 * derived list is empty.
 *
 * Run: cd server && node --test core/privacy/chatSignals.guard.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireEdges } = require('../../testUtils/requireEdges');
const TARGETS = new Set(['core/privacy/chatSignals', 'core/privacy/chatHints']);

/** Areas between people, as path prefixes relative to server/. */
const HUMAN_TO_HUMAN_AREAS = [
    'routes/projects/', 'projects/', 'routes/support', 'services/support',
    'integrations/nextcloudTalk', 'routes/nextcloudTaskProcessing.js',
];

const EDGES = requireEdges({ targets: TARGETS });

test('nothing that carries messages between people requires the chat signals recorder', () => {
    const bad = EDGES
        .filter(e => HUMAN_TO_HUMAN_AREAS.some(a => e.from.startsWith(a)))
        .map(e => `${e.from} -> ${e.to}`);
    assert.deepEqual(bad, []);
});

test('the walk sees the tree (the guard is not vacuous)', () => {
    // index.js wires the shutdown flush, so at least that edge must be found.
    assert.ok(EDGES.some(e => e.from === 'index.js' && e.to === 'core/privacy/chatSignals'), 'the derived edge list is empty: the walk is broken');
});
