/**
 * Automation runs reaching the project feed.
 *
 * The rules worth pinning down:
 *
 *   1. AUTOMATION RUNS GET THEIR OWN EVENT KINDS. The feed already carries
 *      `run.started` / `run.finished` for CHAT runs, keyed on a conversation
 *      id, and ProjectDetailPage drives a per-thread "answering…" spinner off
 *      them. Emitting a bare `run.started` for an automation would light up a
 *      conversation that is not running.
 *   2. THE RAW ERROR STRING NEVER TRAVELS. A failure message can quote an
 *      integration's response, and the project feed is read by every member.
 *   3. ONE LOOKUP PER RUN, NOT THREE.
 *   4. A STANDALONE AUTOMATION IS SILENT — which is most of them.
 *
 * Run: cd server && node --test core/projectFeed.runs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const feedPath = require.resolve('./projectFeed');
const storePath = require.resolve('../stores/automationStore');

const emitted = [];
let lookups = 0;
let automations = {};
let lookupError = null;

require.cache[feedPath] = {
    id: feedPath, filename: feedPath, loaded: true,
    exports: {
        emitProjectEvent: async (projectId, event, opts) => { emitted.push({ projectId, event, opts }); },
    },
};
require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
        getAutomation: async (id) => {
            lookups++;
            if (lookupError) throw lookupError;
            return automations[id] || null;
        },
    },
};

const { _test } = require('./projectFeed.runs');
const { _handle, _runContext, MAX_TRACKED_RUNS } = _test;

function reset() {
    emitted.length = 0;
    lookups = 0;
    lookupError = null;
    _runContext.clear();
    automations = {
        a1: { id: 'a1', title: 'Nightly invoices', projectId: 'p1' },
        solo: { id: 'solo', title: 'Standalone', projectId: null },
    };
}

test('a run in a project reaches that project under its OWN kind', async () => {
    reset();
    await _handle({ type: 'run.started', runId: 'r1', automationId: 'a1', triggerKind: 'schedule' });

    assert.strictEqual(emitted.length, 1);
    const { projectId, event } = emitted[0];
    assert.strictEqual(projectId, 'p1');
    assert.strictEqual(event.kind, 'automation.run.started',
        'never bare run.started — that name belongs to chat runs');
    assert.strictEqual(event.targetType, 'automation');
    assert.strictEqual(event.targetId, 'a1');
    assert.strictEqual(event.actorId, null, 'the runner acted, not a person');
    assert.strictEqual(event.payload.automationTitle, 'Nightly invoices');
    assert.strictEqual(event.payload.triggerKind, 'schedule');
});

test('a standalone automation says nothing', async () => {
    reset();
    await _handle({ type: 'run.started', runId: 'r1', automationId: 'solo' });
    assert.strictEqual(emitted.length, 0);
});

test('step events are not bridged', async () => {
    reset();
    await _handle({ type: 'step.started', runId: 'r1', automationId: 'a1', stepId: 's1' });
    await _handle({ type: 'step.finished', runId: 'r1', automationId: 'a1', stepId: 's1' });
    await _handle({ type: 'step.heartbeat', runId: 'r1', automationId: 'a1', stepId: 's1' });
    assert.strictEqual(emitted.length, 0, 'a project feed is not a per-step trace');
    assert.strictEqual(lookups, 0, 'and they cost nothing to ignore');
});

test('start plus finish costs exactly one lookup', async () => {
    reset();
    await _handle({ type: 'run.started', runId: 'r1', automationId: 'a1' });
    await _handle({ type: 'run.finished', runId: 'r1', automationId: 'a1', status: 'success', durationMs: 1200 });

    assert.strictEqual(lookups, 1, 'the terminal event reuses what started remembered');
    assert.strictEqual(emitted.length, 2);
    assert.strictEqual(emitted[1].event.kind, 'automation.run.finished');
    assert.strictEqual(emitted[1].event.payload.status, 'success');
    assert.strictEqual(emitted[1].event.payload.durationMs, 1200);
});

test('a terminal event stops tracking its run', async () => {
    reset();
    await _handle({ type: 'run.started', runId: 'r1', automationId: 'a1' });
    assert.strictEqual(_runContext.size, 1);
    await _handle({ type: 'run.finished', runId: 'r1', automationId: 'a1', status: 'success' });
    assert.strictEqual(_runContext.size, 0, 'otherwise every completed run leaks');
});

test('a pod that restarted mid-run still reports the finish', async () => {
    reset();
    // No run.started was seen by THIS process, so there is nothing remembered.
    await _handle({ type: 'run.finished', runId: 'r99', automationId: 'a1', status: 'success' });
    assert.strictEqual(lookups, 1, 'it falls back to a lookup');
    assert.strictEqual(emitted.length, 1, 'rather than dropping the event');
});

test('the raw error never travels; the class does', async () => {
    reset();
    await _handle({
        type: 'run.failed', runId: 'r1', automationId: 'a1',
        errorClass: 'integration_error',
        error: 'Bearer sk-live-abc123 rejected by https://internal.example/api',
    });

    const payload = emitted[0].event.payload;
    assert.strictEqual(payload.errorClass, 'integration_error');
    assert.strictEqual(payload.error, undefined, 'a failure message can quote an integration response');
    assert.ok(!JSON.stringify(emitted[0]).includes('sk-live-abc123'));
});

test('the tracking map is bounded', async () => {
    reset();
    for (let i = 0; i < MAX_TRACKED_RUNS + 50; i++) {
        await _handle({ type: 'run.started', runId: `r${i}`, automationId: 'a1' });
    }
    assert.ok(_runContext.size <= MAX_TRACKED_RUNS,
        'a run that never terminates must not leak the map');
});

test('an unresolvable automation is silent, not fatal', async () => {
    reset();
    lookupError = new Error('db down');
    await assert.doesNotReject(() => _handle({ type: 'run.started', runId: 'r1', automationId: 'a1' }));
    assert.strictEqual(emitted.length, 0);
});

test('an unknown automation id emits nothing', async () => {
    reset();
    await _handle({ type: 'run.started', runId: 'r1', automationId: 'ghost' });
    assert.strictEqual(emitted.length, 0);
});

test('a standalone run costs one lookup for the whole run, not one per event', async () => {
    reset();
    await _handle({ type: 'run.started', runId: 'r1', automationId: 'solo' });
    await _handle({ type: 'run.finished', runId: 'r1', automationId: 'solo', status: 'success' });

    // The absence of a project is remembered too, so the terminal event never
    // reaches the store. Most automations are standalone, so this is the
    // common path, not the edge case.
    assert.strictEqual(lookups, 1);
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(_runContext.size, 0, 'and it stops tracking either way');
});

test('a prototype-chain key is not a run kind', async () => {
    reset();
    // A plain-object lookup would resolve these truthily and emit nonsense.
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        await _handle({ type, runId: 'r1', automationId: 'a1' });
    }
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(lookups, 0);
});
