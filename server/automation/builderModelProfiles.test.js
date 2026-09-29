/**
 * Unit tests for model-class banding used by the automation builder.
 *
 * Run: node automation/builderModelProfiles.test.js
 */

const assert = require('assert');
const {
    classifyModel, getProfile, getProfileForModel, effortForIteration, CORE_TOOL_NAMES,
    parseClaudeModel, rankModelCapability,
} = require('./builderModelProfiles');

// ── getProfileForModel + the `builder_model_profiles` override map ──
{
    assert.strictEqual(getProfileForModel('qwen3.8-27b'), getProfile('small'), 'no map → classification (27b is small)');
    assert.strictEqual(getProfileForModel('qwen3.8-27b', { 'qwen3.8-27b': 'frontier' }), getProfile('frontier'), 'a known band in the map wins');
    assert.strictEqual(getProfileForModel('qwen3.8-27b', { 'qwen3.8-27b': 'huge' }), getProfile('small'), 'an unknown band is ignored');
    assert.strictEqual(getProfileForModel('qwen3.8-27b', { 'other-model': 'frontier' }), getProfile('small'), 'an entry for another model is ignored');
    assert.strictEqual(getProfileForModel('qwen3.8-27b', 'frontier'), getProfile('small'), 'a non-object map is ignored');
    assert.strictEqual(getProfileForModel('qwen3.8-27b', ['frontier']), getProfile('small'), 'an array is ignored');
    assert.strictEqual(getProfileForModel(null, { null: 'frontier' }), getProfile('mid'), 'a missing id matches no map entry and classifies as mid like before');
}

// ── Small band (lean prompt, core toolset, filtered catalog) ──
for (const id of [
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'gpt-5-mini',
    'gemini-3.1-flash',
    'ministral-8b',
    'qwen2.5-3b',
    'mistral-small-latest',
    'lfm2.5-350m',
    'smollm2-135m',
]) {
    assert.strictEqual(classifyModel(id), 'small', `${id} should be small`);
}

// ── Mid band (default) ──
// Sonnet ≤4.6 stays mid; the legacy number-first Sonnet 3.5 id must NOT be
// caught by the sonnet-5 frontier pattern.
for (const id of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'gpt-4o', 'gpt-4.1', 'mistral-medium-latest']) {
    assert.strictEqual(classifyModel(id), 'mid', `${id} should be mid`);
}

// ── Frontier band — the CURRENT Claude landscape must not fall through ──
for (const id of [
    'claude-opus-5',                // Claude 5 family
    'claude-sonnet-5',              // Claude 5 family — near previous-Opus tier
    'claude-sonnet-5-20260115',     // date-suffixed variant
    'anthropic.claude-sonnet-5',    // Bedrock-prefixed id
    'claude-opus-4-8',
    'claude-fable-5',
    'claude-mythos-5',
    'mistral-large-latest',
]) {
    assert.strictEqual(classifyModel(id), 'frontier', `${id} should be frontier`);
}

// ── Reasoning overlay (thinking/magistral) ──
for (const id of ['magistral-medium', 'some-thinking-model']) {
    assert.strictEqual(classifyModel(id), 'reasoning', `${id} should be reasoning`);
}

// ── Empty / unknown falls back to mid ──
assert.strictEqual(classifyModel(''), 'mid', 'empty id → mid');
assert.strictEqual(classifyModel(null), 'mid', 'null id → mid');

// ── parseClaudeModel: name-first ids only, date suffixes ignored ──
assert.deepStrictEqual(parseClaudeModel('claude-opus-5'), { family: 'opus', generation: 5 });
assert.deepStrictEqual(parseClaudeModel('claude-sonnet-5-20260115'), { family: 'sonnet', generation: 5 }, 'date suffix is not a minor version');
assert.deepStrictEqual(parseClaudeModel('claude-opus-4-8'), { family: 'opus', generation: 4.8 });
assert.deepStrictEqual(parseClaudeModel('claude-haiku-4-5-20251001'), { family: 'haiku', generation: 4.5 });
assert.deepStrictEqual(parseClaudeModel('anthropic.claude-sonnet-5'), { family: 'sonnet', generation: 5 }, 'Bedrock prefix tolerated');
assert.strictEqual(parseClaudeModel('claude-3-5-sonnet-20241022'), null, 'legacy number-first id → null');
assert.strictEqual(parseClaudeModel('gpt-4o'), null);
assert.strictEqual(parseClaudeModel(null), null);

// ── rankModelCapability: band dominates; Claude newest-generation on top ──
{
    const order = [
        'claude-fable-5',       // frontier + top family
        'claude-opus-5',        // frontier, gen 5, opus
        'claude-sonnet-5',      // frontier, gen 5, sonnet
        'claude-opus-4-8',      // frontier, gen 4.8 — newest generation outranks it
        'gpt-5-pro',            // frontier, non-Claude
        'claude-sonnet-4-6',    // mid
        'gpt-4o',               // mid, non-Claude
        'claude-haiku-4-5',     // small
    ];
    for (let i = 1; i < order.length; i++) {
        assert.ok(
            rankModelCapability(order[i - 1]) > rankModelCapability(order[i]),
            `${order[i - 1]} must outrank ${order[i]}`,
        );
    }
    // Deterministic: same id, same score.
    assert.strictEqual(rankModelCapability('claude-sonnet-5'), rankModelCapability('claude-sonnet-5'));
}

// ── Effort schedule + schema-injection flags per profile (WS7/WS8) ──
for (const band of ['frontier', 'mid', 'reasoning']) {
    const p = getProfile(band);
    assert.deepStrictEqual(p.effortSchedule, { first: 'medium', rest: 'low', repair: 'medium' }, `${band} effort schedule`);
    assert.strictEqual(p.schemaInjection, true, `${band} gets upfront schema injection`);
}
{
    const small = getProfile('small');
    // Thinking OFF on every round for the small band — NOT a no-op, and not a
    // level. A level here is thinking ON for a self-hosted runtime, which also
    // lifts the temperature this band sets for stable tool-call JSON
    // (providers/local.js floors a thinking request at 0.6, over the 0.4 chosen
    // here). Measured 2026-09-16 on Gemma 4 26B-A4B: 4.1 s a round with thinking
    // off against 18.4 s with 'low', a valid tool call 3/3 either way.
    assert.deepStrictEqual(small.effortSchedule, { first: 'none', rest: 'none', repair: 'none' }, 'small band never thinks');
    assert.strictEqual(small.schemaInjection, false, 'small keeps the pure inspect-gate path');
}

// ── effortForIteration: first / rest / repair-bounce ──
{
    const p = getProfile('frontier');
    assert.strictEqual(effortForIteration(0, false, p), 'medium', 'iteration 0 → first');
    assert.strictEqual(effortForIteration(0, true, p), 'medium', 'iteration 0 wins over escalate');
    assert.strictEqual(effortForIteration(3, false, p), 'low', 'continuation → rest');
    assert.strictEqual(effortForIteration(3, true, p), 'medium', 'failure signal → repair');
    assert.strictEqual(effortForIteration(2, false, {}), 'low', 'missing schedule → sane defaults');
    // The tier's explicit "no thinking" wins over the schedule on EVERY round
    // (demo box: Fast tier = 'none' on a Qwen3.6 that llama.cpp otherwise
    // lets think for 8192 tokens). Any other tier level leaves it alone.
    assert.strictEqual(effortForIteration(0, false, p, 'none'), 'none', 'tier none → first round none');
    assert.strictEqual(effortForIteration(3, true, p, 'none'), 'none', 'tier none → repair round none');
    assert.strictEqual(effortForIteration(0, false, p, 'low'), 'medium', 'a tier level other than none does not override the schedule');
    assert.strictEqual(effortForIteration(3, true, p, 'high'), 'medium', 'nor on repair rounds');
    assert.strictEqual(effortForIteration(0, false, p, undefined), 'medium', 'custom tiers store None as undefined → schedule');
}

// ── CORE_TOOL_NAMES regression lock ──
assert.deepStrictEqual([...CORE_TOOL_NAMES].sort(), [
    'builder_add_action', 'builder_add_ai_step', 'builder_add_approval', 'builder_add_array_op',
    'builder_add_condition', 'builder_add_data_extraction', 'builder_add_datatable', 'builder_add_http_request', 'builder_add_loop',
    'builder_add_notification', 'builder_add_steps', 'builder_create_datatable', 'builder_finalize',
    'builder_inspect_tool', 'builder_propose_trigger', 'builder_read_document', 'builder_remove_step', 'builder_replace_step', 'builder_request_dry_run', 'builder_search_documents', 'builder_set_metadata',
    'builder_set_plan', 'builder_summarise', 'builder_update_step',
    'builder_update_steps', 'builder_wire_error_branch',
], 'CORE_TOOL_NAMES frozen. The lock guards the SHAPE of the small-model menu, not its '
 + 'size. Added 2026-09-17: builder_add_datatable — builder_create_datatable\'s own schema text '
 + 'and _next hint tell the model to write rows with it, and the hint pointed off-menu: the small '
 + 'model followed it into unknown_tool refusals. Same day, same class: builder_add_approval — the '
 + 'approvals playbook phase\'s brief and builder_propose_trigger\'s catalog both name it. '
 + 'Added 2026-09-14: builder_create_datatable — asked for "a new table called invoice" the '
 + 'small model invented a create-table STEP every round; the menu could write into a table but '
 + 'not make one. '
 + 'size. Added 2026-09: builder_add_http_request (without it a model asked to fetch a '
 + 'URL invented builder_add_action({tool:"http_request"}), which no runtime can '
 + 'dispatch) and builder_wire_error_branch (without it "if X fails" was modelled as a '
 + 'condition fork). Added 2026-09-11, REVERSING the earlier serial-protocol rule: '
 + 'builder_set_plan, builder_add_steps and builder_update_steps. The serial rule cost a '
 + 'round per step and a round per inspected tool, and a measured build on the demo box '
 + 'burned all 24 iterations without converging. builder_add_steps applies entries in '
 + 'order, keeps the built prefix on a bad entry and never builds a resent entry twice, so '
 + 'it is SAFER under truncation than the several-calls-per-reply alternative, which '
 + 'leaves earlier calls applied and lets a full resend duplicate them.');

// ── Schema variant + catalog placement per band (2026-09-17) ──
// Band-owned, never overridable through builder_model_profiles: the lean
// projection (builderTools/schemaProjection.js) and the lean prompt teach one
// menu, and a per-model tweak could pair a prompt with a menu it never taught.
{
    const small = getProfile('small');
    assert.strictEqual(small.schemaVariant, 'lean', 'small reads the lean projection');
    assert.strictEqual(small.catalogPlacement, 'dynamic', 'small keeps the per-user blocks out of the system prompt');
    for (const band of ['frontier', 'mid', 'reasoning']) {
        assert.strictEqual(getProfile(band).schemaVariant, 'full', `${band} reads the full schemas`);
        assert.strictEqual(getProfile(band).catalogPlacement, 'system', `${band} keeps the catalog in system[0]`);
    }
    const tweaked = getProfileForModel('gemma-4-26b-a4b', { 'gemma-4-26b-a4b': { band: 'small', temperature: 0.7, schemaVariant: 'full', catalogPlacement: 'system' } });
    assert.strictEqual(tweaked.temperature, 0.7, 'the temperature knob applies');
    assert.strictEqual(tweaked.schemaVariant, 'lean', 'schemaVariant is not an override knob');
    assert.strictEqual(tweaked.catalogPlacement, 'dynamic', 'catalogPlacement is not an override knob');
}

// ── Prefix-cache posture per band (2026-09-11) ──
// The small band is the single-slot local box: its few-shots are cached after
// turn 1 and must stay in the prompt every turn or the whole prefix after them
// is re-read. Cloud bands pay per token and keep first-turn-only.
{
    assert.strictEqual(getProfile('small').fewShotPolicy, 'every-turn', 'small keeps the few-shots in the cached prefix');
    assert.strictEqual(getProfile('small').historyBudgetTokens, 6000, 'small history budget');
    for (const band of ['frontier', 'mid', 'reasoning']) {
        assert.strictEqual(getProfile(band).fewShotPolicy, 'first-turn', `${band} few-shots on the first turn only`);
        assert.strictEqual(getProfile(band).historyBudgetTokens, 8000, `${band} history budget`);
    }
}

// The small profile drives the batch protocol off its own flag now, not off toolset.
{
    const small = getProfile('small');
    assert.strictEqual(small.batchTools, true, 'small profile opts into the batch protocol');
    assert.strictEqual(small.temperature, 0.4, 'small runs above the near-greedy repetition regime');
    assert.ok(CORE_TOOL_NAMES.has('builder_add_steps'), 'the batch add tool is reachable from core');
}

console.log('builderModelProfiles.test.js: all classifyModel tests passed');

// ── Per-model overrides, OBJECT form ──
// The string form picks a band. The object form picks a band AND tunes a few
// numbers, which is how a family whose sampling differs from its size class
// gets fixed without a release: Gemma 4 loops at the 'small' band's 0.4,
// because llama.cpp runs it with the repetition penalty disabled.
{
    const tuned = getProfileForModel('gemma-4-26b-a4b', {
        'gemma-4-26b-a4b': { band: 'small', temperature: 0.7, maxIterations: 20, toolset: 'full' },
    });
    assert.strictEqual(tuned.temperature, 0.7, 'temperature is overridable');
    assert.strictEqual(tuned.maxIterations, 20, 'maxIterations is overridable');
    assert.strictEqual(tuned.toolset, getProfile('small').toolset, 'the toolset is the band\'s, never the map\'s');
    assert.strictEqual(tuned.promptVariant, getProfile('small').promptVariant, 'the prompt variant is the band\'s');

    const ownBand = getProfileForModel('gemma-4-26b-a4b', { 'gemma-4-26b-a4b': { temperature: 0.9 } });
    assert.strictEqual(ownBand.temperature, 0.9, 'no band named → tune the classified band');
    assert.strictEqual(ownBand.toolset, getProfile(classifyModel('gemma-4-26b-a4b')).toolset);

    const junk = getProfileForModel('gemma-4-26b-a4b', { 'gemma-4-26b-a4b': { temperature: 'hot', fewShots: -1 } });
    assert.strictEqual(junk, getProfile(classifyModel('gemma-4-26b-a4b')), 'unusable values change nothing at all');

    assert.strictEqual(getProfileForModel('gemma-4-26b-a4b', { 'gemma-4-26b-a4b': 'mid' }), getProfile('mid'),
        'the string form still selects a whole band');
}
