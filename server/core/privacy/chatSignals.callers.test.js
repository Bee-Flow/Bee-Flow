'use strict';

/**
 * Guard: who may hand a chat turn to the chat-signals recorder.
 *
 * Chat signals count turns between a person and an AI on three chat types
 * (direct, agent, agent_public) and NEVER messages between people (amendment
 * 24): project team chats, comment threads, support, Nextcloud Talk, mail and
 * the Nextcloud task processing stay out, in every phase.
 * chatSignals.guard.test.js keeps those areas away from the recorder itself.
 * This file closes the side door: the hook helper direct chat uses
 * (routes/ai/directChat/chatSignalsTurn.js) counts whatever it is handed, so
 * it is a target too, and the full list of production files that reach the
 * recorder or that helper is pinned. A new caller is a red test: add it below
 * only after deciding that its turns are between a person and an AI, carry
 * the notice marker, and come with a notice the person saw.
 *
 * Same method as layering.test.js: walk the tree, derive the edge list from
 * the requires, assert on the derived list.
 *
 * Run: cd server && node --test core/privacy/chatSignals.callers.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../stores/lib/chatMonitoringVocab');
const { requireEdges } = require('../../testUtils/requireEdges');


/** What counts a turn: the recorder, a future hint module, and direct chat's hook helper. */
const TARGETS = new Set([
    'core/privacy/chatSignals',
    'core/privacy/chatHints',
    'routes/ai/directChat/chatSignalsTurn',
]);

/** Every production file allowed to reach a target, and why. */
const ALLOWED = new Map([
    ['index.js -> core/privacy/chatSignals', 'graceful shutdown flushes the counters'],
    ['routes/compliance/chatMonitoring.js -> core/privacy/chatSignals', '"Delete collected counts" drops the counts still waiting in this process (discardOrg); it counts nothing'],
    ['core/agentRuntime/chatStream/turnPreflight.js -> core/privacy/chatSignals', 'agent and embedded-agent turns (agent, agent_public)'],
    ['routes/ai/directChat/chatSignalsTurn.js -> core/privacy/chatSignals', 'the direct-chat hook helper'],
    ['routes/ai/directChat/streamTurn.js -> routes/ai/directChat/chatSignalsTurn', 'direct chat, after the input gates'],
    ['routes/ai/directChat/swarmTurn.js -> routes/ai/directChat/chatSignalsTurn', 'the Swarm tier of direct chat (unscanned)'],
]);

/** Areas that carry messages between people, as path prefixes relative to server/. */
const BETWEEN_PEOPLE = [
    'routes/projects/', 'projects/', 'routes/support', 'services/support',
    'integrations/nextcloudTalk', 'routes/nextcloudTaskProcessing.js',
    'routes/comments', 'routes/mail', 'integrations/mail',
];

const EDGES = [...new Set(requireEdges({ targets: TARGETS }).map(e => `${e.from} -> ${e.to}`))].sort();

test('the files that reach the recorder are exactly the reviewed list', () => {
    assert.deepEqual(EDGES, [...ALLOWED.keys()].sort(),
        'a new caller of the chat-signals recorder: decide that its turns are person-to-AI, marked and announced, then add it to ALLOWED');
});

test('nothing that carries messages between people reaches the recorder or the direct-chat hook', () => {
    const bad = EDGES.filter(e => BETWEEN_PEOPLE.some(a => e.startsWith(a)));
    assert.deepEqual(bad, []);
});

test('the vocabulary agrees: no chat type between people is a surface, now or later', () => {
    const counted = new Set([...V.SURFACES, ...V.FUTURE_SURFACES]);
    assert.deepEqual(V.HUMAN_TO_HUMAN.filter(s => counted.has(s)), []);
    for (const s of ['project_chat', 'comment', 'support', 'talk', 'mail']) assert.ok(V.HUMAN_TO_HUMAN.includes(s), s);
});

test('the walk sees the tree (the guard is not vacuous)', () => {
    assert.ok(EDGES.length >= 3, `only ${EDGES.length} edges found: the walk is broken`);
});
