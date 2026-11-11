/**
 * The look of a new app: the per-app design seed and the design brief call (designBrief.mts).
 * The last tests run the two seams the route joins them at: the turn's prompt
 * (promptAssembly.assembleTurnPrompt) and the session snapshot (turnClosing.persistTurnSnapshot).
 *
 * Run: node --test routes/ai/appStudioBuilder/designBrief.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    designSeed, renderDesignSeed, designSeedNote, lookIsOpen, wantsDesignBrief, designBriefSettings, designBriefMessages,
    cleanBrief, designBriefNote, requestDesignBrief, designNotesForTurn, DESIGN_BRIEF_MAX_CHARS, DESIGN_SEED_PREFIX, DESIGN_BRIEF_PREFIX,
} = require('./designBrief.mts');
const { emptyDefinition } = require('../../../appStudio/componentSpecs');
const { APP_DESIGN_PRESETS, ALL_APP_DESIGN_PRESETS } = require('../../../appStudio/appDesignPresets');
const { applyToolCall } = require('../../../appStudio/builderTools');
const { buildSystemPrompt } = require('../../../appStudio/builderPrompt');

const draft = (appId = 'app_1') => ({ appId, builderSessionId: 'as_x', def: emptyDefinition('New') });
const FULL = { toolset: 'full' };
const CORE = { toolset: 'core' };

test('the seed is a pure function of the app id: the same app reads the same seed, apps differ', () => {
    assert.deepEqual(designSeed('app_1'), designSeed('app_1'));
    const ids = Array.from({ length: 40 }, (_, i) => `app_${i}`);
    const rendered = new Set(ids.map((id) => renderDesignSeed(designSeed(id))));
    assert.ok(rendered.size >= 35, `40 apps read ${rendered.size} different seeds`);
    const firstPresets = new Set(ids.map((id) => designSeed(id).presets[0]));
    assert.ok(firstPresets.size >= 8, `the first preset varies (${[...firstPresets].join(', ')})`);
    for (const id of ids) {
        const seed = designSeed(id);
        assert.strictEqual(new Set(seed.presets).size, 3);
        assert.ok(!seed.presets.includes('classic'), 'the untouched default is never the lean');
        for (const p of seed.presets) assert.ok(ALL_APP_DESIGN_PRESETS.some((x) => x.id === p));
    }
    // An app without an id yet is seeded from its session, so the turn before the first save is stable too.
    assert.strictEqual(designSeedNote({ appId: null, builderSessionId: 'as_9', def: emptyDefinition('x') }), designSeedNote({ appId: null, builderSessionId: 'as_9', def: emptyDefinition('y') }));
});

test('the small band is seeded from what its own catalogue lists', () => {
    const base = APP_DESIGN_PRESETS.map((p) => p.id);
    for (let i = 0; i < 40; i++) for (const p of designSeed(`app_${i}`, { core: true }).presets) assert.ok(base.includes(p), p);
    const note = designSeedNote(draft(), { core: true });
    assert.ok(note.startsWith(DESIGN_SEED_PREFIX));
    assert.ok(!note.includes('look "') && !note.includes('accent:'), 'no look vocabulary the compact catalogue may not carry');
});

test('the seed is offered only while the look is open', async () => {
    const d = draft();
    assert.ok(lookIsOpen(d, null));
    assert.match(designSeedNote(d), /lean this way, so this app does not look like the previous one: presets to consider first: [a-z]+, [a-z]+, [a-z]+; home screen: /);
    assert.match(designSeedNote(d), /What the user asks for, and a design they approved, always win over these\.$/);
    assert.strictEqual(designSeedNote(d, { approvedPlan: { design: { direction: 'x' } } }), null);
    assert.ok(designSeedNote(d, { approvedPlan: { title: 'no design' } }));
    await applyToolCall('app_set_theme', { preset: 'cloud' }, d);
    assert.strictEqual(designSeedNote(d), null, 'a chosen look ends it');
    const built = draft();
    await applyToolCall('app_add_components', { parentId: built.def.screens[0].sections[0].id, components: [{ type: 'heading', props: { text: 'Hi' } }] }, built);
    assert.strictEqual(designSeedNote(built), null, 'so does a draft that is no longer fresh');
    // The note is per-turn text: nothing of it is in the cached prompt.
    assert.ok(!buildSystemPrompt({ ownerContext: 'note' }).includes('presets to consider first'));
});

test('who gets a brief: a new app on a capable band, once, and only while it is switched on', () => {
    const base = { profile: FULL, draftWrap: draft(), approvedPlan: null, env: {} };
    assert.strictEqual(wantsDesignBrief(base), true);
    assert.strictEqual(wantsDesignBrief({ ...base, profile: CORE }), false);
    assert.strictEqual(wantsDesignBrief({ ...base, profile: null }), false);
    assert.strictEqual(wantsDesignBrief({ ...base, isApproval: true }), false);
    assert.strictEqual(wantsDesignBrief({ ...base, workMode: 'discuss' }), false);
    assert.strictEqual(wantsDesignBrief({ ...base, workMode: 'build' }), true);
    assert.strictEqual(wantsDesignBrief({ ...base, storedBrief: 'DIRECTION: x' }), false);
    assert.strictEqual(wantsDesignBrief({ ...base, approvedPlan: { design: { direction: 'x' } } }), false);
    assert.strictEqual(wantsDesignBrief({ ...base, env: { STUDIO_APP_DESIGN_BRIEF: 'OFF' } }), false);
});

test('the operator knobs: defaults, 0 = no time limit, nonsense falls back', () => {
    assert.deepEqual(designBriefSettings({}), { enabled: true, timeoutMs: 20000, temperature: 1 });
    assert.deepEqual(designBriefSettings({ STUDIO_APP_DESIGN_BRIEF_TIMEOUT_MS: '0', STUDIO_APP_DESIGN_BRIEF_TEMPERATURE: '1.4' }), { enabled: true, timeoutMs: 0, temperature: 1.4 });
    assert.deepEqual(designBriefSettings({ STUDIO_APP_DESIGN_BRIEF_TIMEOUT_MS: 'soon', STUDIO_APP_DESIGN_BRIEF_TEMPERATURE: '9' }), { enabled: true, timeoutMs: 20000, temperature: 1 });
});

test('the request names every preset and asks for the fixed form; the answer is capped', () => {
    const [system, user] = designBriefMessages(`Track repairs. ${'x'.repeat(5000)}`, 'presets to consider first: ember');
    for (const p of ALL_APP_DESIGN_PRESETS) assert.ok(system.content.includes(`${p.id} (`), p.id);
    assert.match(system.content, /DIRECTION: .*\nPRESET: .*\nPRIMARY: #rrggbb\nFONT: .*\nNAV: .*\nSURFACE: .*\nMOVES:/);
    assert.ok(user.content.length < 2200 && user.content.includes('presets to consider first: ember'));
    assert.strictEqual(cleanBrief('   '), null);
    assert.strictEqual(cleanBrief(null), null);
    assert.strictEqual(cleanBrief('y'.repeat(5000)).length, DESIGN_BRIEF_MAX_CHARS);
    assert.strictEqual(designBriefNote(''), null);
    assert.ok(designBriefNote(' DIRECTION: x ').startsWith(DESIGN_BRIEF_PREFIX) && designBriefNote(' DIRECTION: x ').endsWith('\nDIRECTION: x'));
});

test('the call: tool-less, warm, counted in the turn totals; a failure, an empty answer and a timeout all resolve to null', async () => {
    const seen = [];
    const ok = async (adapter, cfg, modelId, messages, options, opts) => {
        seen.push({ modelId, options, opts });
        return { content: ' DIRECTION: calm ', usage: { prompt_tokens: 30, completion_tokens: 12 } };
    };
    const totals = { inputTokens: 5, outputTokens: 5 };
    const args = { adapter: {}, cfg: { providerType: 'mock' }, modelId: 'm', ask: 'An app', seed: 's', userId: 'u1', usageTotals: totals, env: {} };
    assert.strictEqual(await requestDesignBrief({ ...args, stream: ok }), 'DIRECTION: calm');
    assert.deepEqual(seen[0].options, { maxTokens: 500, temperature: 1, reasoningEffort: 'none', userId: 'u1' });
    assert.strictEqual(seen[0].options.tools, undefined);
    assert.strictEqual(seen[0].opts.retries, 0);
    assert.deepEqual({ ...totals }, { inputTokens: 35, outputTokens: 17 });

    assert.strictEqual(await requestDesignBrief({ ...args, stream: async () => { throw new Error('boom'); } }), null);
    assert.strictEqual(await requestDesignBrief({ ...args, stream: async () => ({ content: null }) }), null);

    // A call that never answers: the timeout ends the wait and aborts the request.
    let aborted = false;
    const hang = (adapter, cfg, modelId, messages, options, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    const startedAt = Date.now();
    assert.strictEqual(await requestDesignBrief({ ...args, stream: hang, env: { STUDIO_APP_DESIGN_BRIEF_TIMEOUT_MS: '30' } }), null);
    assert.ok(aborted && Date.now() - startedAt < 2000);

    // A client that is already gone: no call at all.
    const gone = new AbortController();
    gone.abort();
    let called = false;
    assert.strictEqual(await requestDesignBrief({ ...args, signal: gone.signal, stream: async () => { called = true; return { content: 'x' }; } }), null);
    assert.strictEqual(called, false);
});

test('one turn: the seed then the brief, the stored brief instead of a second call, nothing for a decided look', async () => {
    let calls = 0;
    const stream = async () => { calls += 1; return { content: 'DIRECTION: calm' }; };
    const base = { approvedPlan: null, ask: 'An app', adapter: {}, cfg: {}, modelId: 'm', userId: 'u', usageTotals: {}, stream, env: {} };

    const d1 = draft();
    const first = await designNotesForTurn({ ...base, profile: FULL, draftWrap: d1 });
    assert.strictEqual(calls, 1);
    assert.ok(first[0].startsWith(DESIGN_SEED_PREFIX) && first[1].startsWith(DESIGN_BRIEF_PREFIX) && first.length === 2);
    assert.strictEqual(d1._designBrief, 'DIRECTION: calm');

    const d2 = draft();
    const again = await designNotesForTurn({ ...base, profile: FULL, draftWrap: d2, priorSnapshot: { designBrief: 'DIRECTION: stored' } });
    assert.strictEqual(calls, 1, 'no second call');
    assert.ok(again[1].endsWith('DIRECTION: stored'));
    assert.strictEqual(d2._designBrief, 'DIRECTION: stored', 'carried to the next snapshot');

    const small = await designNotesForTurn({ ...base, profile: CORE, draftWrap: draft() });
    assert.strictEqual(calls, 1);
    assert.strictEqual(small.length, 1);

    const approved = await designNotesForTurn({ ...base, profile: FULL, draftWrap: draft(), isApproval: true, approvedPlan: { design: { direction: 'x' } }, priorSnapshot: { designBrief: 'DIRECTION: stored' } });
    assert.deepEqual(approved, []);
    assert.strictEqual(calls, 1);
});

// ── The seams the route joins them at ────────────────────────────────

test('the turn prompt: the notes ride the ONE user message after the draft state, never the system prompt, and the build round keeps its tools', async () => {
    // No database: the three best-effort lookups the assembly makes are stubbed.
    require('../../../stores/configStore').getConfig = async () => null;
    require('../../../stores/automationStore').getAutomationsForUser = async () => [];
    require('../../../automation/builderDocumentCatalog').buildDocumentCatalogForUser = async () => [];
    const { assembleTurnPrompt } = require('./promptAssembly');
    const briefCalls = [];
    const stream = async (adapter, cfg, modelId, messages, options) => {
        briefCalls.push({ modelId, messages, options });
        return { content: 'DIRECTION: A warm field tool.', usage: { prompt_tokens: 40, completion_tokens: 60 } };
    };
    const usageTotals = { inputTokens: 0, outputTokens: 0 };
    const run = (modelId, draftWrap, extra = {}) => assembleTurnPrompt({
        send: () => {}, userId: 'u1', modelId, resolvedTier: 'smart', draftWrap, priorSnapshot: null, isApproval: false, planMode: 'auto',
        editorContext: null, inboundImages: [], modelSupportsVision: true, effectiveMessage: 'An app for our crew to report repairs',
        designNotes: ({ profile, approvedPlan }) => designNotesForTurn({
            profile, draftWrap, approvedPlan, ask: 'An app for our crew to report repairs', adapter: {}, cfg: {}, modelId, userId: 'u1', usageTotals, stream, env: {},
        }),
        ...extra,
    });

    const d = { ...draft(), userId: 'u1' };
    const turn = await run('claude-sonnet-5-5', d);
    assert.strictEqual(briefCalls.length, 1);
    assert.strictEqual(briefCalls[0].modelId, 'claude-sonnet-5-5', 'the same model as the build rounds');
    assert.strictEqual(briefCalls[0].options.tools, undefined);
    assert.ok(briefCalls[0].options.temperature > turn.profile.temperature, 'warmer than the profile, which is unchanged');
    assert.deepEqual({ ...usageTotals }, { inputTokens: 40, outputTokens: 60 });
    const user = turn.messages.at(-1).content;
    const at = (needle) => user.indexOf(needle);
    assert.ok(at('[DRAFT STATE') === 0 && at('[DRAFT STATE') < at(DESIGN_SEED_PREFIX) && at(DESIGN_SEED_PREFIX) < at(DESIGN_BRIEF_PREFIX) && at(DESIGN_BRIEF_PREFIX) < at('[OWNER CONTEXT'));
    assert.ok(user.includes('DIRECTION: A warm field tool.') && user.endsWith('An app for our crew to report repairs'));
    assert.ok(!turn.sys.includes(DESIGN_BRIEF_PREFIX) && !turn.sys.includes(DESIGN_SEED_PREFIX));
    assert.ok(turn.tools.length > 20);

    // Without the hook nothing is added: the turn is the turn it was.
    const plain = await run('claude-sonnet-5-5', { ...draft(), userId: 'u1' }, { designNotes: undefined });
    assert.ok(!plain.messages.at(-1).content.includes('[DESIGN'));
    assert.strictEqual(plain.sys, turn.sys, 'the cached prefix is the same with and without the notes');
    assert.strictEqual(JSON.stringify(plain.tools), JSON.stringify(turn.tools));

    // The small band: the seed only, and no model call.
    const small = await run('claude-haiku-4-5', { ...draft(), userId: 'u1' });
    assert.strictEqual(small.profile.toolset, 'core');
    assert.strictEqual(briefCalls.length, 1);
    assert.ok(small.messages.at(-1).content.includes(DESIGN_SEED_PREFIX) && !small.messages.at(-1).content.includes(DESIGN_BRIEF_PREFIX));
});

test('the snapshot keeps the brief until the build finalizes', async () => {
    const { persistTurnSnapshot } = require('./turnClosing');
    const studioAppStore = require('../../../stores/studioAppStore');
    const orig = studioAppStore.setBuilderSession;
    const snapshotOf = async (turn, draftExtra) => {
        let saved = null;
        studioAppStore.setBuilderSession = async (_a, _u, body) => { saved = body; return { ok: true }; };
        try {
            await persistTurnSnapshot(
                { lastFinalized: false, proposedPlan: null, reviewQuestions: null, lastValidation: null, ...turn },
                {
                    draftWrap: { appId: 'app_1', builderSessionId: 's1', def: { screens: [] }, _turnMessage: 'x', ...draftExtra }, userId: 'u1', history: [],
                    inboundImages: [], effectiveMessage: 'hi', proseParts: [], resolvedTier: 'smart', approvedPlanForTurn: null,
                    isApproval: false, priorSnapshot: null, continuation: null,
                },
            );
        } finally { studioAppStore.setBuilderSession = orig; }
        return saved;
    };
    assert.strictEqual((await snapshotOf({}, { _designBrief: 'DIRECTION: calm' })).designBrief, 'DIRECTION: calm');
    assert.ok(!('designBrief' in await snapshotOf({}, {})), 'a session without a brief has no key');
    assert.ok(!('designBrief' in await snapshotOf({}, { _designBrief: null })));
    assert.ok(!('designBrief' in await snapshotOf({ lastFinalized: true }, { _designBrief: 'DIRECTION: calm' })), 'a finalized build starts clean');
});
