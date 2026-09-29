/**
 * ACCEPTANCE — "can the App Studio builder actually make an advanced
 * calculator?"  This is the end-to-end answer, and it must stay honest.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * A user asked the builder AI for an advanced calculator. It shipped something
 * broken and then MISDIAGNOSED it: it concluded that binding a stat to a live
 * form value was "an architectural limit" and rebuilt the app around a
 * Calculate button. Three separate gaps were found underneath that story —
 * no maths functions in the expression whitelist, a render-phase setState in
 * useStickyBinding that took every formula tile down at once, and a prompt
 * that never told the model a calculator is a KEYPAD rather than a form.
 *
 * All three were fixed. This test is the proof that they add up to a working
 * capability rather than three separate green suites: it BUILDS the calculator
 * through the same tool functions the model calls (applyToolCall), pins the
 * result against a stored fixture, and runs the keypad and the finance maths
 * through the real expression engine with expected-vs-actual numbers.
 *
 * ── WHAT THE FIXTURE IS ─────────────────────────────────────────────────────
 * fixtures/calculatorApp.json is the definition this build produces, with ids
 * renamed deterministically (scr_0001, cmp_0003, act_0042 …) so a rebuild can
 * be compared to it exactly — `newId` is random, and nothing else about the
 * build is. It is a REAL stored definition: canonical, valid, and the same
 * bytes the browser test mounts (agent-hub .../runtime/AppRenderer.calculator.test.jsx
 * requires this very file), so client and server cannot drift apart on it.
 *
 * If this file goes red, the platform lost the ability to express a calculator.
 * Do not "fix" it by editing the fixture until you know which of the two sides
 * moved: `node --test appStudio/fixtures/calculatorApp.test.js` reports the
 * exact path that differs.
 *
 * Run: node --test appStudio/fixtures/calculatorApp.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const FIXTURE = require('./calculatorApp.json');

// ── Mock stores (same Module._resolveFilename harness as builderTools.test.js,
// so no DB pool is opened; componentSpecs / canonicalize / validate run for
// real). app_finalize persists, which is why the store has to exist at all.
const state = { apps: new Map(), nextApp: 0 };
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const mockStudioAppStore = {
    async createStudioApp({ userId, organizationId, name, description, icon, definition } = {}) {
        const id = `app-${++state.nextApp}`;
        const app = {
            id, userId, organizationId: organizationId || null,
            name: name || 'Untitled app', description: description || '', icon: icon || null,
            definition: clone(definition), definitionVersion: 1,
        };
        state.apps.set(id, app);
        return clone(app);
    },
    async getStudioApp(id) { const a = state.apps.get(id); return a ? clone(a) : null; },
    async saveDefinition(id, ownerId, definition, { expectedVersion = null } = {}) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return { ok: false, notFound: true };
        if (expectedVersion != null && a.definitionVersion !== expectedVersion) {
            return { ok: false, conflict: true, currentVersion: a.definitionVersion, definition: clone(a.definition) };
        }
        a.definition = clone(definition);
        a.definitionVersion += 1;
        return { ok: true, version: a.definitionVersion };
    },
    async updateStudioApp(id, updates = {}, ownerId) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return null;
        Object.assign(a, updates);
        return clone(a);
    },
};
const mockAutomationStore = { async getAutomationsForUser() { return []; } };
const mockUserStore = { async getUserById() { return { id: 'u1', organizationId: null }; } };

const MOCKS = {
    // as issued from appStudio/* and from the appStudio/builderTools/* modules
    '../stores/studioAppStore': mockStudioAppStore,
    '../../stores/studioAppStore': mockStudioAppStore,
    '../stores/automationStore': mockAutomationStore,
    '../../stores/automationStore': mockAutomationStore,
    '../stores/userStore': mockUserStore,
    '../../stores/userStore': mockUserStore,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const { applyToolCall } = require('../builderTools');
const { emptyDefinition, seedVariableDefaults, LIMITS } = require('../componentSpecs');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { evaluate } = require('../../automation/expr');

// ═══════════════════════════════════════════════════════════════════════════
// THE APP, AS THE MODEL WOULD AUTHOR IT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * STATE — four variables, no table, no form on the calculator screen.
 *   entry  TEXT, so a half-typed "12." can exist and "0" does not collapse to 0
 *   acc    the left operand of the pending operation
 *   op     "+"|"-"|"*"|"/" while an operation is pending
 *   mode   "typing"  — the user is entering a number, so a digit APPENDS
 *          "operand" — the display mirrors acc because an operator was just
 *                      pressed, so a second operator must NOT re-apply
 *          "result"  — the display holds a computed answer, so a digit REPLACES
 *
 * The three-state `mode` is load-bearing and was found the hard way: with a
 * single "next digit starts fresh" boolean, `4 √ + 1 =` answers 1 instead of 3,
 * because a scientific key and an operator key both "armed" the display but
 * only one of them had already consumed the operand.
 */

/** Apply the pending operator to (acc, entry). Reads the PRE-step scope. */
const APPLY = [
    'vars.op == "+" ? vars.acc + number(vars.entry)',
    ': (vars.op == "-" ? vars.acc - number(vars.entry)',
    ': (vars.op == "*" ? vars.acc * number(vars.entry)',
    ': (vars.op == "/" ? (number(vars.entry) == 0 ? 0 : vars.acc / number(vars.entry))',
    ': number(vars.entry))))',
].join(' ');

const sv = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const svs = (name, value) => ({ kind: 'set_variable', name, value: { kind: 'static', value } });

const digitAction = (d) => ({
    kind: 'sequence',
    steps: [
        sv('entry', `vars.mode == "typing" ? (vars.entry == "0" ? "${d}" : concat(vars.entry, "${d}")) : "${d}"`),
        svs('mode', 'typing'),
    ],
});

const DOT_ACTION = {
    kind: 'sequence',
    steps: [
        sv('entry', 'vars.mode == "typing" ? (contains(vars.entry, ".") ? vars.entry : concat(vars.entry, ".")) : "0."'),
        svs('mode', 'typing'),
    ],
};

const CLEAR_ACTION = {
    kind: 'sequence',
    steps: [svs('entry', '0'), svs('acc', 0), svs('op', ''), svs('mode', 'typing')],
};

const BACKSPACE_ACTION = {
    kind: 'sequence',
    steps: [
        sv('entry', 'len(vars.entry) <= 1 ? "0" : substring(vars.entry, 0, len(vars.entry) - 1)'),
        svs('mode', 'typing'),
    ],
};

const operatorAction = (symbol) => ({
    kind: 'sequence',
    steps: [
        sv('acc', `vars.mode == "operand" ? vars.acc : (${APPLY})`),
        sv('entry', 'toStr(vars.acc)'),   // the display shows the running total
        svs('op', symbol),
        svs('mode', 'operand'),
    ],
});

/** Equals is ONE switch on vars.op — the idiom the builder prompt teaches. */
const EQUALS_ACTION = {
    kind: 'sequence',
    steps: [
        {
            kind: 'switch',
            expr: 'vars.op',
            cases: [
                { value: '+', steps: [sv('entry', 'toStr(vars.acc + number(vars.entry))')] },
                { value: '-', steps: [sv('entry', 'toStr(vars.acc - number(vars.entry))')] },
                { value: '*', steps: [sv('entry', 'toStr(vars.acc * number(vars.entry))')] },
                { value: '/', steps: [sv('entry', 'number(vars.entry) == 0 ? "Cannot divide by 0" : toStr(vars.acc / number(vars.entry))')] },
            ],
            // No operator pending: = just normalises what is on screen ("12." → "12").
            default: [sv('entry', 'toStr(ifNull(number(vars.entry), 0))')],
        },
        sv('acc', 'ifNull(number(vars.entry), 0)'),
        svs('op', ''),
        svs('mode', 'result'),
    ],
};

/**
 * A one-tap scientific key: rewrite `entry` from itself.
 * ifNull is the whole error strategy — every maths helper is total, so a domain
 * error (sqrt of a negative, ln of zero) arrives as null, never as NaN.
 */
const scientificAction = (expr) => ({
    kind: 'sequence',
    steps: [sv('entry', `toStr(ifNull(round(${expr}, 8), "Error"))`), svs('mode', 'result')],
});

/** [label, action, button variant] — laid out four across a 12-column grid. */
const KEYS = [
    ['√', scientificAction('sqrt(number(vars.entry))'), 'soft'],
    ['x²', scientificAction('pow(number(vars.entry), 2)'), 'soft'],
    ['ln', scientificAction('ln(number(vars.entry))'), 'soft'],
    ['sin', scientificAction('sin(radians(number(vars.entry)))'), 'soft'],
    ['C', CLEAR_ACTION, 'outline'],
    ['⌫', BACKSPACE_ACTION, 'outline'],
    ['÷', operatorAction('/'), 'outline'],
    ['×', operatorAction('*'), 'outline'],
    ['7', digitAction('7'), 'secondary'],
    ['8', digitAction('8'), 'secondary'],
    ['9', digitAction('9'), 'secondary'],
    ['−', operatorAction('-'), 'outline'],
    ['4', digitAction('4'), 'secondary'],
    ['5', digitAction('5'), 'secondary'],
    ['6', digitAction('6'), 'secondary'],
    ['+', operatorAction('+'), 'outline'],
    ['1', digitAction('1'), 'secondary'],
    ['2', digitAction('2'), 'secondary'],
    ['3', digitAction('3'), 'secondary'],
    ['=', EQUALS_ACTION, 'primary'],
    ['0', digitAction('0'), 'secondary'],
    ['.', DOT_ACTION, 'secondary'],
];
const WIDE = new Set(['0', '.']); // the bottom row is two keys wide

// Finance — the case that needs pow(), and the one that needs ^.
const R = 'forms.loan.rate / 1200';
const N = 'forms.loan.years * 12';
const MONTHLY = `round(forms.loan.amount * (${R}) / (1 - pow(1 + (${R}), 0 - (${N}))), 2)`;
const TOTAL = `round((${MONTHLY}) * (${N}), 2)`;
const INTEREST = `round((${TOTAL}) - forms.loan.amount, 2)`;
const FUTURE = 'round(forms.save.deposit * (1 + forms.save.rate / 1200) ^ (forms.save.years * 12), 2)';

const numberField = (name, label, defaultValue, extra = {}) => ({
    type: 'input_number',
    props: { name, label, defaultValue, min: 0, ...extra },
    style: { span: 4 },
});
const financeStat = (label, expr, span = 4) => ({
    type: 'stat', props: { label, value: { kind: 'formula', expr }, look: 'tile' }, style: { span },
});

/**
 * Drive the REAL tools, exactly as the model does, and record every call.
 * Any tool error throws — a build that limps is not a build that works.
 */
async function buildViaTools() {
    const wrap = {
        userId: 'u1', orgId: null, appId: null, version: null,
        builderSessionId: 'bs_fixture', def: emptyDefinition('Calculator'),
    };
    const calls = [];
    const hints = [];
    const call = async (name, args) => {
        const r = await applyToolCall(name, args, wrap);
        calls.push(name);
        if (r && r.error) throw new Error(`${name} failed: ${r.error}\n${JSON.stringify(r.validation || {}, null, 2)}`);
        if (r && r._hints) hints.push({ name, hints: r._hints });
        return r;
    };

    await call('app_set_meta', {
        name: 'Advanced calculator',
        description: 'A keypad calculator with a scientific row, plus loan and savings maths.',
        icon: 'Calculator',
    });
    await call('app_set_theme', { preset: 'midnight' });
    await call('app_set_variables', {
        variables: [
            { name: 'entry', label: 'Display', type: 'text', default: '0', description: 'What the display shows. Text, so a half-typed "12." can exist.' },
            { name: 'acc', label: 'Accumulator', type: 'number', default: 0, description: 'The left operand of the pending operation.' },
            { name: 'op', label: 'Pending operator', type: 'text', default: '', description: 'One of + - * / while an operation is pending.' },
            { name: 'mode', label: 'What the display holds', type: 'text', default: 'typing', description: '"typing" = the user is entering a number; "operand" = the display mirrors acc because an operator was just pressed; "result" = the display holds a computed answer.' },
        ],
    });

    const homeScreen = wrap.def.screens[0];
    const homeSection = homeScreen.sections[0];
    await call('app_update_screen', {
        screenId: homeScreen.id, name: 'Calculator', icon: 'Calculator',
        description: 'Keypad, scientific keys and a running display.',
    });

    // ONE ACTION PER KEY. Actions take no arguments, so ten digit keys are ten
    // near-identical actions; there is no way to write "the digit action" once.
    const actionIds = [];
    for (const [, action] of KEYS) {
        const r = await call('app_set_action', { action });
        actionIds.push(r.actionId);
    }

    // The whole screen — display + 22 keys — in ONE batched call.
    const added = await call('app_add_components', {
        parentId: homeSection.id,
        components: [
            {
                type: 'stat',
                props: { label: 'Display', value: { kind: 'formula', expr: 'vars.entry' }, look: 'accent' },
                style: { span: 12, size: 'lg', align: 'end' },
            },
            ...KEYS.map(([label, , variant]) => ({
                type: 'button',
                props: { label, variant },
                style: { span: WIDE.has(label) ? 6 : 3, size: 'lg' },
            })),
        ],
    });

    // …and then 22 more calls to wire them, because app_add_components has no
    // `events` field: a component and its onClick cannot be authored together.
    const buttonIds = added.added.filter((a) => a.type === 'button').map((a) => a.id);
    for (let i = 0; i < buttonIds.length; i++) {
        await call('app_bind_action', { nodeId: buttonIds[i], event: 'onClick', actionId: actionIds[i] });
    }

    const fin = await call('app_add_screen', {
        name: 'Finance', icon: 'Landmark', description: 'Loan repayment and compound growth, live as you type.',
    });
    await call('app_add_components', {
        parentId: fin.sectionId,
        components: [
            {
                type: 'card',
                props: { title: 'Loan repayment', description: 'Amortised monthly payment.' },
                style: { span: 12, padding: 4, gap: 3, background: 'surface' },
                children: [
                    {
                        type: 'form', props: { name: 'loan', showSubmit: false, showReset: false }, style: { span: 12, gap: 3 },
                        children: [
                            numberField('amount', 'Loan amount', 250000, { step: 1000 }),
                            numberField('rate', 'Annual interest %', 4.5, { step: 0.1 }),
                            numberField('years', 'Term (years)', 30, { min: 1, step: 1 }),
                        ],
                    },
                    financeStat('Monthly payment', MONTHLY),
                    financeStat('Total repaid', TOTAL),
                    financeStat('Total interest', INTEREST),
                ],
            },
            {
                type: 'card',
                props: { title: 'Compound growth', description: 'Monthly compounding, using the ^ operator.' },
                style: { span: 12, padding: 4, gap: 3, background: 'surface' },
                children: [
                    {
                        type: 'form', props: { name: 'save', showSubmit: false, showReset: false }, style: { span: 12, gap: 3 },
                        children: [
                            numberField('deposit', 'Deposit', 10000, { step: 500 }),
                            numberField('rate', 'Annual interest %', 5, { step: 0.1 }),
                            numberField('years', 'Years', 10, { min: 1, step: 1 }),
                        ],
                    },
                    financeStat('Future value', FUTURE, 6),
                ],
            },
        ],
    });

    await call('app_finalize', {});
    return { def: wrap.def, calls, hints, finalized: wrap.finalized };
}

/**
 * Rename every id deterministically so a rebuild can be compared to the stored
 * fixture: screens → sections → components depth-first, then actions in the
 * order their referencing component appears. `newId` is the only source of
 * nondeterminism in the whole build.
 */
function normalizeIds(input) {
    const def = clone(input);
    const map = new Map();
    let n = 0;
    const take = (kind, id) => {
        if (typeof id !== 'string' || map.has(id)) return;
        map.set(id, `${kind}_${String(++n).padStart(4, '0')}`);
    };
    const actionIds = [];
    const walkNodes = (nodes) => {
        for (const node of nodes || []) {
            take('cmp', node.id);
            for (const ev of ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange']) {
                if (typeof node[ev] === 'string') actionIds.push(node[ev]);
            }
            walkNodes(node.children);
        }
    };
    for (const screen of def.screens || []) {
        take('scr', screen.id);
        for (const section of screen.sections || []) {
            take('sec', section.id);
            walkNodes(section.children);
        }
    }
    for (const id of actionIds) take('act', id);
    for (const id of Object.keys(def.actions || {})) take('act', id);

    const rename = (v) => {
        if (typeof v === 'string') return map.get(v) || v;
        if (Array.isArray(v)) return v.map(rename);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) out[map.get(k) || k] = rename(val);
            return out;
        }
        return v;
    };
    return rename(def);
}

// ═══════════════════════════════════════════════════════════════════════════
// A CALCULATOR IS BUILDABLE
// ═══════════════════════════════════════════════════════════════════════════

let BUILT = null;
const built = async () => { if (!BUILT) BUILT = await buildViaTools(); return BUILT; };

test('the builder tools produce the stored calculator, byte for byte', async () => {
    const { def } = await built();
    assert.deepStrictEqual(normalizeIds(def), FIXTURE);
});

test('every tool call succeeds and none of them needed repairing', async () => {
    const { calls, hints, finalized } = await built();
    assert.deepStrictEqual(hints, [], 'a _hint means the canonicalizer repaired the model\'s input');
    assert.strictEqual(finalized, true, 'app_finalize must have accepted the definition');

    // The cost of a keypad, stated out loud so a regression in either
    // direction is visible. See the notes at the bottom of this file.
    const byTool = calls.reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {});
    assert.deepStrictEqual(byTool, {
        app_set_meta: 1,
        app_set_theme: 1,
        app_set_variables: 1,
        app_update_screen: 1,
        app_set_action: 22,      // one per key: an action takes no arguments
        app_add_components: 2,   // the whole 23-component screen is ONE call
        app_bind_action: 22,     // …but every onClick is a separate call
        app_add_screen: 1,
        app_finalize: 1,
    });
    assert.strictEqual(calls.length, 52);
});

test('the fixture is canonical: one pass, zero repairs, and a fixed point', () => {
    const first = canonicalizeAppDefinition(FIXTURE);
    assert.deepStrictEqual(first.repairs, []);
    assert.deepStrictEqual(first.def, FIXTURE, 'canonicalize must not change a stored definition');

    const second = canonicalizeAppDefinition(first.def);
    assert.deepStrictEqual(second.repairs, []);
    assert.deepStrictEqual(second.def, first.def, 'canonicalize is idempotent');
});

test('the fixture validates with zero errors and zero warnings', () => {
    const v = validateAppDefinition(FIXTURE);
    assert.deepStrictEqual(v.errors, []);
    assert.deepStrictEqual(v.warnings, []);
    assert.strictEqual(v.ok, true);
});

test('it stays well inside the platform ceilings', () => {
    assert.ok(FIXTURE.variables.length <= LIMITS.MAX_VARIABLES);
    assert.ok(Object.keys(FIXTURE.actions).length <= LIMITS.MAX_ACTIONS);
    assert.ok(JSON.stringify(FIXTURE).length < LIMITS.MAX_DEFINITION_BYTES);
    // 22 actions of 60 — a scientific keypad with a second function row
    // (cos/tan/x!/1÷x…) would need 60+ and would NOT fit.
    assert.strictEqual(Object.keys(FIXTURE.actions).length, 22);
});

// ═══════════════════════════════════════════════════════════════════════════
// …AND IT COMPUTES THE RIGHT ANSWERS
// The keypad is walked exactly the way useActionRunner walks it (set_variable
// resolves against the vars written by earlier steps; switch uses the same
// loose case match), with every formula going through the real engine.
// ═══════════════════════════════════════════════════════════════════════════

const CALC_SCREEN = FIXTURE.screens.find((s) => s.name === 'Calculator');
const FINANCE_SCREEN = FIXTURE.screens.find((s) => s.name === 'Finance');

function collect(screen, type) {
    const out = [];
    (function walk(nodes) {
        for (const n of nodes || []) {
            if (n.type === type) out.push(n);
            walk(n.children);
        }
    }(screen.sections.flatMap((s) => s.children)));
    return out;
}

const ACTION_BY_KEY = new Map(collect(CALC_SCREEN, 'button').map((b) => [b.props.label, b.onClick]));

/** useActionRunner's caseMatches, verbatim. */
function caseMatches(caseValue, exprValue) {
    if (caseValue === exprValue) return true;
    if (caseValue == null || exprValue == null) return false;
    return String(caseValue) === String(exprValue);
}

function runSteps(steps, vars) {
    for (const step of steps || []) {
        if (step.kind === 'set_variable') {
            const b = step.value;
            vars[step.name] = b.kind === 'static' ? b.value : evaluate(b.expr, { vars });
        } else if (step.kind === 'switch') {
            const v = evaluate(step.expr, { vars });
            const hit = (step.cases || []).find((c) => caseMatches(c.value, v));
            runSteps(hit ? hit.steps : step.default, vars);
        } else {
            throw new Error(`this calculator should only use set_variable/switch, got ${step.kind}`);
        }
    }
}

/** Press keys on a fresh calculator and return what the display shows. */
function press(...keys) {
    const vars = seedVariableDefaults(FIXTURE.variables);
    for (const key of keys) {
        const actionId = ACTION_BY_KEY.get(key);
        assert.ok(actionId, `no key labelled "${key}"`);
        runSteps(FIXTURE.actions[actionId].steps, vars);
    }
    return vars.entry;
}

test('the keypad starts at 0 and its keys are the ones a calculator has', () => {
    assert.strictEqual(seedVariableDefaults(FIXTURE.variables).entry, '0');
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'C', '⌫', '+', '−', '×', '÷', '=', '√', 'x²', 'ln', 'sin']) {
        assert.ok(ACTION_BY_KEY.has(key), `missing key "${key}"`);
    }
    assert.strictEqual(ACTION_BY_KEY.size, 22);
});

test('typing digits', () => {
    assert.strictEqual(press('7'), '7');
    assert.strictEqual(press('1', '2'), '12');
    assert.strictEqual(press('0', '5'), '5', 'a leading zero is replaced, not appended to');
    assert.strictEqual(press('3', '.', '1', '4'), '3.14');
    assert.strictEqual(press('.', '5'), '0.5');
    assert.strictEqual(press('1', '.', '2', '.', '3'), '1.23', 'a second decimal point is ignored');
});

test('clear and backspace', () => {
    assert.strictEqual(press('1', '2', '⌫'), '1');
    assert.strictEqual(press('5', '⌫'), '0', 'backspacing the last digit leaves 0, not an empty display');
    assert.strictEqual(press('1', '2', '3', 'C'), '0');
});

test('the four operators', () => {
    assert.strictEqual(press('7', '+', '5', '='), '12');
    assert.strictEqual(press('9', '−', '4', '='), '5');
    assert.strictEqual(press('6', '×', '7', '='), '42');
    assert.strictEqual(press('8', '÷', '2', '='), '4');
    assert.strictEqual(press('1', '÷', '8', '='), '0.125');
});

test('chained arithmetic evaluates as it goes: 2 + 3 + 4 = 9', () => {
    // The second + applies the first one, so the running display shows 5 before
    // the 4 is typed. A calculator that answered 7 here would be broken.
    assert.strictEqual(press('2', '+', '3', '+', '4', '='), '9');
    assert.strictEqual(press('2', '+', '3', '+'), '5', 'the display shows the running total');
    assert.strictEqual(press('1', '0', '−', '3', '×', '4', '='), '28', 'left to right, no precedence — like every pocket calculator');
});

test('pressing a second operator replaces the first instead of re-applying it', () => {
    assert.strictEqual(press('5', '+', '−', '3', '='), '2');
});

test('divide by zero says so instead of showing Infinity', () => {
    assert.strictEqual(press('9', '÷', '0', '='), 'Cannot divide by 0');
    // …and the calculator is still usable afterwards.
    assert.strictEqual(press('9', '÷', '0', '=', 'C', '4', '+', '1', '='), '5');
});

test('THE SCIENTIFIC KEYS — the functions that did not exist before', () => {
    assert.strictEqual(press('2', '√'), '1.41421356');          // √2  = 1.41421356237…
    assert.strictEqual(press('9', '√'), '3');
    assert.strictEqual(press('7', 'x²'), '49');                 // 7²  = 49
    assert.strictEqual(press('1', '.', '5', 'x²'), '2.25');     // 1.5² = 2.25
    assert.strictEqual(press('1', '0', 'ln'), '2.30258509');    // ln 10 = 2.302585092994…
    assert.strictEqual(press('1', 'ln'), '0');                  // ln 1 = 0
    assert.strictEqual(press('3', '0', 'sin'), '0.5');          // sin 30° = 0.5 exactly, via radians()
    assert.strictEqual(press('9', '0', 'sin'), '1');            // sin 90° = 1
    assert.strictEqual(press('4', '5', 'sin'), '0.70710678');   // sin 45° = 0.707106781186…
});

test('a scientific result is a normal operand afterwards', () => {
    // This is the case a single "armed" flag gets wrong: √ leaves a result on
    // screen, and the following + must CONSUME it rather than skip it.
    assert.strictEqual(press('4', '√', '+', '1', '='), '3');
    assert.strictEqual(press('4', '√', 'x²'), '4');
    assert.strictEqual(press('3', '+', '4', '=', 'x²'), '49');
});

test('a domain error shows "Error", never NaN and never a crash', () => {
    assert.strictEqual(press('5', '⌫', 'ln'), 'Error', 'ln(0) has no value');
    assert.strictEqual(press('5', '⌫', '√'), '0', 'but sqrt(0) is a perfectly good 0');
    assert.strictEqual(press('0', '−', '4', '=', '√'), 'Error', 'sqrt(-4) has no value');
    assert.strictEqual(press('0', '−', '4', '=', '√', 'C', '2', '+', '2', '='), '4', 'and it recovers');
});

// ── Finance: the maths that needs pow() and ^ ───────────────────────────────

const FINANCE_STATS = new Map(collect(FINANCE_SCREEN, 'stat').map((s) => [s.props.label, s.props.value.expr]));
const money = (label, forms) => evaluate(FINANCE_STATS.get(label), { forms });

test('amortised monthly payment — pow() against a hand-computed answer', () => {
    const forms = { loan: { amount: 250000, rate: 4.5, years: 30 } };

    // Standard annuity formula, computed here independently of the engine:
    //   M = L·r / (1 − (1+r)^−n),  r = 4.5%/12 = 0.00375, n = 360
    const r = 0.045 / 12;
    const n = 30 * 12;
    const expected = 250000 * r / (1 - Math.pow(1 + r, -n));
    assert.ok(Math.abs(expected - 1266.7132745647145) < 1e-9, 'sanity: the hand computation itself');

    const monthly = money('Monthly payment', forms);
    assert.strictEqual(monthly, 1266.71);
    assert.ok(Math.abs(monthly - expected) <= 0.005, `${monthly} vs ${expected}`);

    // Totals are derived from the ROUNDED payment, which is what a bank quotes.
    assert.strictEqual(money('Total repaid', forms), 456015.6);
    assert.strictEqual(money('Total repaid', forms), Math.round(1266.71 * 360 * 100) / 100);
    assert.strictEqual(money('Total interest', forms), 206015.6);
    assert.strictEqual(money('Total interest', forms), Math.round((456015.6 - 250000) * 100) / 100);
});

test('an interest-free loan is a plain division, not a divide-by-zero', () => {
    // r = 0 makes the annuity formula 0/0. pow(1, 0) is 1, so the denominator
    // is 0 and the result collapses to null — an empty tile, not a NaN.
    assert.strictEqual(money('Monthly payment', { loan: { amount: 1200, rate: 0, years: 1 } }), null);
});

test('compound growth — the ^ operator against a hand-computed answer', () => {
    const forms = { save: { deposit: 10000, rate: 5, years: 10 } };
    const expected = 10000 * Math.pow(1 + 0.05 / 12, 120);
    assert.ok(Math.abs(expected - 16470.0949769028) < 1e-9, 'sanity: the hand computation itself');

    const fv = money('Future value', forms);
    assert.strictEqual(fv, 16470.09);
    assert.ok(Math.abs(fv - expected) <= 0.005, `${fv} vs ${expected}`);

    // ^ IS pow(), so the two spellings cannot disagree.
    assert.strictEqual(
        evaluate('10000 * (1 + 5 / 1200) ^ 120', {}),
        evaluate('10000 * pow(1 + 5 / 1200, 120)', {}),
    );
});

test('an empty finance form leaves every tile blank rather than NaN', () => {
    // This is the frame-1 state of the screen: forms is {} until AppForm's
    // effect publishes. round() funnels the NaN to null, which a stat paints as
    // an em-dash — the trap the builder prompt now names explicitly.
    for (const label of FINANCE_STATS.keys()) {
        assert.strictEqual(money(label, {}), null, label);
    }
});

test('the finance screen really is live form binding, not a Calculate button', () => {
    // The thing the builder AI declared impossible. Every finance tile reads
    // forms.* directly and there is no submit button anywhere on the screen.
    for (const [label, expr] of FINANCE_STATS) {
        assert.ok(expr.includes('forms.'), `${label} does not read a form`);
    }
    for (const form of collect(FINANCE_SCREEN, 'form')) {
        assert.strictEqual(form.props.showSubmit, false, 'no submit button — the numbers move as you type');
    }
    assert.strictEqual(collect(FINANCE_SCREEN, 'button').length, 0);
});

/*
 * ── HOW EXPENSIVE IS A KEYPAD? (recorded, not asserted as good) ─────────────
 *
 * 52 tool calls, of which 44 are one-per-key boilerplate:
 *   22 × app_set_action  — an action takes no arguments, so the ten digit keys
 *                          are ten near-identical two-step sequences that
 *                          differ only in the character "7"/"8"/"9"/…
 *   22 × app_bind_action — app_add_components has no `events` field, so a
 *                          button and its onClick cannot be authored in the
 *                          same call. Adding `events` to the component entry
 *                          shape would take this build from 52 calls to 30.
 * The other 8 calls are the actual app: meta, theme, variables, the screen
 * rename, ONE batched app_add_components for all 23 components of the keypad
 * screen, the finance screen, its components, and finalize.
 *
 * There is also no way for one action to call another (no run_action step), so
 * any logic shared between keys has to be duplicated into each of them. Here
 * the shared bit is small (the APPLY ternary, in four operator actions); a
 * richer instrument would feel this much harder.
 *
 * The grid itself is honest and compact: `style.span 3` on a plain button gives
 * four keys across, `span 6` gives two, and the 22 keys plus the display are a
 * single app_add_components call — the layout was never the expensive part.
 */
