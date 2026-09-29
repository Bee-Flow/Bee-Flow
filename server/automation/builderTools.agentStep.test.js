/**
 * The AI builder's agent-and-skills fields on an `ai_step` (R2 deel A).
 *
 * The three that are safety rather than tidiness:
 *   - `agentPermissions` ABSENT means all three off. That is deliberately the
 *     opposite of the grants map in core/agentRuntime/toolPolicy.js, where a
 *     missing app entry means "every action of this app" — that reading exists
 *     to keep agents a toolbelt they already had, and an ai_step bound to an
 *     agent has no such history to preserve;
 *   - a PARTIAL permissions patch never leaves a key `undefined`. The object is
 *     rebuilt from its three known names, because `undefined` is what a reader
 *     written as `!== false` turns into a yes;
 *   - re-pointing a step at a DIFFERENT agent is not a patch. That is the field
 *     both checks look at (validate/stepRules at save, execAi at run time), and
 *     a patch is the one path that could move it without the step being rebuilt.
 *
 * Run: cd server && node --test automation/builderTools.agentStep.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { TOOL_SCHEMAS } = require('./builderTools/schemas');
const {
    applyAddAi, sanitizeAgentId, sanitizeSkillIds, sanitizeAgentPermissions,
} = require('./builderTools/stepBuilders');
const { applyUpdateStep } = require('./builderTools/stepEditing');
const { AI_STEP_AGENT_PERMISSION_KEYS, MAX_AI_STEP_SKILL_IDS } = require('./validate/constants');

const draft = () => ({ trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] });
const aiTool = () => TOOL_SCHEMAS.find(x => x.function.name === 'builder_add_ai_step');

// ── the tool surface ────────────────────────────────────────────────────────

test('the ai_step tool offers all three fields', () => {
    const props = aiTool().function.parameters.properties;
    assert.ok(props.agentId, 'agentId');
    assert.ok(props.skillIds, 'skillIds');
    assert.ok(props.agentPermissions, 'agentPermissions');
});

test('the permissions object declares exactly the three keys the runtime reads', () => {
    // A fourth key here would be storable and inert — the shape this codebase
    // refuses everywhere: the author reads it back and believes it.
    const declared = Object.keys(aiTool().function.parameters.properties.agentPermissions.properties);
    assert.deepStrictEqual(declared.sort(), [...AI_STEP_AGENT_PERMISSION_KEYS].sort());
});

test('the description tells the model an omitted permission is OFF, not "everything"', () => {
    // The one instruction that stops it writing `{startAutomations:true}` and
    // assuming the other two came along.
    const d = aiTool().function.parameters.properties.agentPermissions.description;
    assert.match(d, /leave out is FALSE/i);
    assert.match(d, /no knowledge bases, no tools/i);
});

test('the description tells the model it cannot invent an agent id, and that it learns nothing from the refusal', () => {
    const d = aiTool().function.parameters.properties.agentId.description;
    assert.match(d, /[Nn]ever invent one/);
    assert.match(d, /SAME refusal/);
});

test('the skills field says the first one leads', () => {
    assert.match(aiTool().function.parameters.properties.skillIds.description, /first one is the leading skill/i);
});

test('builder_update_step advertises agentId as fill-only', () => {
    const upd = TOOL_SCHEMAS.find(x => x.function.name === 'builder_update_step');
    const keys = upd.function.parameters.properties.patch.description;
    assert.match(keys, /skillIds, agentPermissions/);
    assert.match(keys, /agentId ONLY on a step that has none yet/);
});

// ── building ────────────────────────────────────────────────────────────────

test('a plain ai_step states agentId and skillIds, and carries NO permission block', () => {
    // agentId and skillIds keep the knowledgeBaseIds discipline: explicit, so
    // the runner never has to tell "not set" from "cleared".
    //
    // agentPermissions does NOT, and this is the corrected half. The block used
    // to be written on every step, so every plain AI step the builder produced
    // carried `{false,false,false}` — which validate/stepRules then flagged,
    // correctly and permanently, as `ai_step.agent_permissions_orphan`: "sets
    // agent permissions but names no agent, so nothing reads them". Nothing the
    // user did cleared it, because the user never set the field. Absence means
    // all three false (validate/constants R2), so leaving it out says exactly
    // what the object said. The invariant it was protecting is about a step
    // BOUND to an agent, and the test below still holds it there.
    const { added } = applyAddAi(draft(), { prompt: 'summarise this' });
    assert.strictEqual(added.agentId, null);
    assert.deepStrictEqual(added.skillIds, []);
    assert.ok(!('agentPermissions' in added), 'no agent, so no permission block');
});

test('permissions asked for WITHOUT an agent are refused, not silently dropped', () => {
    // Dropping would be the wrong kindness: the model meant the step to be able
    // to do something, and it would quietly not be able to.
    const r = applyAddAi(draft(), { prompt: 'p', agentPermissions: { useTools: true } });
    assert.ok(r.error, 'refused');
    assert.match(r.error, /names no agent/);
    assert.match(r.error, /useTools/);
    assert.ok(r._fixHint, 'carries its own hint — applyToolCall stamps a binding hint otherwise');
    assert.equal(r.added, undefined);
});

test('an all-false permission object without an agent is simply left out', () => {
    // Nothing was granted, so there is nothing to refuse — and nothing to store.
    const { added } = applyAddAi(draft(), {
        prompt: 'p',
        agentPermissions: { startAutomations: false, useKnowledge: false, useTools: false },
    });
    assert.ok(!('agentPermissions' in added));
});

test('a step bound to an agent stores the id and the permissions asked for', () => {
    const { added } = applyAddAi(draft(), {
        prompt: 'p', agentId: '  agt_1  ', skillIds: ['sk_a', 'sk_b'],
        agentPermissions: { useKnowledge: true },
    });
    assert.strictEqual(added.agentId, 'agt_1', 'trimmed');
    assert.deepStrictEqual(added.skillIds, ['sk_a', 'sk_b']);
    assert.deepStrictEqual(added.agentPermissions, {
        startAutomations: false, useKnowledge: true, useTools: false,
    });
});

test('an omitted permission is FALSE — never inherited, never "everything"', () => {
    for (const perms of [undefined, null, {}, [], 'all', { nope: true }]) {
        assert.deepStrictEqual(sanitizeAgentPermissions(perms), {
            startAutomations: false, useKnowledge: false, useTools: false,
        }, JSON.stringify(perms) ?? 'undefined');
    }
});

test('only a real boolean true grants — a value nobody can read is not a yes', () => {
    // `"false"`, `1` and `"no"` are all truthy or all convertible; coercing any
    // of them is the widest answer to the least readable input.
    for (const v of ['true', 'false', 1, 'yes', {}, [], 'on']) {
        assert.strictEqual(sanitizeAgentPermissions({ useTools: v }).useTools, false, JSON.stringify(v));
    }
    assert.strictEqual(sanitizeAgentPermissions({ useTools: true }).useTools, true);
});

test('unknown permission keys are dropped, not stored', () => {
    const out = sanitizeAgentPermissions({ useTools: true, useEverything: true, admin: true });
    assert.deepStrictEqual(Object.keys(out).sort(), [...AI_STEP_AGENT_PERMISSION_KEYS].sort());
});

test('skills keep the author\'s order — the first is the leading one', () => {
    assert.deepStrictEqual(sanitizeSkillIds(['sk_z', 'sk_a', 'sk_m']), ['sk_z', 'sk_a', 'sk_m']);
});

test('skills are trimmed, deduped and capped at what the runtime actually uses', () => {
    const many = Array.from({ length: MAX_AI_STEP_SKILL_IDS + 3 }, (_, i) => `sk_${i}`);
    assert.strictEqual(sanitizeSkillIds(many).length, MAX_AI_STEP_SKILL_IDS);
    assert.deepStrictEqual(sanitizeSkillIds([' sk_a ', 'sk_a', 7, null, 'sk_b']), ['sk_a', 'sk_b']);
    assert.deepStrictEqual(sanitizeSkillIds('sk_a'), [], 'a bare string is not a list');
});

test('a blank agent id is null, not an empty string', () => {
    for (const v of ['', '   ', null, undefined, 7, {}]) assert.strictEqual(sanitizeAgentId(v), null, JSON.stringify(v));
    assert.strictEqual(sanitizeAgentId(' agt_9 '), 'agt_9');
});

// ── patching ────────────────────────────────────────────────────────────────

/** applyUpdateStep patches the GRAPH in place; it takes no wrapper. */
function graphWith(step) {
    return { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [step], edges: [{ from: 'trg', to: step.id }] };
}
const agentStep = (over = {}) => ({
    id: 'ai1', type: 'ai_step', prompt: 'p', agentId: 'agt_1', skillIds: ['sk_a'],
    agentPermissions: { startAutomations: false, useKnowledge: true, useTools: false }, ...over,
});

test('skills and permissions are ordinary patches', () => {
    const g = graphWith(agentStep());
    const res = applyUpdateStep(g, { stepId: 'ai1', patch: { skillIds: ['sk_b'], agentPermissions: { useTools: true } } });
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(g.steps[0].skillIds, ['sk_b']);
    assert.deepStrictEqual(g.steps[0].agentPermissions, {
        startAutomations: false, useKnowledge: false, useTools: true,
    });
});

test('a PARTIAL permissions patch leaves no key undefined', () => {
    // The half that actually bites: merged into the stored object,
    // `{useTools:true}` would leave useKnowledge as `undefined`, and the first
    // reader written as `!== false` reads that as yes. Rebuilt, never merged.
    const g = graphWith(agentStep());
    applyUpdateStep(g, { stepId: 'ai1', patch: { agentPermissions: { useTools: true } } });
    const perms = g.steps[0].agentPermissions;
    for (const key of AI_STEP_AGENT_PERMISSION_KEYS) {
        assert.strictEqual(typeof perms[key], 'boolean', `${key} is a real boolean`);
    }
    assert.strictEqual(perms.useKnowledge, false, 'the key the patch did not mention is OFF, not carried over');
});

test('a permissions patch nobody can read grants nothing', () => {
    const g = graphWith(agentStep());
    applyUpdateStep(g, { stepId: 'ai1', patch: { agentPermissions: 'all' } });
    assert.deepStrictEqual(g.steps[0].agentPermissions, {
        startAutomations: false, useKnowledge: false, useTools: false,
    });
});

test('a patch may FILL a blank agent — that is how an import is repaired', () => {
    const g = graphWith(agentStep({ agentId: null }));
    const res = applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: 'agt_7' } });
    assert.ok(!res.error, res.error);
    assert.strictEqual(g.steps[0].agentId, 'agt_7');
});

test('a patch may NOT re-point a step at a different agent', () => {
    const g = graphWith(agentStep());
    const res = applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: 'agt_other' } });
    assert.match(res.error || '', /builder_replace_step/);
    assert.strictEqual(g.steps[0].agentId, 'agt_1', 'and nothing moved');
});

test('a patch may not silently UNBIND an agent either', () => {
    // Same act, other direction: the step stops running on the agent it says
    // it runs on, without the check that put it there running again.
    const g = graphWith(agentStep());
    const res = applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: null } });
    assert.match(res.error || '', /builder_replace_step/);
    assert.strictEqual(g.steps[0].agentId, 'agt_1');
});

test('a patched step is byte-identical to a freshly built one', () => {
    const built = applyAddAi(draft(), {
        prompt: 'p', agentId: 'agt_1', skillIds: ['sk_a'], agentPermissions: { useKnowledge: true },
    }).added;
    const g = graphWith({ id: 'ai1', type: 'ai_step', prompt: 'p' });
    applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: 'agt_1', skillIds: ['sk_a'], agentPermissions: { useKnowledge: true } } });
    const patched = g.steps[0];
    assert.strictEqual(patched.agentId, built.agentId);
    assert.deepStrictEqual(patched.skillIds, built.skillIds);
    assert.deepStrictEqual(patched.agentPermissions, built.agentPermissions);
});

// ── the patch gate is a SANITIZER, not a pass-through ───────────────────────
//
// "byte-identical built vs patched" proves nothing while every test feeds the
// gate values that were already clean ('agt_1', ['sk_a']). The clamps only
// earn their keep on input nobody cleaned, so that is what these feed them.

test('a patched agent id is trimmed, and a blank one becomes null', () => {
    const g = graphWith(agentStep({ agentId: null }));
    applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: '   agt_9  ' } });
    assert.strictEqual(g.steps[0].agentId, 'agt_9');

    const g2 = graphWith(agentStep({ agentId: null }));
    applyUpdateStep(g2, { stepId: 'ai1', patch: { agentId: '   ' } });
    assert.strictEqual(g2.steps[0].agentId, null, 'a blank id is no id — never an empty string');

    const g3 = graphWith(agentStep({ agentId: null }));
    applyUpdateStep(g3, { stepId: 'ai1', patch: { agentId: { id: 'agt_9' } } });
    assert.strictEqual(g3.steps[0].agentId, null, 'a shape nobody can read is not an id');
});

test('a patched skill list is trimmed, deduped and CAPPED at what the runtime uses', () => {
    // Without the clamp on this path, `builder_update_step({patch:{skillIds:
    // [...8 ids...]}})` wrote an unclamped list: the author is told nothing and
    // mergeSkillIds silently drops everything past the cap at run time.
    const many = Array.from({ length: MAX_AI_STEP_SKILL_IDS + 3 }, (_, i) => `sk_${i}`);
    const g = graphWith(agentStep());
    applyUpdateStep(g, { stepId: 'ai1', patch: { skillIds: ['  sk_a  ', 'sk_a', '', 42, ...many] } });
    const stored = g.steps[0].skillIds;
    assert.strictEqual(stored.length, MAX_AI_STEP_SKILL_IDS, 'capped');
    assert.deepStrictEqual(stored.slice(0, 2), ['sk_a', 'sk_0'], 'trimmed, deduped, order kept');
    assert.strictEqual(new Set(stored).size, stored.length, 'no repeats survive');
});

test('a skill list that is not a list clears it rather than storing junk', () => {
    const g = graphWith(agentStep());
    applyUpdateStep(g, { stepId: 'ai1', patch: { skillIds: 'sk_a' } });
    assert.deepStrictEqual(g.steps[0].skillIds, []);
});

test('a DIRTY patch still lands byte-identical to a freshly built step', () => {
    // The real form of the "built vs patched" claim: same messy input on both
    // paths, same stored row. Clean input on both sides proves only that two
    // pass-throughs agree.
    const messy = { agentId: '  agt_1  ', skillIds: ['  sk_a  ', 'sk_a', 'sk_b'], agentPermissions: { useKnowledge: 'yes', useTools: true } };
    const built = applyAddAi(draft(), { prompt: 'p', ...messy }).added;
    const g = graphWith({ id: 'ai1', type: 'ai_step', prompt: 'p' });
    applyUpdateStep(g, { stepId: 'ai1', patch: { ...messy } });
    assert.strictEqual(g.steps[0].agentId, built.agentId);
    assert.deepStrictEqual(g.steps[0].skillIds, built.skillIds);
    assert.deepStrictEqual(g.steps[0].agentPermissions, built.agentPermissions);
    assert.strictEqual(built.agentPermissions.useKnowledge, false, "'yes' is not a boolean, and not a grant");
});

test('inside a LOOP BODY the agent can be re-pointed, because replace cannot reach it', () => {
    // `builder_replace_step` refuses a loop-body step outright ("patch it with
    // builder_update_step"), so the two refusals used to point at each other:
    // the agent of a looped ai_step could not be changed at all, only by
    // deleting the step — which mints a new id and breaks every downstream ref.
    // The re-point is checked all the same: persistDraft builds the agent
    // catalog and hands it to validateDefinition on every builder save.
    const loop = { id: 'lp1', type: 'loop', overRef: '{{steps.a.output.items}}', body: [agentStep()] };
    const g = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [loop], edges: [] };
    const res = applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: 'agt_other' } });
    assert.ok(!res.error, res.error);
    assert.strictEqual(g.steps[0].body[0].agentId, 'agt_other');
});

test('outside a loop the fill-only rule still holds, and names the path that IS checked', () => {
    const g = graphWith(agentStep());
    const res = applyUpdateStep(g, { stepId: 'ai1', patch: { agentId: 'agt_other' } });
    assert.match(res.error || '', /builder_replace_step/);
    assert.match(res.error || '', /permission check runs on it/);
});
