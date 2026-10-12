/**
 * Naming an automation nobody named, and the diet the small band eats.
 *
 * An automation that reaches the list, the header, the playbook rail or the
 * activation e-mail as "Untitled automation" is a bug the person has to fix
 * by hand, so the route names it at three moments — before a finalize, before
 * the auto-finalize, and once after the loop — and tells the client with a
 * `metadata` event each time. The two failures this file exists to catch:
 *
 *   - a finalize that threw after the name was derived left the name in
 *     MEMORY only; the end-of-turn pass then read the draft as named and the
 *     ROW kept the default for ever. Both restore paths are driven here;
 *   - the `metadata` event sent BEFORE the persist carried `automationId:
 *     null` on the turn that minted the row, so the header refetched nothing.
 *
 * The rest is the small band's prompt-cache diet: the lean schema projection
 * is applied after the core filter and before the webpage tools (which are a
 * full-menu affair — given undocumented database tools a small model uses
 * them), the per-turn prefix log line is what makes a broken prefix cache
 * visible, and the draft-state message opens with the name.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/chatStream.naming.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

// Before `./builderDraft`, deliberately: the harness swaps the draft store in
// require.cache, and a module that loaded it first would keep the real one
// (and its database pool). The harness refuses to start if that has happened.
const h = createBuilderStream();
after(() => h.restore());

const { loadOrCreateDraft, seedFor } = require('./builderDraft');
const { UNTITLED_AUTOMATION } = require('../../../automation/builderTools/deriveTitle');

const BRIEF = 'Lees elke nieuwe factuur uit Nextcloud en schrijf de boeking weg in de tabel Boekingen.';
const DERIVED = 'Lees elke nieuwe factuur uit Nextcloud en schrijf de…';

/** A persisted draft with a real step, so the draft-state block renders. */
const draftRow = (over = {}) => ({
    id: 'auto_1',
    userId: 'u1',
    title: UNTITLED_AUTOMATION,
    description: '',
    definition: {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [{ id: 's1', type: 'set', label: 'Factuur lezen', spec: {}, settings: { assignments: [{ var: 'x', value: '1' }] } }],
        edges: [{ from: 'trg', to: 's1' }],
        vars: {},
    },
    ...over,
});

/** The late system message: everything that is allowed to change per turn. */
const dynamicMessage = (messages) => messages.filter((m) => m.role === 'system').at(-1).content;
const toolNames = (run, i = 0) => run.roundOptions(i).tools.map((t) => t.function.name);

/**
 * Two runnable apps. The order they are rendered in sits at the FRONT of the
 * system prompt, so it is also the front of every provider's prompt cache.
 */
const CATALOG = {
    apps: [
        { id: 'alpha', label: 'Alpha', available: true, connected: true, permitted: true, actions: [{ name: 'alpha_list_files', description: 'List files' }] },
        { id: 'beta', label: 'Beta', available: true, connected: true, permitted: true, actions: [{ name: 'beta_write_row', description: 'Write a row' }] },
    ],
    toolNames: new Set(['alpha_list_files', 'beta_write_row']),
    triggerOutputs: {},
};

/** The one prefix line the round logs, with console.log captured. */
async function withLoggedLines(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { return { out: await fn(), lines }; } finally { console.log = real; }
}

test('the small band gets the core menu, lean-projected, and never the webpage tools', async () => {
    const small = await h.run({
        message: BRIEF,
        modelId: 'gemma-4-26b-a4b',
        config: { builder_model_profiles: { 'gemma-4-26b-a4b': 'small' } },
        betaFeatures: ['automations', 'webpages'],
    });
    const lean = toolNames(small);
    assert.ok(!lean.some((n) => n.startsWith('webpage')),
        'a small model given undocumented database tools uses them — the lean prompt documents none');
    assert.ok(lean.every((n) => n.startsWith('builder_')));
    assert.strictEqual(small.roundOptions(0).toolChoice, 'required', 'and round 0 is pinned to a call');

    const full = await h.run({
        message: BRIEF,
        modelId: 'claude-sonnet-4-5',
        betaFeatures: ['automations', 'webpages'],
    });
    const wide = toolNames(full);
    assert.ok(wide.includes('webpage_db_schema'), 'the full menu carries the inspection surface');
    assert.ok(wide.length > lean.length, 'and the diet really is a diet');

    // The projection runs on the CORE set, not on the full one: every tool the
    // small band keeps is a core tool, and its schemas are the shorter ones.
    const bytesOf = (run) => JSON.stringify(run.roundOptions(0).tools).length;
    assert.ok(bytesOf(small) < bytesOf(full) / 2, 'shorter texts, shared params once, four tools fewer');
});

test('the prefix line reports the four digests, and they hold across the turns of a session', async () => {
    const digests = (lines) => {
        const line = lines.find((l) => l.includes('[AutomationBuilder] prefix sys='));
        assert.ok(line, 'the round logged its prefix line');
        return Object.fromEntries([...line.matchAll(/(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]));
    };
    const turn = ({ history = [], draft = draftRow(), builderSession = null } = {}) => h.run({
        message: history.length ? 'Schrijf de boeking weg in Beta.' : BRIEF,
        body: { automationId: 'auto_1', builderSessionId: 'bs_1', history },
        draft,
        builderSession,
        catalog: CATALOG,
        modelId: 'gemma-4-26b-a4b',
        config: { builder_model_profiles: { 'gemma-4-26b-a4b': 'small' } },
    });

    const first = await withLoggedLines(() => turn({}));
    const d1 = digests(first.lines);
    for (const key of ['sys', 'tools', 'toolBytes', 'fewShots', 'n', 'history']) {
        assert.ok(key in d1, `the line carries ${key}=`);
    }

    const second = await withLoggedLines(() => turn({
        history: [{ role: 'user', content: BRIEF }, { role: 'assistant', content: 'Ok.' }],
        builderSession: first.out.storedSessions.at(-1).payload,
    }));
    const d2 = digests(second.lines);
    for (const key of ['sys', 'tools', 'toolBytes', 'fewShots']) {
        assert.strictEqual(d2[key], d1[key],
            `${key} changed between two turns of one session — that is the whole prompt re-prefilled`);
    }
    assert.strictEqual(d2.history, '2', 'only the history grew');

    // None of the four is a constant: the full band reads a different menu
    // (other names AND other bytes) beside a different number of few-shots.
    const wide = digests((await withLoggedLines(() => h.run({
        message: BRIEF,
        body: { automationId: 'auto_1', builderSessionId: 'bs_2' },
        draft: draftRow(),
        catalog: CATALOG,
        modelId: 'claude-sonnet-4-5',
    }))).lines);
    for (const key of ['sys', 'tools', 'toolBytes', 'fewShots']) {
        assert.notStrictEqual(wide[key], d1[key], `${key}= does not react to the menu it reports on`);
    }
});

test('the catalogue order is chosen once per session and replayed, not re-ranked per message', async () => {
    // rankAppsForMessage scores against THIS message and pins the apps the
    // draft already uses, so its output changed on every reply and as steps
    // were added — and the catalogue is rendered into the prompt block the
    // local runtime caches. A session with a stored order never ranks again.
    const order = (run) => [...dynamicMessage(run.roundMessages(0)).matchAll(/^### (\w+) /gm)].map((m) => m[1]);
    const session = {
        message: BRIEF,
        body: { automationId: 'auto_1', builderSessionId: 'bs_rank' },
        catalog: CATALOG,
        modelId: 'gemma-4-26b-a4b',
        config: { builder_model_profiles: { 'gemma-4-26b-a4b': 'small' } },
    };
    const first = await h.run({ ...session, draft: draftRow() });
    assert.deepStrictEqual(order(first), ['Alpha', 'Beta']);

    // Turn 2: the draft now uses Beta's tool, which pins Beta to the front of
    // a fresh ranking.
    const grown = draftRow();
    grown.definition.steps.push({ id: 's2', type: 'action', tool: 'beta_write_row', label: 'Boeking wegschrijven', spec: {}, settings: {} });
    grown.definition.edges.push({ from: 's1', to: 's2' });
    const second = await h.run({
        ...session,
        message: 'Schrijf de boeking weg in Beta.',
        body: { ...session.body, history: [{ role: 'user', content: BRIEF }, { role: 'assistant', content: 'Ok.' }] },
        draft: grown,
        builderSession: first.storedSessions.at(-1).payload,
    });
    assert.deepStrictEqual(order(second), ['Alpha', 'Beta'], 'the order this session opened with is the order it keeps');
    assert.deepStrictEqual(first.storedSessions.at(-1).payload.catalogOrder, ['alpha', 'beta'],
        'and it is stored with the session, or there is nothing to replay');
});

test('the draft-state message opens with the name, or with the fact that there is none', async () => {
    const named = await h.run({
        message: 'Voeg een stap toe.',
        body: { automationId: 'auto_1' },
        draft: draftRow({ title: 'Facturen inlezen' }),
    });
    assert.match(dynamicMessage(named.roundMessages(0)), /Title: "Facturen inlezen"/);

    const untitled = await h.run({
        message: 'Voeg een stap toe.',
        body: { automationId: 'auto_1' },
        draft: draftRow(),
    });
    assert.match(dynamicMessage(untitled.roundMessages(0)), /Title: \(untitled — call builder_set_metadata in this reply\)/,
        'the default name counts as untitled, or the model reads it as a name someone chose');
});

test('an accepted builder_set_metadata sends the event AFTER the persist, so it carries the minted id', async () => {
    const run = await h.run({
        message: BRIEF,
        rounds: [
            { toolCalls: [call('builder_set_metadata', { title: 'Facturen inlezen', description: 'Leest facturen.' })] },
            { text: 'Klaar.' },
        ],
        tools: {
            builder_set_metadata: (args, wrap) => { wrap.title = args.title; wrap.description = args.description; return { ok: true }; },
        },
    });
    assert.deepStrictEqual(run.dataOf('metadata'), [{ automationId: 'auto_minted', title: 'Facturen inlezen', description: 'Leest facturen.' }],
        'the row this first mutation minted is on the event — the header refetches on it');

    const refused = await h.run({
        message: BRIEF,
        body: { automationId: 'auto_1' },
        draft: draftRow({ title: 'Facturen inlezen' }),
        rounds: [{ toolCalls: [call('builder_set_metadata', { title: '' })] }, { text: 'Klaar.' }],
        tools: { builder_set_metadata: () => ({ error: 'A title is required.' }) },
    });
    assert.deepStrictEqual(refused.dataOf('metadata'), [], 'a refused rename renames nothing');
});

test('the name is read off the BRIEF — the first user message of the session, not this reply', async () => {
    const run = await h.run({
        message: 'ok',
        body: {
            automationId: 'auto_1',
            history: [{ role: 'user', content: BRIEF }, { role: 'assistant', content: 'Ik begin.' }],
        },
        draft: draftRow(),
        rounds: [{ text: 'Klaar.' }],
        tools: { builder_finalize: () => ({ automation: { id: 'auto_1' } }) },
    });
    assert.strictEqual(run.last('metadata').title, DERIVED, 'named "ok" before this');
});

test('a finalize on an untitled draft is named BEFORE the call, and the result says so', async () => {
    const seen = [];
    const run = await h.run({
        message: BRIEF,
        body: { automationId: 'auto_1' },
        draft: draftRow(),
        rounds: [{ toolCalls: [call('builder_finalize', {})] }, { text: 'Klaar.' }],
        tools: {
            builder_finalize: (_args, wrap) => { seen.push(wrap.title); return { automation: { id: 'auto_1' } }; },
        },
    });
    assert.deepStrictEqual(seen, [DERIVED],
        'persistDraft writes the title INSIDE the finalize, so the name has to exist before the call');
    const result = run.dataOf('tool_call').find((e) => e.name === 'builder_finalize').result;
    assert.strictEqual(result._hint, `Named "${DERIVED}" automatically — call builder_set_metadata to rename.`);
    assert.deepStrictEqual(run.dataOf('metadata'), [{ automationId: 'auto_1', title: DERIVED, description: '' }]);
    assert.ok(run.has('finalized'));
});

test('a finalize that never persisted puts the default back, so the end-of-turn pass still writes the name', async () => {
    // The name exists in MEMORY from the moment ensureDraftTitle runs. When
    // the call then throws, a draft that still reads as named is skipped by
    // the end-of-turn block — and the row keeps "Untitled automation".
    const run = await h.run({
        message: BRIEF,
        body: { automationId: 'auto_1' },
        draft: draftRow(),
        rounds: [{ toolCalls: [call('builder_finalize', {})] }, { text: 'Het lukte niet.' }],
        tools: { builder_finalize: () => { throw new Error('trigger resync failed'); } },
    });
    assert.ok(!run.has('finalized'));
    assert.deepStrictEqual(run.dataOf('metadata'), [{ automationId: 'auto_1', title: DERIVED, description: '' }],
        'exactly one metadata event — the end-of-turn naming, not the failed finalize');
    assert.deepStrictEqual(run.persists.at(-1), { automationId: 'auto_1', title: DERIVED, def: draftRow().definition },
        'and the name reached the row');
});

test('auto-finalize names the draft first, and puts the default back when it fails', async () => {
    const seen = [];
    const ok = await h.run({
        message: BRIEF,
        body: { automationId: 'auto_1' },
        draft: draftRow(),
        rounds: [{ text: 'Je automation is klaar.' }],
        tools: { builder_finalize: (_a, wrap) => { seen.push(wrap.title); return { automation: { id: 'auto_1' } }; } },
    });
    assert.deepStrictEqual(seen, [DERIVED], 'an automation never ships as "Untitled automation"');
    assert.deepStrictEqual(ok.dataOf('metadata'), [{ automationId: 'auto_1', title: DERIVED, description: '' }]);
    assert.deepStrictEqual(ok.first('finalized'), { automationId: 'auto_1', autoFinalized: true });

    const failed = await h.run({
        message: BRIEF,
        body: { automationId: 'auto_1' },
        draft: draftRow(),
        rounds: [{ text: 'Je automation is klaar.' }],
        tools: { builder_finalize: () => { throw new Error('auto-finalize failed'); } },
    });
    assert.ok(!failed.has('finalized'));
    assert.deepStrictEqual(failed.dataOf('metadata'), [{ automationId: 'auto_1', title: DERIVED, description: '' }],
        'the end-of-turn pass names it once, because the restore handed it back the default');
    assert.strictEqual(failed.persists.at(-1).title, DERIVED);
});

test('a draft that was never persisted has no row to name', async () => {
    const run = await h.run({
        message: BRIEF,
        rounds: [{ text: 'Wat wil je precies?' }],
    });
    assert.deepStrictEqual(run.dataOf('metadata'), []);
    assert.deepStrictEqual(run.persists, []);
    assert.strictEqual(run.last('done').automationId, null);
});

test('a host\'s seedMetadata names a draft this request creates, and never an existing one', async () => {
    const fresh = await h.run({
        message: BRIEF,
        body: { seedMetadata: { title: '  Facturen  inlezen ', description: ' Leest facturen. ' } },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] })] }, { text: 'Klaar.' }],
        tools: { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }] }) },
    });
    assert.strictEqual(fresh.persists.at(-1).title, 'Facturen inlezen', 'whitespace-collapsed, named from its first persisted byte');
    assert.deepStrictEqual(fresh.dataOf('metadata'), [], 'nothing to announce — the host already knows the name it sent');

    const existing = await h.run({
        message: BRIEF,
        body: { automationId: 'auto_1', seedMetadata: { title: 'Iets anders' } },
        draft: draftRow({ title: 'Facturen inlezen' }),
        rounds: [{ text: 'Klaar.' }],
        tools: { builder_finalize: () => ({ automation: { id: 'auto_1' } }) },
    });
    assert.match(dynamicMessage(existing.roundMessages(0)), /Title: "Facturen inlezen"/,
        'a name the person or the model chose is not overwritten by a host re-sending its brief');
});

test('seedFor and loadOrCreateDraft: what a host may hand in', async () => {
    assert.deepStrictEqual(seedFor({ title: '  Facturen  inlezen ', description: ' Leest facturen. ' }), { title: 'Facturen inlezen', description: 'Leest facturen.' });
    assert.deepStrictEqual(seedFor(null), { title: UNTITLED_AUTOMATION, description: '' });
    assert.deepStrictEqual(seedFor({ title: 42, description: ['x'] }), { title: UNTITLED_AUTOMATION, description: '' });
    assert.strictEqual(seedFor({ title: 'y'.repeat(100) }).title.length, 60, 'clamped to the title cap');
    const fresh = await loadOrCreateDraft({ userId: 'u', builderSessionId: 'bs_x', automationId: null, seedMetadata: { title: 'Facturen inlezen' } });
    assert.strictEqual(fresh.title, 'Facturen inlezen');
    assert.strictEqual(fresh.automationId, null);
    const plain = await loadOrCreateDraft({ userId: 'u', builderSessionId: 'bs_y', automationId: null });
    assert.strictEqual(plain.title, UNTITLED_AUTOMATION, 'no seed, the default');
});

test('unsigned thinking is replayed only for an adapter that surfaces raw reasoning, as {text} alone', async () => {
    const round0 = {
        thinking: [{ text: 'Eerst de stap.' }, { text: 'En getekend.', signature: 'sig-1' }],
        toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] })],
    };
    const tools = { builder_add_steps: () => ({ ok: true, added: [{ id: 's1' }] }) };

    const raw = await h.run({
        message: BRIEF, body: { automationId: 'auto_1' }, draft: draftRow(),
        surfacesRawReasoning: true, rounds: [round0, { text: 'Klaar.' }], tools,
    });
    const rawAssistant = raw.roundMessages(1).findLast((m) => m.role === 'assistant' && m.tool_calls);
    assert.strictEqual(rawAssistant.thinking.length, 2,
        'the local adapter re-reads the reasoning that led to the call instead of re-deriving it every round');
    assert.deepStrictEqual(rawAssistant.thinking[0], { text: 'Eerst de stap.' }, 'an unsigned part carries text and nothing else');
    assert.strictEqual(rawAssistant.thinking[1].signature, 'sig-1', 'a signed part keeps its signature');

    const signedOnly = await h.run({
        message: BRIEF, body: { automationId: 'auto_1' }, draft: draftRow(),
        surfacesRawReasoning: false, rounds: [round0, { text: 'Klaar.' }], tools,
    });
    const assistant = signedOnly.roundMessages(1).findLast((m) => m.role === 'assistant' && m.tool_calls);
    assert.deepStrictEqual(assistant.thinking.map((p) => p.text), ['En getekend.'],
        'the Claude adapter drops an unsigned part, so replaying one only costs tokens');
});
