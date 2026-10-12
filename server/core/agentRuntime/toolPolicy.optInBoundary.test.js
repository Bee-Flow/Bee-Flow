/**
 * The opt-in boundary, stated once and in full.
 *
 * Every other file here tests a piece of the grants layer. This one tests the
 * PROMISE the layer was allowed to ship on: an agent with no `config.tools` —
 * which is every agent that existed before it landed — behaves exactly as it
 * did before. Not "mostly", not "except headless": the same tools, in the same
 * order, with nothing held back, and the same answer for a name the model
 * invents.
 *
 * Three shapes are the same nothing and are asserted together, because two of
 * them are reachable by accident and the third is what the clamp WRITES:
 *
 *   no `tools` key at all   every agent from before the picker;
 *   `tools: {}`             what `_clampRuntimeTools` and `applyConfigValidation`
 *                           store once a refused section was all a map held;
 *   `tools: {gmail:'nope'}` one bad PUT, one MCP patch, one restored snapshot.
 *
 * If any of them ever diverges, the layer has stopped being invisible and the
 * divergence is a behaviour change nobody asked for — which is the one thing
 * this design said it would never do.
 *
 * Registry-independence is asserted as an EQUALITY, not as an absence: the
 * index is still built (confirmForTool asks which app owns a write before it
 * discovers there is no map to consult), but nothing it answers — or fails to
 * answer — may change a single verdict for an agent nobody curated.
 *
 * Run: node --test --test-force-exit core/agentRuntime/toolPolicy.optInBoundary.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..');

// ── Stub the tool registry, exactly as toolPolicy.test.js does ───────
// A shape, not this week's integration list. `REGISTRY_BROKEN` throws from the
// getter `_buildAppIndex` reads, which is the registry hiccup the runtime has
// to survive.
const registryPath = require.resolve(path.join(SERVER, 'automation/toolRegistry'));
let REGISTRY_BROKEN = false;
require.cache[registryPath] = {
    id: registryPath, filename: registryPath, loaded: true,
    exports: {
        get TOOL_REGISTRY() {
            if (REGISTRY_BROKEN) throw new Error('tool registry unavailable');
            return [{ app: 'gmail' }, { app: 'google-drive' }];
        },
        INLINE_TOOL_APPS: [],
        // De lijst die de attributie-index leest: registry PLUS de apps die
        // hun tools inline injecteren (A2-1, automation/toolRegistry.js).
        get ALL_TOOL_APPS() {
            if (REGISTRY_BROKEN) throw new Error('tool registry unavailable');
            return [{ app: 'gmail' }, { app: 'google-drive' }];
        },
        loadTools: (entry) => OPT_IN_TOOLS[entry.app] || [],
        // Zoals de echte bron: de storing komt als WAARDE terug, niet als throw.
        loadToolsResult: (entry) => ({ tools: OPT_IN_TOOLS[entry.app] || [], ok: true, reason: null }),
    },
};

const OPT_IN_TOOLS = {
    gmail: [
        { function: { name: 'gmail_search' } },
        { function: { name: 'gmail_compose' } },
    ],
    'google-drive': [
        { function: { name: 'drive_search' } },
        { function: { name: 'drive_upload_file' } },
    ],
};

// Lending resolves through this module; keep it inert and cheap.
const crPath = require.resolve(path.join(SERVER, 'core/integrations/connectionResolution'));
require.cache[crPath] = {
    id: crPath, filename: crPath, loaded: true,
    exports: { isLendingEnabled: () => false, providerForTool: () => 'google' },
};

const P = require('./toolPolicy');
const { effectOf } = require('../../automation/sideEffectMap');

// ── The stack a pre-A1b agent is handed ─────────────────────────────
// Deliberately mixed: a read, a SEND (the one tool the confirm layer would
// reach for), a write, an automation of the person asking, and a builtin the
// registry knows nothing about. Order is part of what is asserted — the model
// sees this array, and a reordering is a different prompt.
const fn = (name, extra = {}) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
    ...extra,
});
const STACK = [
    fn('gmail_search'),
    fn('gmail_compose'),
    fn('drive_upload_file'),
    fn('automation_send_invoice', { __automation: { id: 'auto-1', userId: 'u1' } }),
    fn('set_reminder'),
];
const NAMES = STACK.map(t => t.function.name);

// The three configs that all mean "nobody has curated this agent".
const UNCURATED = {
    'no tools key': { enabledIntegrations: ['gmail'] },
    'an empty map': { enabledIntegrations: ['gmail'], tools: {} },
    'a junk-only map': { enabledIntegrations: ['gmail'], tools: { gmail: 'nope' } },
};

/**
 * Everything the runtime reads off a policy, flattened so one assertion can
 * compare two whole verdicts instead of six fields at a time.
 */
function verdict(agentConfig, { unattended = false, build = P.buildToolPolicy } = {}) {
    const automationConfirms = P.automationConfirmsFor(STACK, agentConfig);
    const policy = build({ agentConfig, tools: STACK, unattended, automationConfirms });
    return {
        offered: [...policy.allowedToolNames],
        confirm: [...policy.confirmByTool],
        effect: [...policy.effectByTool],
        gated: [...policy.gatedTools],
        dropped: [...policy.droppedForUnattended],
        enforceNames: policy.enforceNames,
        overrides: [...automationConfirms],
        decisions: [...NAMES, 'automation_pay_invoice'].map(n => {
            const d = P.decideToolCall({ toolName: n, policy });
            return [n, d.action, d.reason, d.confirm];
        }),
        lending: NAMES.map(n => [n, P.mayLendOwnerConnection(n, agentConfig)]),
        offeredByGrant: NAMES.map(n => [n, P.isToolAllowed(n, P.toolsConfigOf(agentConfig))]),
    };
}

test('an uncurated agent gets its whole stack, in order, with nothing held back', () => {
    for (const [label, config] of Object.entries(UNCURATED)) {
        const v = verdict(config);

        assert.deepStrictEqual(v.offered, NAMES,
            `${label}: same tools and same ORDER — the model sees this array, so a reshuffle is a ` +
            'different prompt, not a smaller one');
        assert.deepStrictEqual(v.gated, [],
            `${label}: nothing is held back. gmail_compose still answers with its own draft card, ` +
            'which is what the product did before any of this existed');
        assert.strictEqual(v.enforceNames, false, `${label}: the name gate is not armed either`);
        assert.deepStrictEqual(v.offeredByGrant, NAMES.map(n => [n, true]),
            `${label}: and no per-action grant subtracts anything on the way in`);
        // Lenen blijft precies zoals het was — met ÉÉN bodem eronder, en die
        // is geen curatie-vraag: een tool die VERSTUURT leent nooit de
        // verbinding van de eigenaar. Dat verbod stond al in
        // `normaliseToolsConfig` ("a borrowed connection never sends without
        // its owner present") en op de Tools-kaart, maar gold alleen op de
        // gecureerde tak — terwijl juist hier, op de agent die niemand
        // cureerde, de mail van de eigenaar de deur uit kon gaan onder zijn
        // naam, gestuurd door een ander. Niemand kan dat aanvinken.
        assert.deepStrictEqual(v.lending, NAMES.map(n => [n, effectOf(n) !== 'sends']),
            `${label}: lending is exactly as it was, behalve dat een verzendende tool nooit leent`);
        assert.deepStrictEqual(v.lending.filter(([, ok]) => !ok), [['gmail_compose', false]],
            `${label}: en dat is precies één naam in deze stack — de rest leent onveranderd`);
    }
});

test('the verdict is the same nothing for all three uncurated shapes', () => {
    // Not "each is fine on its own": they must be INDISTINGUISHABLE. `{}` is
    // what the clamp writes, and if it read differently from a missing key the
    // clamp itself would be the thing that curated the agent.
    const [first, ...rest] = Object.values(UNCURATED).map(c => verdict(c));
    for (const [i, v] of rest.entries()) {
        assert.deepStrictEqual(v, first,
            `${Object.keys(UNCURATED)[i + 1]} must be byte-identical to a config with no tools key`);
    }
});

test('the confirm VERDICT is recorded and acted on by nobody', () => {
    // The split the whole design hangs on: `confirmByTool` still says what a
    // person WOULD have to approve, and `gatedTools` — the thing the runtime
    // acts on — is empty. Reading the verdict as the action is what would take
    // the draft card away from every agent in the product.
    const v = verdict(UNCURATED['no tools key']);
    assert.deepStrictEqual(v.confirm.find(([n]) => n === 'gmail_compose'), ['gmail_compose', 'ask'],
        'a send is still classified as needing a yes');
    assert.ok(!v.gated.includes('gmail_compose'), '...and is still dispatched anyway');
    assert.deepStrictEqual(
        v.decisions.find(([n]) => n === 'gmail_compose'),
        ['gmail_compose', 'run', 'allowed', 'ask'],
        'the round executor runs it: same call, same draft card, same as before A1b');
});

test('a headless run keeps the mail tool autoSend exists to use', () => {
    for (const [label, config] of Object.entries(UNCURATED)) {
        const v = verdict(config, { unattended: true });
        assert.deepStrictEqual(v.dropped, [], `${label}: nothing is withheld`);
        assert.deepStrictEqual(v.offered, NAMES,
            `${label}: a mailing automation that has always mailed must not stop mailing`);
        assert.deepStrictEqual(v.gated, [], `${label}: and nothing parks waiting for a person who is not there`);
    }
});

test('a name outside the stack still reaches the dispatcher', () => {
    // The pre-A1b path: the dispatcher resolves an unoffered name against the
    // caller's own automations and Steps, answers a progressive-disclosure name
    // with a "load that group first" hint, and otherwise tries a component
    // tool. Refusing it here for an agent nobody curated is a behaviour change
    // with no field behind it.
    for (const [label, config] of Object.entries(UNCURATED)) {
        assert.deepStrictEqual(
            verdict(config).decisions.find(([n]) => n === 'automation_pay_invoice'),
            ['automation_pay_invoice', 'run', 'not_offered_unenforced', 'direct'],
            `${label}: passed on, and named apart so the executor can log the drift`);
    }
});

test('an automation in the stack cannot arm the gate on its own', () => {
    // `automationConfirms` is the one thing that gates an agent with no app
    // map, so it must be empty unless the OWNER granted the automation. The stack
    // carries a real `__automation` definition here; without a grant it buys
    // nothing.
    for (const [label, config] of Object.entries(UNCURATED)) {
        assert.deepStrictEqual(verdict(config).overrides, [],
            `${label}: an offered automation is not a stored decision about it`);
    }
});

test('a broken registry changes not one verdict for an uncurated agent', () => {
    // The index is still BUILT (confirmForTool asks who owns a write before it
    // finds there is no map to ask about), so the failure is reached — it just
    // may not be allowed to matter. Equality against the healthy answer is the
    // assertion; anything weaker would pass while a degraded index quietly
    // started holding calls back on agents nobody curated.
    const healthy = Object.values(UNCURATED).map(c => [verdict(c), verdict(c, { unattended: true })]);

    const realError = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.join(' '));
    REGISTRY_BROKEN = true;
    P._resetAppIndex();
    try {
        assert.strictEqual(P.isAttributionAvailable(), false, 'precondition: attribution really is degraded');
        Object.values(UNCURATED).forEach((c, i) => {
            assert.deepStrictEqual(verdict(c), healthy[i][0],
                'a registry that cannot answer must not change what an uncurated agent is offered, ' +
                'confirmed on, or allowed to borrow');
            assert.deepStrictEqual(verdict(c, { unattended: true }), healthy[i][1],
                '...nor what it keeps in a headless run');
        });
    } finally {
        console.error = realError;
        REGISTRY_BROKEN = false;
        P._resetAppIndex();
    }
});

test('the fallback policy draws the same boundary', () => {
    // buildToolPolicy throwing must not be the thing that curates an agent.
    for (const [label, config] of Object.entries(UNCURATED)) {
        const fb = verdict(config, { build: P.fallbackToolPolicy });
        assert.deepStrictEqual(fb.offered, NAMES, `${label}: the stack that was offered, unchanged`);
        assert.deepStrictEqual(fb.gated, [], `${label}: still nothing held back`);
        assert.strictEqual(fb.enforceNames, false, `${label}: still no name gate`);
        assert.deepStrictEqual(
            fb.decisions.find(([n]) => n === 'automation_pay_invoice'),
            ['automation_pay_invoice', 'run', 'not_offered_unenforced', 'direct'],
            `${label}: and the dispatcher still decides`);
    }
});

test('nothing here writes a map onto an agent that has none', () => {
    // The boundary has a storage half too: saving an uncurated agent must not
    // hand it a `tools` map, or the next save would be reading a curation that
    // nobody performed.
    const noKey = P.normaliseToolsConfig({ ...UNCURATED['no tools key'], tools: undefined });
    assert.strictEqual(noKey.tools, null, 'no map in, no map out');
    assert.strictEqual(noKey.changed, false);

    const empty = P.normaliseToolsConfig({ ...UNCURATED['an empty map'] });
    assert.deepStrictEqual(empty.tools, {}, 'a map of nothing normalises to a map of nothing');
    assert.strictEqual(P.hasCuratedGrants(empty.tools), false, '...which is still not a curation');
});

// The junk-only map is the one shape of "nobody curated this" that does NOT
// survive normalisation unchanged, and that is a deliberate trade, not drift.
//
// It used to clamp to `{}` by DROPPING the unreadable entry — and a dropped
// entry is not a smaller grant, it is a bigger one: a missing entry means
// "every action of this app" to every reader in toolPolicy.js. So the clamped
// map handed the agent the whole of Gmail on the strength of a value nobody
// could read, and `applyConfigValidation` wrote that widening into the row.
// Every other unreadable half in this module already takes the narrow reading
// (a bare-string `actions`, the app overflow, a datatable grant that is not an
// object); this branch was the exception.
//
// What that costs is stated here rather than left to be discovered: the
// clamped map now holds a refusal, a refusal IS content, and so the agent
// answers `hasCuratedGrants` with true and enters the confirmation regime. It
// fails CLOSED — it holds a send back rather than granting one — and the
// warnings name the entry. The two shapes that a legitimate agent actually
// has (no key at all, `{}`) are untouched, which is the half of the boundary
// that protects every agent from before the picker.
test('a junk-only map narrows on the way through — the one shape that does change', () => {
    const raw = { ...UNCURATED['a junk-only map'] };

    // Unchanged: read RAW, it is still exactly the same nothing as no map at
    // all. Every runtime call site above asks the raw config this way.
    const v = verdict(raw);
    assert.deepStrictEqual(v, verdict(UNCURATED['no tools key']),
        'as stored, a junk map is still not a curation anywhere');

    const { tools, warnings } = P.normaliseToolsConfig(raw);
    assert.ok('gmail' in tools, 'the entry survives — dropping it is what granted the whole app');
    assert.deepStrictEqual(tools.gmail.actions, [], 'granting nothing, the narrow reading');
    assert.ok(!P.isToolAllowed('gmail_compose', tools),
        'and the clamped map may not offer what the raw one refused to describe');
    assert.ok(warnings.some(w => /gmail/.test(w)), 'said out loud');
    assert.strictEqual(P.hasCuratedGrants(tools), true,
        'the cost, named: a stored refusal is content, so the clamped agent is in the confirm regime');
});
