/**
 * A chat-builder turn starts with the runtime shapes of the draft's tools on
 * the draftWrap.
 *
 * builderTools/refCheck.js and outputFields.js check a binding's path against
 * `draftWrap._runtimeShapes[tool]` (what the tool really returned on this
 * user's last live run, shapeCache.js) before the curated shape — but the
 * route never set it, so a path into a field only the real output carries
 * was refused as unknown in every chat build. A cache that fails must not
 * cost the turn.
 *
 * The same turn after the person tested the automation themselves, and with
 * a screenshot attached (the owner's "kan je dit oplossen" + picture):
 *  - a failed run newer than the session puts "## Last run" in the dynamic
 *    message, with the failed step's code and its error text masked, and the
 *    rule to read that run before asking anything;
 *  - with no such run the model's messages are byte-identical to a turn
 *    without it (no run, or one the session already knows);
 *  - a picture reaches a model that can see as an image part of this user
 *    message only; a model that cannot see gets one line instead, and the
 *    client hears both through the `images` event.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.runtimeShapes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

// Before anything that loads the stores: the harness refuses otherwise.
const h = createBuilderStream();
after(() => h.restore());

const shapeCache = require('../../../automation/shapeCache');

const draftRow = () => ({
    id: 'auto_1',
    userId: 'u1',
    title: 'Files',
    description: '',
    definition: {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [
            { id: 'ls', type: 'integration_action', tool: 'nextcloud_list_files', inputs: {} },
            { id: 'rd', type: 'integration_action', tool: 'nextcloud_read_file', inputs: {} },
        ],
        edges: [{ from: 'trg', to: 'ls' }, { from: 'ls', to: 'rd' }],
        vars: {},
    },
});

async function turnSeeing(getShape) {
    const original = shapeCache.getShape;
    shapeCache.getShape = getShape;
    let seen = 'not called';
    try {
        await h.run({
            body: { automationId: 'auto_1', builderSessionId: 'bs_shapes' },
            draft: draftRow(),
            rounds: [{ toolCalls: [call('builder_summarise', {})] }, { text: 'Klaar.' }],
            onTool: async (_name, _args, wrap) => { seen = wrap._runtimeShapes; return { summary: 'ok' }; },
        });
    } finally {
        shapeCache.getShape = original;
    }
    return seen;
}

test('the draft\'s tools get their recorded runtime shapes at turn start', async () => {
    const asked = [];
    const seen = await turnSeeing(async ({ userId, toolName }) => {
        asked.push(`${userId}:${toolName}`);
        return toolName === 'nextcloud_list_files' ? { items: { _array: { name: 'string', etag: 'string' }, _length: 3 } } : null;
    });
    assert.deepStrictEqual(asked.sort(), ['u1:nextcloud_list_files', 'u1:nextcloud_read_file']);
    assert.deepStrictEqual(Object.keys(seen), ['nextcloud_list_files']);
    assert.ok(seen.nextcloud_list_files.items._array.etag);
});

test('a failing shape cache leaves the turn running, with no shapes', async () => {
    const seen = await turnSeeing(async () => { throw new Error('redis down'); });
    assert.deepStrictEqual(seen, {});
});

// ── The latest run and the attached pictures ────────────────────────

const piiDetection = require(path.join(__dirname, '..', '..', '..', 'core/privacy/piiDetection'));
const realDetectPii = piiDetection.detectPii;
piiDetection.detectPii = async (text) => (String(text).includes('person@example.test')
    ? { hasPii: true, entities: [{ text: 'person@example.test', label: 'Email', score: 1 }] }
    : { hasPii: false, entities: [] });
after(() => { piiDetection.detectPii = realDetectPii; });

const definition = {
    schemaVersion: 2,
    trigger: { id: 'form', type: 'trigger', kind: 'form' },
    steps: [{ id: 'beoordeel', type: 'ai_step', label: 'Beoordeel deze klacht', settings: { prompt: 'Beoordeel' } }],
    edges: [{ from: 'form', to: 'beoordeel' }],
};
const draft = () => ({ id: 'a1', userId: 'u1', title: 'Klachten', description: '', definition: structuredClone(definition) });
const SESSION_AT = '2026-11-04T11:00:00.000Z';
const RUN = { id: 'run_1', automationId: 'a1', mode: 'live', isTest: true, status: 'error', startedAt: '2026-11-04T11:55:00.000Z', finishedAt: '2026-11-04T11:55:09.000Z' };
const RUN_STEPS = { run_1: [
    { runId: 'run_1', stepId: 'form', stepType: 'form_trigger', status: 'success', output: { naam: 'Jan de Vries', email: 'person@example.test' } },
    { runId: 'run_1', stepId: 'beoordeel', stepType: 'ai_step', status: 'error', input: { text: 'Mijn laptop is kapot' },
        error: "This AI step's answer did not pass its checks after one repair round: prioriteit: the list of allowed values is empty (asked by person@example.test)",
        errorInfo: { code: 'ai_checks_failed' } },
] };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SHOT = { name: 'scherm.png', type: 'image/png', size: 70, content: PNG };

const turn = (over = {}) => h.run({
    message: 'kan je dit oplossen',
    draft: draft(),
    builderSession: { updatedAt: SESSION_AT, version: 2 },
    body: { automationId: 'a1', workMode: 'build' },
    rounds: [{ text: 'Ik kijk ernaar.' }],
    ...over,
});
const dynamic = (run) => run.roundMessages(0).filter((m, i) => i > 0 && m.role === 'system').map((m) => m.content).join('\n');

test('a failed run the person started after the last turn: "## Last run" with the code and the masked message', async () => {
    const run = await turn({ runs: [RUN], runSteps: RUN_STEPS });
    const d = dynamic(run);
    assert.match(d, /## Last run\nThe latest run of this automation was a test run started 2026-11-04T11:55:00\.000Z, it failed\./);
    assert.match(d, /- `form` \(form_trigger\) ran/);
    assert.match(d, /- `beoordeel` \(ai_step\) failed with code `ai_checks_failed`: This AI step's answer did not pass its checks after one repair round: prioriteit: the list of allowed values is empty \(asked by \[\w+\]\)/);
    assert.match(d, /FIRST read this run with builder_inspect_run on the failed step/);
    const all = JSON.stringify(run.roundMessages(0));
    for (const value of ['person@example.test', 'Jan de Vries', 'Mijn laptop']) assert.ok(!all.includes(value), `${value} reached the model`);
    assert.ok(!JSON.stringify(run.storedSessions).includes('Last run'), 'the block is not stored');
});

test('no run, or one the session already knows: the messages are byte-identical to a turn without the feature', async () => {
    const none = await turn();
    const known = await turn({ runs: [RUN], runSteps: RUN_STEPS, builderSession: { updatedAt: '2026-11-04T12:00:00.000Z', version: 2 } });
    assert.ok(!dynamic(none).includes('## Last run'));
    assert.deepEqual(known.roundMessages(0), none.roundMessages(0));
    assert.ok(!none.has('images'));
});

test('a screenshot for a model that can see: an image part of this user message, nowhere else', async () => {
    const run = await turn({ supportsVision: true, body: { automationId: 'a1', workMode: 'build', attachments: [SHOT] }, runs: [RUN], runSteps: RUN_STEPS });
    const msgs = run.roundMessages(0);
    const user = msgs.findLast((m) => m.role === 'user');
    assert.deepEqual(user.content.map((p) => p.type), ['text', 'image_url', 'text']);
    assert.equal(user.content[0].text, 'kan je dit oplossen', 'no name line for the picture the model sees');
    assert.equal(user.content[1].image_url.url, PNG);
    assert.equal(JSON.stringify(msgs).split('data:image/png').length - 1, 1, 'the picture is sent once');
    assert.deepEqual(run.first('images'), { attached: 1, shown: 1, skipped: 0, blind: false });
    assert.ok(!JSON.stringify(run.storedSessions).includes('data:image'), 'the picture is not stored with the session');
    assert.match(dynamic(run), /## Last run/);
});

test('a model that cannot see: one honest line, the name line, and it still reads the last run', async () => {
    const run = await turn({ supportsVision: false, body: { automationId: 'a1', workMode: 'build', attachments: [SHOT] }, runs: [RUN], runSteps: RUN_STEPS });
    const msgs = run.roundMessages(0);
    const user = msgs.findLast((m) => m.role === 'user');
    assert.equal(typeof user.content, 'string');
    assert.match(user.content, /\[User attached 1 file\(s\) to this turn: scherm\.png\./);
    assert.ok(!JSON.stringify(msgs).includes('data:image'));
    const d = dynamic(run);
    assert.match(d, /The person attached 1 image to this message, but the model of this turn cannot see images/);
    assert.match(d, /## Last run/);
    assert.deepEqual(run.first('images'), { attached: 1, shown: 0, skipped: 0, blind: true });
});
