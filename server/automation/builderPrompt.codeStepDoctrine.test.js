/**
 * The prompt must not forbid a feature the product ships.
 *
 * `code` steps run in a genuinely hardened isolate (automation/codeSandbox.js:
 * separate heap, no Node bindings, no fs, no raw sockets, HTTPS-only fetch
 * behind the SSRF guard, clamped CPU/memory/wall), the runner dispatches them
 * (core/automationRunner/execution.js → execOutbound.execCode), and an org can
 * turn them on with `automation_code_step_enabled`. Until 2026-09-21 the
 * builder prompt then told the model, twice and absolutely, to use them "ONLY
 * when no integration fits" / "only when no integration fits" — with no
 * statement of what a code step costs. An absolute ban is not a preference
 * order: on a brief where nothing else in the menu fits, the model had nowhere
 * to go but an ai_step pretending to be a calculator, or a refusal.
 *
 * These tests pin the SHAPE of the replacement, not its prose:
 *   - the preference order survives (integration first — that part IS correct
 *     doctrine, because the integration carries auth, retries, the egress
 *     ledger and the PII guard),
 *   - the absolute framing does not,
 *   - and the constraints a code-step author cannot discover by trying (no
 *     npm, no fs, no raw sockets, HTTPS-only fetch, clamped CPU/wall, no
 *     secrets) are named where the model reads them.
 *
 * The last test is a ratchet the sibling suite cannot run:
 * builderPrompt.coreMenuDoctrine.test.js builds the lean prompt with code
 * steps OFF, so nothing it checks ever sees the enabled branch — and the
 * enabled branch is exactly where a stray `builder_add_code_step` (a tool the
 * core menu does NOT serve) would land.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt.codeStepDoctrine.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildFullSystemPrompt, buildLeanSystemPrompt } = require('./builderPrompt');
const { CORE_TOOL_NAMES } = require('./builderModelProfiles');

const CATALOG = {
    apps: [
        {
            id: 'gmail', label: 'Gmail', available: true, actions: [
                { name: 'gmail_search', description: 'Search Gmail', sideEffect: false, inputSchema: { type: 'object', properties: { q: {} }, required: ['q'] } },
            ],
        },
    ],
};

const fullOn = () => buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: true });
const fullOff = () => buildFullSystemPrompt({ catalog: CATALOG, codeStepEnabled: false });
const leanOn = () => buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: true, batchTools: true });
const leanOff = () => buildLeanSystemPrompt({ catalog: CATALOG, codeStepEnabled: false, batchTools: true });

// The two absolutes that used to be the whole guidance. Either one coming back
// is the regression this file exists for.
const ABSOLUTES = [
    /use ONLY when no integration fits/i,
    /use only when no integration fits/i,
];

test('neither prompt tells the model code is a forbidden last resort', () => {
    for (const p of [fullOn(), leanOn()]) {
        for (const re of ABSOLUTES) {
            assert.ok(!re.test(p), `the absolute framing ${re} is back in the prompt`);
        }
    }
});

test('the full prompt keeps the preference order: integration, then declarative, then code', () => {
    const p = fullOn();
    // The menu is hard-wrapped at ~92 columns, so "the PII\n guard" and "no raw\n
    // sockets" are split across lines. Match against the unwrapped text or the
    // assertions pin the line breaks instead of the wording.
    const entry = p.slice(p.indexOf('\n  code             —'), p.indexOf('\n  http_request     —'))
        .replace(/\s+/g, ' ');
    assert.ok(entry.length > 200, 'the code menu entry should be substantive, not a parenthetical');
    assert.ok(/integration_action/.test(entry), 'names integration_action as the first choice');
    // The reason integrations win is the part of the old doctrine that was
    // right — if it stops being stated, the order is just an assertion.
    assert.ok(/egress ledger/i.test(entry) && /PII guard/i.test(entry),
        'says WHY an integration beats code (egress ledger + PII guard)');
    assert.ok(/data_extraction/.test(entry) && /array_op/.test(entry),
        'names the declarative middle rung');
    // …and it must still be LAST, not promoted to a peer.
    assert.ok(/(3\) code|then code|last rung|LAST rung)/i.test(entry),
        'code is still the last rung of the order');
});

test('the full prompt names what a code step actually costs', () => {
    const p = fullOn();
    // The menu is hard-wrapped at ~92 columns, so "the PII\n guard" and "no raw\n
    // sockets" are split across lines. Match against the unwrapped text or the
    // assertions pin the line breaks instead of the wording.
    const entry = p.slice(p.indexOf('\n  code             —'), p.indexOf('\n  http_request     —'))
        .replace(/\s+/g, ' ');
    const costs = {
        'no npm': /no npm/i,
        'no filesystem': /no filesystem|no fs\b/i,
        'no raw sockets': /raw sockets/i,
        'HTTPS-only fetch': /HTTPS only|HTTPS-only/i,
        'clamped CPU/wall': /clamp/i,
        'no secrets': /ctx\.secrets\(\) throws|ctx\.secrets\(\)` throws/i,
    };
    for (const [label, re] of Object.entries(costs)) {
        assert.ok(re.test(entry), `the code menu entry never mentions: ${label}`);
    }
});

test('the lean prompt carries the same order and the same price in its hard rules', () => {
    const p = leanOn();
    const bullet = p.split('\n').find((l) => l.startsWith('- Code steps are available'));
    assert.ok(bullet, 'the lean hard rules still have a code-step bullet');
    assert.ok(/integration_action/.test(bullet), 'integration first');
    assert.ok(/egress ledger/i.test(bullet), 'says why integrations win');
    assert.ok(/no npm/i.test(bullet) && /ctx\.http/.test(bullet) && /clamp/i.test(bullet)
        && /ctx\.secrets/.test(bullet),
    'the lean bullet names the costs too — it is the ONLY thing the small band reads about code steps');
});

test('turning code steps OFF still forbids them outright, in both prompts', () => {
    // The flag is a real org policy, not a preference. Nothing above may soften
    // the disabled branch.
    assert.ok(/code steps are currently DISABLED — never propose them/.test(fullOff()),
        'full prompt still refuses code steps when the org has them off');
    assert.ok(/Code steps are DISABLED — never propose them/.test(leanOff()),
        'lean prompt still refuses code steps when the org has them off');
    assert.ok(!/sandboxed JavaScript/.test(fullOff()), 'and does not describe the step it just banned');
});

test('the http_request doctrine survives — a plain HTTP call is not a code step', () => {
    // This one was always RIGHT: there is a declarative step for an arbitrary
    // URL, so reaching for code (or telling the user to go get n8n) is the
    // wrong answer. Loosening the code guidance must not have loosened this.
    const p = fullOn();
    assert.ok(/do NOT suggest n8n or a code step for\s+a plain HTTP call/.test(p),
        'the full prompt still routes plain HTTP calls to http_request');
});

test('the enabled lean prompt names no tool the core menu cannot serve', () => {
    // coreMenuDoctrine.test.js builds this prompt with codeStepEnabled falsy,
    // so it never reads the branch below. `builder_add_code_step` is NOT in
    // CORE_TOOL_NAMES: a small-band build cannot emit that name at all.
    const p = leanOn();
    assert.ok(!p.includes('builder_add_code_step'),
        'the lean prompt names builder_add_code_step, which a core-menu build cannot call — '
        + 'on this menu a code step is an entry of type "code" in builder_add_steps');
    assert.ok(!CORE_TOOL_NAMES.has('builder_add_code_step'),
        'builder_add_code_step is in the core menu now — this test and the comment beside '
        + 'codeStepRule in builderPrompt.js are both stale');
});

// ── Parameters declared in the code (code step v2) ──────────────────
// The step settings parse the JSDoc on main into the step's input form
// (automation/codeSafety analyzeCode().params). A model that writes a code
// step without it hands the person who fills the step in a list of bare
// names. So every place a model learns about code steps states the format.
const PARAM_LINE = /@param \{type\} inputs\.<name> - <short description>/;

test('the full prompt teaches the JSDoc parameter format and why it matters', () => {
    const entry = fullOn().slice(fullOn().indexOf('\n  code             —'), fullOn().indexOf('\n  http_request     —'))
        .replace(/\s+/g, ' ');
    assert.ok(PARAM_LINE.test(entry), 'the code menu entry names the @param line format');
    assert.ok(/\[inputs\.name=value\]/.test(entry), 'and how a default is written');
    assert.ok(/form/i.test(entry), 'and says the params become the form the person fills in');
    assert.ok(/literal https:\/\//.test(entry), 'and asks for literal ctx.http URLs, so the check can see the hosts');
});

test('the lean prompt carries the parameter format in its code-step bullet', () => {
    const bullet = leanOn().split('\n').find((l) => l.startsWith('- Code steps are available'));
    assert.ok(PARAM_LINE.test(bullet), 'the small band reads only this bullet about code steps');
    assert.ok(/form/i.test(bullet), 'and why: the step shows the params as a form');
});

test('neither prompt says anything about params while code steps are off', () => {
    assert.ok(!PARAM_LINE.test(fullOff()) && !PARAM_LINE.test(leanOff()),
        'the disabled branch does not describe the step it bans');
});

test('builder_add_code_step teaches the params and no longer claims an org gate', () => {
    const { TOOL_SCHEMAS } = require('./builderTools');
    const tool = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_add_code_step');
    const desc = tool.function.description;
    // Code steps are on for every organisation now; the only switch is the
    // platform kill-switch (automation/codeStepSwitch.js). Telling the model
    // an org policy gates them made it hedge or ask the user to "enable" them.
    assert.ok(!/gated by org policy/i.test(desc), 'the stale org-policy sentence is gone');
    assert.ok(/@param \{type\} inputs\.<name> - <short description/.test(desc), 'the tool names the @param line format');
    assert.ok(/form/i.test(desc), 'and that the step settings show the params as a form');
    assert.ok(/@param/.test(tool.function.parameters.properties.code.description), 'the code parameter itself asks for the JSDoc block');
    assert.ok(/declared @param/.test(tool.function.parameters.properties.inputs.description), 'inputs are bound by the declared names');
});

test('builder_update_step lists limits among the patchable code keys, as stepEditing does', () => {
    const { TOOL_SCHEMAS } = require('./builderTools');
    const { PATCHABLE_FIELDS } = require('./builderTools/stepEditing');
    const patch = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_update_step').function.parameters.properties.patch.description;
    const codeKeys = /code: ([^;]+);/.exec(patch);
    assert.ok(codeKeys, 'the patch description has a code: entry');
    for (const key of PATCHABLE_FIELDS.code) {
        assert.ok(new RegExp(`\\b${key}\\b`).test(codeKeys[1]), `the code entry names the patchable key ${key}`);
    }
});
