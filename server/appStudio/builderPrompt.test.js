/**
 * Unit tests for the App Studio builder prompt (builderPrompt.js).
 *
 * Pins the Wave-2A contracts: the system prompt teaches all six binding
 * kinds + the data-first workflow, renderDraftState grows an optional data
 * block that is a strict superset (absent extras stay byte-identical for old
 * callers), renderAction understands sequence/open_modal, and summariseApp
 * gains table/dataset counts when passed extras.
 *
 * Run: node --test appStudio/builderPrompt.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt, renderDraftState, summariseApp, renderOwnerContextNote, OWNER_CONTEXT_PREFIX } = require('./builderPrompt');
const { renderCatalogText, renderCompactCatalogText } = require('./builderPrompt/catalogRender');
const { emptyDefinition } = require('./componentSpecs');

// ── Fixtures ────────────────────────────────────────────────────────

function defWithActions() {
    const def = emptyDefinition('Prompt app');
    const scr = def.screens[0].id;
    def.actions = {
        act_seq001: {
            kind: 'sequence',
            steps: [
                { kind: 'confirm', message: 'Sure?' },
                { kind: 'create_record', tableId: 'tbl_task01', values: { title: { kind: 'static', value: 'x' } } },
                { kind: 'toast', message: 'Saved', tone: 'success' },
                { kind: 'navigate', screenId: scr },
            ],
        },
        act_mod001: { kind: 'open_modal', modalId: 'cmp_modal1' },
    };
    return def;
}

const DATA_MODEL = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_task01', key: 'tasks', name: 'Tasks',
        fields: [
            { id: 'fld_t1', key: 'title', type: 'text', required: true, unique: false },
            { id: 'fld_t2', key: 'status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }], required: false, unique: false },
            { id: 'fld_t3', key: 'owner', type: 'relation', relation: { table: 'tbl_ppl001' }, required: false, unique: false },
        ],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }, {
        id: 'tbl_ppl001', key: 'people', name: 'People',
        fields: [{ id: 'fld_p1', key: 'name', type: 'text', required: true, unique: false }],
        access: { default: 'owner', roles: {}, rowFilters: {} },
    }],
    roles: [{ key: 'admin', label: 'Admin' }, { key: 'member', label: 'Member' }],
    roleMapping: { default: 'member', byGroup: {} },
};

const EXTRAS = {
    dataModel: DATA_MODEL,
    datasets: ['ds_open001', { id: 'ds_agg0001', name: 'By status' }],
    rowCounts: { tbl_task01: 12 },
};

// ── System prompt ───────────────────────────────────────────────────

test('buildSystemPrompt is byte-stable for a given (toolset, catalog, automations) triple', () => {
    assert.strictEqual(buildSystemPrompt(), buildSystemPrompt());
    assert.strictEqual(buildSystemPrompt({ toolset: 'core' }), buildSystemPrompt({ toolset: 'core' }));
});

test('system prompt teaches all six binding kinds and the data-first workflow', () => {
    const sys = buildSystemPrompt();
    for (const kind of ['static', 'actionResult', 'formula', 'record', 'records', 'dataset']) {
        assert.ok(sys.includes(`kind:"${kind}"`), `binding kind ${kind} named in the bindings bullet`);
    }
    // The data-backed step names the (incrementally shipping) data tools.
    for (const tool of ['app_upsert_table', 'app_seed_records', 'app_upsert_dataset', 'app_query_data', 'app_get_data_model', 'app_dry_run']) {
        assert.ok(sys.includes(tool), `data tool ${tool} referenced`);
    }
    assert.ok(sys.includes('DATA-BACKED'), 'data-backed how-you-work step present');
    // Text is guarded on tool-menu availability so it stays valid before the
    // tools land.
    assert.ok(sys.includes('in your tool menu'), 'availability guard present');
});

test('core toolset gets the shortened data section', () => {
    const core = buildSystemPrompt({ toolset: 'core' });
    const full = buildSystemPrompt({ toolset: 'full' });
    assert.ok(core.includes('2. DATA FIRST — decide the table before any component or action'), 'core prompt keeps a data step and leads with the decision');
    assert.ok(core.includes('app_link_datatable {name} FIRST'), 'the core data step leads with linking an existing table');
    const upsertAt = core.indexOf('app_upsert_table {name, fields:[{key,type}]} FIRST');
    assert.ok(upsertAt > -1, 'the core data step names the creator for an OWN table (2026-09-13: without it the model invented tbl_ ids)');
    assert.ok(upsertAt < core.indexOf('Bind directly:'), 'the decision comes before the binding recipes');
    assert.ok(core.includes('app_seed_records 5–10 realistic fictional rows'), 'and the seeder, after the create');
    assert.ok(core.includes('never one you invented'), 'and forbids invented ids');
    assert.match(core, /6\. REAL ids only — from the draft state/, 'and says so again as its own rule');
    assert.ok(core.includes('A table marked linked in the data block is never seeded'), 'linked tables stay protected');
    assert.ok(core.length < full.length, 'core prompt is shorter');
    assert.ok(!core.includes('app_dry_run'), 'core step omits the non-core dry-run tool');
    assert.ok(full.includes('app_link_datatable {name} first'), 'the full data step leads with the linked case too');
});

test('both toolsets carry the LINKED TABLES doctrine and the plan bundle rule', () => {
    // Since 2026-09-17 the data block's linked line carries only the facts
    // (`linked=studio mode=read`); these bullets are the ONLY place the
    // doctrine lives, on both prompts.
    for (const toolset of ['core', 'full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.match(p, /LINKED TABLES: a table line in the data block marked/, `${toolset}: linked doctrine`);
        assert.match(p, /never app_seed_records it, never rewrite its fields with app_upsert_table, never put a saved dataset on it/, `${toolset}: the three nevers`);
        assert.match(p, /"Excl\. btw" is the key excl_btw/, `${toolset}: title vs key`);
        assert.match(p, /call app_link_datatable \{name\} FIRST/, `${toolset}: link by name`);
        assert.match(p, /`mode=read` means no create\/update\/delete steps/, `${toolset}: read means no writes`);
    }
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.match(full, /3b\. PLAN AS YOU BUILD: .*bundle app_set_plan\(\{todos\}\) with your FIRST build call/, 'full: plan bundle rule');
    assert.match(full, /Never send app_set_plan as your only call/, 'full: never alone');
    // Core: the plan is part of the FIRST CALL GROUP (rule 1) and markDone rides later calls.
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    assert.match(core, /1\. FIRST CALL GROUP on a new app, in one reply: app_set_plan \{todos\} \+ app_set_meta/, 'core: the plan opens the first call group');
    assert.match(core, /bundle app_set_plan \{markDone\} with the calls that complete an item — never send it alone/, 'core: markDone rides later calls, never alone');
});

test('both toolsets carry the design doctrine', () => {
    // Every generated app used to ship the identity defaults for everything —
    // which is why two apps built the same day looked like twins. The doctrine
    // names only app_set_theme, which IS in the core menu. The core prompt
    // carries the compressed three bullets (no section-background line: the
    // core menu has no app_add_section to set one with).
    for (const toolset of ['core', 'full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.ok(p.includes('## Design doctrine'), `${toolset} prompt lost the doctrine`);
        assert.match(p, /app_set_theme/, 'the identity pick names its tool');
        assert.match(p, /look like twins/, 'the point of the doctrine is stated');
        assert.match(p, /"hero" or "banner"/, 'home-screen page_header looks prescribed');
        assert.match(p, /tile\/tinted\/accent\/gradient/, 'KPI-row stat looks prescribed');
        assert.match(p, /striped or minimal/, 'table looks prescribed');
        assert.match(p, /missed decision/, 'defaults-everywhere named as the failure');
    }
    assert.match(buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' }), /panel\/gradient/, 'full: section background rhythm prescribed');
});

test('the screenshot loop is taught only where app_screenshot exists', () => {
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.ok(full.includes('app_screenshot'), 'full prompt teaches the screenshot loop');
    assert.match(full, /NORMAL answer/, 'unavailable is framed as an answer, not an error');
    assert.match(full, /before app_finalize on any substantial build/, 'the pre-finalize check is stated');
    // The core menu has no screenshot tool — its prompt must not even hint at
    // one, or a small model burns a turn discovering the call fails.
    assert.ok(!core.includes('app_screenshot'), 'core prompt must not name the tool');
    assert.ok(!/screenshot/i.test(core), 'core prompt must not hint at screenshots at all');
});

/**
 * The budget lives in builderTools.js (MAX_SCREENSHOTS_PER_TURN) and is TYPED
 * into the prompt, because importing it would put builderPrompt in a require
 * cycle with builderTools. This test is what keeps the two honest: raise the
 * cap without touching the prompt and the model is told the wrong number,
 * which is worse than no number at all — it plans its verification around a
 * budget it does not have.
 */
test('the screenshot budget in the prompt matches the tool that enforces it', () => {
    const { _test } = require('./builderTools');
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.match(
        full,
        new RegExp(`You get ${_test.MAX_SCREENSHOTS_PER_TURN} per turn`),
        `prompt must state the real cap (${_test.MAX_SCREENSHOTS_PER_TURN})`,
    );
});

/**
 * Raising the cap alone would just buy more of the same mistake. The session
 * that went wrong shot a broken screen, changed something, never re-shot it,
 * and reasoned onward from an image of the pre-fix app — so the prompt has to
 * teach the LOOP, not just the allowance.
 */
test('the screenshot step teaches before/after pairs, not just a number', () => {
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.match(full, /BEFORE\/AFTER PAIRS/, 'the pairing is the instruction');
    assert.match(full, /shoot it AGAIN and confirm/, 'the after-shot is explicit');
    assert.match(full, /A fix you never looked at is a guess/, 'the reason is stated');
    assert.match(full, /Never re-shoot a screen you have not changed/, 'and the waste is named');
    assert.match(full, /budget to SPEND, not a quota to hoard/, 'the framing is permissive, not rationing');
});

// ── renderDraftState ────────────────────────────────────────────────

test('renderDraftState without extras is byte-identical to the old single-arg call', () => {
    const def = defWithActions();
    const plain = renderDraftState(def);
    assert.strictEqual(renderDraftState(def, {}), plain, 'empty extras change nothing');
    assert.strictEqual(renderDraftState(def, undefined), plain);
    assert.ok(!plain.includes('\ndata:'), 'no data block without extras.dataModel');
});

test('renderDraftState data block: tables, fields, row counts, datasets, roles', () => {
    const def = defWithActions();
    const out = renderDraftState(def, EXTRAS);
    assert.ok(out.includes('data:'), 'data block present');
    assert.ok(out.includes('table tbl_task01 "Tasks" key=tasks rows=12 access=app'), out);
    assert.ok(out.includes('table tbl_ppl001 "People" key=people access=owner'), 'no rows= when the count is unknown');
    assert.ok(out.includes('title text required'), 'field line with flags');
    assert.ok(out.includes('status select options=[todo,done]'), 'select options listed');
    assert.ok(out.includes('owner relation →tbl_ppl001'), 'relation target shown');
    assert.ok(out.includes('datasets: ds_open001, ds_agg0001 "By status"'), 'dataset line handles ids and rows');
    assert.ok(out.includes('roles: admin, member (default=member)'), 'roles line with mapping default');
    // The block is a strict suffix: everything before it is the plain rendering.
    assert.ok(out.startsWith(renderDraftState(def)), 'data block appends, never rewrites');
});

test('renderDraftState with a null data model renders the empty-state line', () => {
    const out = renderDraftState(emptyDefinition('x'), { dataModel: null, datasets: [] });
    assert.ok(out.includes('data:'), 'block present for null model');
    assert.ok(out.includes('(no tables yet)'));
});

test('renderAction: sequence steps summary and open_modal target are visible', () => {
    const out = renderDraftState(defWithActions());
    assert.ok(/act_seq001 sequence steps\[4\]\{confirm → create_record\(tbl_task01\) → toast → navigate→scr_/.test(out), out);
    assert.ok(out.includes('act_mod001 open_modal →modal:cmp_modal1'), out);
});

// ── summariseApp ────────────────────────────────────────────────────

test('summariseApp: unchanged without extras, gains table/dataset counts with them', () => {
    const def = defWithActions();
    const plain = summariseApp(def);
    assert.strictEqual(summariseApp(def, {}), plain, 'empty extras change nothing');
    assert.ok(!plain.includes('table'), 'no data counts without extras');

    const withData = summariseApp(def, EXTRAS);
    assert.ok(withData.startsWith(plain), 'data counts append');
    assert.ok(withData.includes('2 tables'), withData);
    assert.ok(withData.includes('2 datasets'), withData);

    const oneTable = summariseApp(def, { dataModel: { tables: [DATA_MODEL.tables[0]] }, datasets: [] });
    assert.ok(oneTable.includes('1 table') && !oneTable.includes('1 tables'), oneTable);
    assert.ok(!oneTable.includes('dataset'), 'zero datasets stay silent');
});

// ── Few-shots ───────────────────────────────────────────────────────────────

test('every tool a few-shot demonstrates actually exists', () => {
    // A worked example that calls a tool we never shipped teaches the model to
    // make a call that always fails — worse than having no example.
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const { TOOL_SCHEMAS } = require('./builderTools/schemas');
    const known = new Set(TOOL_SCHEMAS.map((t) => t.function.name));

    for (const count of [1, 2, 3]) {
        for (const msg of buildFewShotMessages(count)) {
            for (const call of msg.tool_calls || []) {
                assert.ok(known.has(call.function.name), `few-shot (count=${count}) calls unknown tool ${call.function.name}`);
                assert.doesNotThrow(() => JSON.parse(call.function.arguments), `few-shot arguments must be valid JSON (${call.function.name})`);
            }
        }
    }
});

test('the first few-shot demonstrates the identity pick before any component exists', async () => {
    // The design doctrine says "pick an identity first"; the worked example
    // has to SHOW it, or the doctrine reads as optional prose. One preset +
    // one knob on top, before app_add_components.
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const messages = buildFewShotMessages(1);
    const calls = messages.flatMap((m) => m.tool_calls || []);
    const theme = calls.find((c) => c.function.name === 'app_set_theme');
    assert.ok(theme, 'shot 1 must call app_set_theme');
    const args = JSON.parse(theme.function.arguments);
    assert.ok(args.preset, 'the identity starts from a preset');
    assert.ok(args.font, 'and shows a single design knob adjusted on top');
    const names = calls.map((c) => c.function.name);
    assert.ok(
        names.indexOf('app_set_theme') < names.indexOf('app_add_components'),
        'the identity is picked before components are added',
    );

    // The taught tool result must be TRUE: run the real applySetTheme on a
    // fresh draft with the few-shot's exact arguments and compare. (Notably:
    // mono's navStyle "tabs" is the default, which canonicalize prunes — the
    // real result has no nav key, so the example must not invent one.)
    const { applyToolCall } = require('./builderTools');
    const { emptyDefinition } = require('./componentSpecs');
    const real = await applyToolCall('app_set_theme', args, { def: emptyDefinition('Lookup console') });
    const taught = JSON.parse(messages.find((m) => m.role === 'tool' && m.tool_call_id === theme.id).content);
    assert.deepStrictEqual(taught, real, 'the few-shot theme result mirrors the real tool output');
});

test('the second few-shot teaches the split layout and the aggregate binding', () => {
    // These are the two shapes a model will not infer from catalogue prose.
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const one = JSON.stringify(buildFewShotMessages(1));
    const two = JSON.stringify(buildFewShotMessages(2));

    // Tool arguments are themselves JSON strings, so the outer stringify
    // double-escapes every quote — match on the bare tokens.
    assert.ok(!one.includes('pane'), 'the compact single shot stays cheap');
    assert.ok(two.includes('pane'), 'the split layout is demonstrated');
    assert.ok(two.includes('fill'), 'section height fill demonstrated');
    assert.ok(two.includes('aggregate'), 'the aggregate binding is demonstrated');
    assert.ok(two.includes('refreshInterval'), 'the live-refresh setting is demonstrated');
});

// ── The constraints section ─────────────────────────────────────────
//
// "What will bite you" is the list of platform behaviours that are not
// guessable from the catalog and that fail SILENTLY — a filter formula reading
// a root it may not read, an aggregate without its `pick` lens, a fill section
// stretching only its first row. It exists because every one of them has
// produced an app that validated clean and did nothing.

test('both toolsets carry the constraints section', () => {
    for (const toolset of ['core', 'full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.ok(p.includes('What will bite you'), `${toolset} prompt lost the constraints`);
        // Spot-check the ones that cost the most to rediscover — the rules the
        // recorded traces show being violated are on BOTH prompts.
        assert.match(p, /NO JOINS/);
        assert.match(p, /currentUser \/ vars \/ forms \/ screen \/ today/);
        assert.match(p, /pick: \{row:"first"/);
        assert.match(p, /selectable:"none"/);
        assert.match(p, /\{kind:"refresh", tableId\}/, 'every mutation needs a refresh');
        assert.match(p, /No onError, no onSuccess/, 'a sequence takes only steps');
        assert.match(p, /vars\.filters/, 'filter_bar owns vars.filters');
    }
    // The layout traps (fill sections, per-type knobs, depth) are the full
    // prompt's: the core menu has no app_add_section and no exact sizing.
    assert.match(buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' }), /stretches its FIRST grid row only/);
});

/**
 * The constraints are about the PLATFORM, not about the tool menu — so they
 * must name no tool at all. That is what keeps one static block correct for
 * every toolset: a constraint that mentioned a tool would be an instruction a
 * small-model build could only fail, which is exactly the bug the
 * toolset-keyed troubleshooting line exists to avoid.
 */
test('the constraints section names no tool, so it is safe for every toolset', () => {
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    const start = full.indexOf('## What will bite you');
    const end = full.indexOf('## Troubleshooting');
    assert.ok(start !== -1 && end > start, 'the two sections must both be present, in order');
    const constraints = full.slice(start, end);
    assert.deepEqual(constraints.match(/\bapp_[a-z_]+/g), null, 'the constraints must not name a tool');
});

/**
 * The core prompt should never instruct a tool the core menu does not contain —
 * a small model told to call app_propose_plan cannot comply, and burns a turn
 * discovering that.
 *
 * It used to, for seven: the planning, template, variables and connector
 * paragraphs were written for the full 17-tool menu and never keyed to the
 * 10-tool one, so every small-model build was told to call things it did not
 * have. They are keyed now — which also makes the core prompt about a quarter
 * shorter, for exactly the models that benefit most from a short one. The data
 * tools are the one remaining mention and it is deliberate: that paragraph
 * conditions on them explicitly ("when ... are in your tool menu").
 */
test('the core prompt never instructs a tool the core menu lacks', () => {
    const { APP_CORE_TOOL_NAMES } = require('./builderModelProfiles');
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    const named = new Set(core.match(/\bapp_[a-z_]+/g) || []);
    // Named ON PURPOSE, inside a clause that checks the menu first.
    const CONDITIONAL = new Set([]);
    const leaked = [...named].filter((t) => !APP_CORE_TOOL_NAMES.has(t) && !CONDITIONAL.has(t));
    assert.deepEqual(leaked, [], 'a NEW tool the core build cannot call leaked into its prompt');
    // app_screenshot spelled out: it is documented in TWO full-only pieces
    // (the numbered step and the troubleshooting pairing), so a future edit
    // that un-keys either would leak it here first.
    assert.ok(!named.has('app_screenshot'), 'app_screenshot must stay out of the core prompt');
});

// ── Diagnosis discipline ────────────────────────────────────────────
//
// The most expensive builder failure on record was not a crash: one tile
// rendered an error, the builder inferred that live form binding was
// impossible in this runtime, and rebuilt a whole app around a Calculate
// button on that premise. The premise was false. This section exists so the
// next model reaches for the smallest experiment instead of the biggest
// theory — and says "I don't know" when it doesn't.

test('the full prompt carries the diagnosis doctrine; the core prompt keeps its two operative sentences', () => {
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.ok(full.includes('## Diagnosis discipline'), 'full prompt lost the diagnosis section');
    assert.match(full, /ISOLATE BEFORE YOU CONCLUDE/, 'the smallest-experiment rule');
    assert.match(full, /ONE FAILING COMPONENT IS EVIDENCE ABOUT THAT COMPONENT/, 'scope of the evidence');
    assert.match(full, /NEVER RESTRUCTURE A WORKING DESIGN ON A GUESS/, 'the redesign ban');
    assert.match(full, /A CLEAN CHECK IS NOT A RENDERED SCREEN/, 'valid != renders');
    assert.match(full, /SAY WHAT YOU DO NOT KNOW/, 'the honesty rule');
    // The concrete session is the evidence — an abstract rule reads as
    // boilerplate, and this one has to survive being skimmed.
    assert.match(full, /Calculate button/, 'the real misdiagnosis is narrated');
    // Full: valid-vs-rendered is concrete about which tool sees what.
    assert.match(full, /NEITHER has looked at a pixel/, 'full names dry-run and finalize as blind');
    assert.match(full, /Only `app_screenshot` sees the screen/, 'and names the one that is not');
    // Core (2026-09-17 diet): the section is dropped — a small model on an
    // 18-tool menu cannot run the experiments it prescribes — and the two
    // sentences it can act on ride the troubleshooting section instead.
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    assert.ok(!core.includes('## Diagnosis discipline'));
    assert.match(core, /One failing component is evidence about THAT component — fix it; never rebuild a working screen on a guess/);
    assert.match(core, /`_hints` mean what you sent was repaired/);
});

// ── The formula trap ────────────────────────────────────────────────

test('the constraints teach the first-frame NaN trap and that live binding works', () => {
    // This is the specific defect behind the misdiagnosis: a form publishes its
    // values one frame AFTER first paint, so bare arithmetic over
    // forms.<name>.<field> is NaN on frame 1 — and every whitelisted function
    // normalises that away while the operators do not.
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.match(full, /ONE FRAME AFTER the screen first paints/, 'the timing is stated');
    assert.match(full, /is NaN before the user has typed a character/, 'the consequence is stated');
    assert.match(full, /Live form binding itself WORKS/, 'the false conclusion is pre-empted');
    assert.match(full, /isEmpty\(forms\.f\.a\) \? 0 :/, 'the guard form is given');
    assert.match(full, /the ONE place it leaks/, 'operators-vs-functions asymmetry named');
    // Core: the guard rule in one bullet — the form and the reason.
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    assert.match(core, /GUARD arithmetic over forms\/vars: number\(\)\/round\(\) or isEmpty\(forms\.f\.a\) \? 0 :/);
    assert.match(core, /one frame after first paint/);
});

// ── The instrument (keypad) idiom ───────────────────────────────────
//
// Nothing in the prompt used to suggest an app could be anything but a form
// over records, so asked for a calculator the builder built a form with a
// Submit button. A calculator is a DISPLAY plus a GRID OF BUTTONS.

test('the full prompt teaches the instrument idiom with a buildable recipe; the core prompt says an instrument needs variables it cannot declare', () => {
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.ok(full.includes('## App shapes'), 'full prompt lost the instrument section');
    assert.match(full, /DISPLAY plus a GRID OF BUTTONS/, 'the shape is named');
    // The recipe has to be concrete enough to build from: the components,
    // the step kind, the grid arithmetic and the equals dispatch.
    assert.match(full, /style\.span 3 → FOUR across/, 'the 12-column keypad arithmetic');
    assert.match(full, /`set_variable` steps/, 'the step kind that drives it');
    assert.match(full, /switch` step on `vars\.op`/, 'how equals dispatches on the pending operator');
    assert.match(full, /concat\(vars\.entry, "7"\)/, 'the digit-append formula, verbatim');
    assert.match(full, /display \+ buttons \+ variables, not form \+ table/, 'the one-line generalisation');
    assert.match(full, /STATE = variables with app_set_variables/);
    // Core: app_set_variables is not on the menu, so the recipe is unbuildable
    // there — the prompt says so in one line instead of teaching 1.5k of it.
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    assert.ok(!core.includes('## App shapes'));
    assert.match(core, /An INSTRUMENT \(calculator, counter, timer\) needs app variables, which this menu cannot declare — tell the user plainly instead of building a form for it/);
});

test('troubleshooting adapts to the toolset instead of naming a missing instrument', () => {
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.ok(!core.includes('app_dry_run'), 'core has no dry-run tool to call');
    assert.ok(full.includes('app_dry_run'), 'full build must be told to use it per phase');
    assert.match(core, /re-read the draft state's data block/, 'core needs the manual equivalent');
});

// ── Node logic in the system prompt ─────────────────────────────────
//
// The catalog documents `computed`; the prompt has to make the model REACH for
// it. The failure it answers: a session put a running value on a component
// whose props are plain strings, found no binding-typed prop for it, and
// concluded that live binding was architecturally limited here. It is not —
// `computed` overrides any prop on any type — but nothing in the prompt said
// so, so the conclusion was the reasonable one from the evidence available.

test('both toolsets teach computed as the way to make any prop live', () => {
    for (const toolset of ['core', 'full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.match(p, /ANY PROP CAN BE LIVE/, `${toolset} prompt lost the computed bullet`);
        assert.match(p, /computed: \{ "<propKey>": \{kind:"formula",expr\} \}/, 'the exact shape is given');
        assert.match(p, /you have forgotten computed/, 'the wrong conclusion is named and pre-empted');
        assert.match(p, /node fields, NOT props/, 'where they go is stated');
        // Only tools BOTH menus have may be named here.
        assert.match(p, /app_add_components entry or with app_update_component/);
    }
    // The sibling fields ride along on the full prompt; the core schemas
    // prune enabledWhen/readOnly/visibleToRoles/validations, so the core
    // prompt names only the one gate its tools still declare — the prose
    // and the schema move in lockstep (schemasCore.js CORE_PRUNE).
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    for (const field of ['visibleWhen', 'enabledWhen', 'readOnly', 'visibleToRoles', 'validations']) assert.ok(full.includes(field), `full prompt names ${field}`);
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    assert.ok(core.includes('visibleWhen'), 'core prompt names visibleWhen');
    for (const field of ['enabledWhen', 'readOnly', 'visibleToRoles', 'validations']) assert.ok(!core.includes(field), `core prompt does not teach ${field} (pruned from its schemas)`);
    // …and the compact catalog the core prompt carries says the same.
    const coreWithCatalog = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });
    const nodeLogic = coreWithCatalog.slice(coreWithCatalog.indexOf('### Node logic'), coreWithCatalog.indexOf('### Actions'));
    assert.match(nodeLogic, /visibleWhen: true \| false/);
    for (const field of ['enabledWhen', 'readOnly', 'visibleToRoles', 'validations']) assert.ok(!nodeLogic.includes(field), `compact node logic does not teach ${field}`);
});

test('the constraints repeat that a plain-string prop is not a dead end', () => {
    const p = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.match(p, /is NOT a component that cannot show a live value/);
    // Still tool-free — the constraints block serves every toolset.
    const start = p.indexOf('## What will bite you');
    const end = p.indexOf('## Troubleshooting');
    assert.deepEqual(p.slice(start, end).match(/\bapp_[a-z_]+/g), null);
});

test('both toolsets teach the batch form of every mutating tool that has one', () => {
    const { MAX_BATCH_PATCHES_PER_CALL } = require('./builderTools/schemas');
    // The HEADING differs on purpose. app_add_components is the one batch that
    // nests, and a whole-screen nested call is what the small model drifts in
    // (measured 2026-09-16: a key that was not a key, an entry with no `type`,
    // nothing applied, and a one-component-at-a-time fallback that lost the
    // cards). So the core menu is told to send one card per call. The other
    // three batches are FLAT and do not drift, so both menus must still teach
    // them, with the cap and the partial-failure contract — that is what the
    // rest of this test guards, for both toolsets.
    const heading = { core: /ONE GROUP PER CALL/, full: /BATCH EVERYTHING/ };
    for (const toolset of ['core', 'full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.match(p, heading[toolset], `${toolset} prompt lost its batching step`);
        assert.match(p, /app_update_component takes `updates`, app_set_action takes `actions`, app_bind_action takes `bindings`/);
        assert.ok(p.includes(`up to ${MAX_BATCH_PATCHES_PER_CALL} `), 'the prompt states the cap the tools enforce');
        assert.match(p, /reported at its index in `failed` and the good ones still land/, 'partial failure is explained');
    }
});

// ── Advanced sizing doctrine ────────────────────────────────────────
//
// The catalog now teaches the four sizing knobs mechanically (which types have
// them, what the units are, when a pct height is rejected). The prompt has to
// teach the JUDGEMENT the catalog cannot: that the 12-column span is still the
// right answer for almost everything, and that the exact sizes exist for the
// handful of boxes a column count cannot express. A model handed a new knob and
// no policy reaches for it everywhere — which is how a fluid layout becomes a
// pile of pixel boxes that break on the next viewport.

test('the full prompt teaches spans first, with exact sizing as the narrow escape hatch; the core prompt forbids exact sizing outright', () => {
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    assert.match(core, /Layout is spans only\. Never widthMode\/px on this menu\./);
    assert.ok(!core.includes('SPANS FIRST'), 'the escape hatch is not taught to a menu told never to use it');
    for (const toolset of ['full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.match(p, /SPANS FIRST/, `${toolset} prompt lost the sizing policy`);
        assert.match(p, /the right answer for almost everything/, 'the default is stated as the default');
        // The knobs, named, so the policy is actionable rather than abstract —
        // and named EXHAUSTIVELY, derived from the spec, so a mode added to
        // componentSpecs cannot ship with the doctrine still listing the old
        // set. (The prompt is hand-written prose, not a rendered table, so this
        // assertion is what stands in for deriving it.)
        const { STYLE_KNOBS } = require('./componentSpecs');
        for (const knob of ['widthMode', 'heightMode']) {
            const escapes = STYLE_KNOBS[knob].values.filter((m) => m !== STYLE_KNOBS[knob].default);
            const named = escapes.map((m) => JSON.stringify(m)).join('/');
            assert.ok(p.includes(`style.${knob} ${named} +`), `${toolset}: the prompt names every ${knob} escape hatch (${named})`);
        }
        // The cases spans genuinely cannot express — concrete, because "when a
        // span cannot express it" alone is a judgement call a model will
        // resolve in favour of the new toy.
        assert.match(p, /240px/, 'the fixed-width rail case');
        assert.match(p, /square media tile/, 'the exact-aspect case');
        assert.match(p, /400px tall/, 'the exact-height panel case');
        assert.match(p, /"A bit narrower" is a span, not a pixel/, 'and the counter-case is drawn');
        // The composition rule: placement stays with the grid.
        assert.match(p, /span still decides WHERE the cell sits/);
    }
});

test('the full prompt carries the two sizing traps: px width on text, and pct height without a parent', () => {
    for (const toolset of ['full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        // The silent one. Nothing rejects a 300px heading; it just clips the
        // first translation that is longer than the author's sentence.
        assert.match(p, /NEVER put a fixed px WIDTH on anything that holds text/);
        assert.match(p, /clips someone else's longer translation/, 'the failure is named, not just forbidden');
        // The loud one — stated so the model designs around it instead of
        // meeting it as a validation error at finalize.
        assert.match(p, /A "pct" HEIGHT is rejected unless its parent has a real height/);
        assert.match(p, /never legal on a section/);
        assert.match(p, /say "vh" when you mean a share of the screen/, 'the alternative is given');
    }
});

test('the layout constraints teach the derived availability and the inert-value trap', () => {
    const p = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    const start = p.indexOf('## What will bite you');
    const end = p.indexOf('## Troubleshooting');
    const constraints = p.slice(start, end);
    // Availability follows the BASE knob — the same rule expandStyleKnobs
    // implements and the catalog states once.
    assert.match(constraints, /The exact-sizing pairs follow their BASE knob/);
    assert.match(constraints, /a `tab` takes neither, `tabs` takes the width pair only/);
    // A value whose mode is still the default is stored and does nothing.
    assert.match(constraints, /is INERT/);
    assert.match(constraints, /clearing the mode alone strands the number/);
    // Still tool-free: the constraints block is shared by every toolset.
    assert.deepEqual(constraints.match(/\bapp_[a-z_]+/g), null);
});

// A template placeholder shipped verbatim in the FULL prompt for a release:
// `homeScreenHow` was keyed for core and left as the literal string
// '${homeScreenHow}' on the other branch, so every capable model was told to
// "— ${homeScreenHow} or add screens with app_add_screen".
test('no unsubstituted template placeholder survives into either prompt', () => {
    for (const toolset of ['core', 'full']) {
        const p = buildSystemPrompt({ toolset, catalogText: 'CATALOG' });
        assert.deepEqual(p.match(/\$\{[A-Za-z_$][\w$]*\}/g), null, `${toolset} prompt carries a literal \${…} placeholder`);
    }
    assert.match(buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' }),
        /app_update_screen to rename \+ app_add_components into its section/,
        'the full prompt gets the fuller instruction its menu supports');
});

// ── The LINKED shot — the demo's own shape, byte-true ──────────────────────

test('few-shots are toolset-aware: core = form-save + linked (no app_add_section), full = lookup + split + linked', () => {
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const { APP_CORE_TOOL_NAMES } = require('./builderModelProfiles');
    const namesOf = (msgs) => msgs.flatMap((m) => (m.tool_calls || []).map((c) => c.function.name));
    const core = namesOf(buildFewShotMessages(3, { toolset: 'core' }));
    for (const n of core) assert.ok(APP_CORE_TOOL_NAMES.has(n), `core shot calls ${n}, which the core menu does not have`);
    assert.ok(core.includes('app_link_datatable') && core.includes('app_set_plan'), 'core sees the linked shot');
    assert.ok(core.includes('app_upsert_table') && core.includes('app_seed_records'), 'core sees the form-save shot (table first)');
    assert.ok(!core.includes('run_automation') && !JSON.stringify(buildFewShotMessages(3, { toolset: 'core' })).includes('inputMapping'), 'the lookup shot (inputMapping vocabulary) is full-only');
    assert.ok(!core.includes('app_add_section'), 'the split shot is not shown to a menu that cannot make its call');
    const full = namesOf(buildFewShotMessages(3, { toolset: 'full' }));
    assert.ok(full.includes('app_add_section') && full.includes('app_link_datatable'));
    assert.ok(!namesOf(buildFewShotMessages(1, { toolset: 'core' })).includes('app_link_datatable'), 'count caps the list');
    // Every tool result answers a call in the same shot (no dangling ids).
    for (const toolset of ['core', 'full']) {
        const msgs = buildFewShotMessages(3, { toolset });
        const callIds = new Set(msgs.flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
        for (const m of msgs) if (m.role === 'tool') assert.ok(callIds.has(m.tool_call_id), `tool result ${m.tool_call_id} answers no call`);
    }
});

test('every few-shot app_add_components call uses parentId and real component types', () => {
    // The split shot taught `sectionId` — a key resolveParent rejects — for
    // weeks; a shot that teaches a rejected call is worse than no shot.
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const { getSpec } = require('./componentSpecs');
    const walk = (list, at) => list.forEach((c, i) => {
        assert.ok(getSpec(c.type), `${at}[${i}]: unknown component type ${c.type}`);
        if (Array.isArray(c.children)) walk(c.children, `${at}[${i}].children`);
    });
    for (const m of buildFewShotMessages(3, { toolset: 'full' })) {
        for (const call of m.tool_calls || []) {
            if (call.function.name !== 'app_add_components') continue;
            const args = JSON.parse(call.function.arguments);
            assert.ok(typeof args.parentId === 'string' && args.parentId, `${call.id}: parentId required`);
            assert.ok(!('sectionId' in args), `${call.id}: sectionId is not the key`);
            walk(args.components, call.id);
        }
    }
});

test('the linked shot is byte-true: theme result, link result shape, and bindings that pass the guard against the linked fields', async () => {
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const msgs = buildFewShotMessages(2, { toolset: 'core' });
    const calls = msgs.flatMap((m) => m.tool_calls || []);
    const resultOf = (id) => JSON.parse(msgs.find((m) => m.role === 'tool' && m.tool_call_id === id).content);
    // Theme result = the real tool's output for the same arguments.
    const theme = calls.find((c) => c.id === 'ex_c3');
    const { applyToolCall } = require('./builderTools');
    const real = await applyToolCall('app_set_theme', JSON.parse(theme.function.arguments), { def: emptyDefinition('Orders dashboard') });
    assert.deepStrictEqual(resultOf('ex_c3'), real, 'the taught theme result mirrors the real tool output');
    // Link result shape = what applyLinkDatatable returns.
    const link = resultOf('ex_c4');
    assert.deepStrictEqual(Object.keys(link).sort(), ['_next', 'table']);
    assert.deepStrictEqual(Object.keys(link.table).sort(), ['fields', 'id', 'key', 'linked', 'name']);
    assert.deepStrictEqual(Object.keys(link.table.linked).sort(), ['kind', 'mode', 'rowCount']);
    // The add's bindings use ONLY the linked fields — the tool-time guard agrees.
    const { checkComponentDataRefs } = require('./builderTools/bindingGuard');
    const model = { tables: [{ id: link.table.id, key: link.table.key, name: link.table.name, source: { kind: 'datatable', datatableId: 'tbl_src', mode: 'read' }, fields: link.table.fields }] };
    const add = JSON.parse(calls.find((c) => c.id === 'ex_c5').function.arguments);
    assert.deepStrictEqual(checkComponentDataRefs(add.components, model).errors, []);
    // The plan rides the FIRST build call (bundle rule) and its echo has indices.
    const firstAssistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.some((c) => c.id === 'ex_c1'));
    assert.strictEqual(firstAssistant.tool_calls[0].function.name, 'app_set_plan');
    assert.ok(firstAssistant.tool_calls.length > 1, 'never alone');
    assert.deepStrictEqual(resultOf('ex_c1').todos[0], { i: 0, text: 'Name the app and pick a look', done: false });
    // No seeding anywhere in the LINKED shot (its calls are the ex_c* ids).
    assert.ok(!calls.some((c) => /^ex_c/.test(c.id) && (c.function.name === 'app_seed_records' || c.function.name === 'app_upsert_table')));
});

// ── The FORM_SAVE shot — the shape the 2026-09-13 trace never saw taught ───
// The core menu's first shot since that trace: a table created FIRST, a form
// whose inputs are read as form.<name> by a create_record step inside a
// sequence, the form's onSubmit wired. Every result is what the real builders
// return for these arguments (ids are sentinels), so the model learns shapes
// that exist.
test('the form-save shot is byte-true: theme, table (key derived from name), components, sequence action and bind all mirror the real tools', async () => {
    const { buildFewShotMessages } = require('./builderPrompt/fewShots');
    const { applyToolCall } = require('./builderTools');
    const { mergeTableOp } = require('./builderTools/dataTools');
    const { canonicalizeDataModel, emptyDataModel, migrationPlan } = require('./dataModel');
    const msgs = buildFewShotMessages(1, { toolset: 'core' });
    const calls = msgs.flatMap((m) => m.tool_calls || []);
    const argsOf = (id) => JSON.parse(calls.find((c) => c.id === id).function.arguments);
    const resultOf = (id) => JSON.parse(msgs.find((m) => m.role === 'tool' && m.tool_call_id === id).content);
    // Order: plan bundled with the first build call; the table BEFORE any component or action.
    const names = calls.map((c) => c.function.name);
    assert.strictEqual(names[0], 'app_set_plan');
    assert.ok(names.indexOf('app_upsert_table') < names.indexOf('app_add_components'), 'table first');
    assert.ok(names.indexOf('app_add_components') < names.indexOf('app_set_action'), 'components before the action that reads them');
    assert.ok(names.indexOf('app_set_action') < names.indexOf('app_bind_action'), 'action before its bind');
    assert.ok(!names.includes('app_add_section') && !names.includes('app_screenshot'), 'core-menu calls only');
    // Theme result = the real tool's output.
    const wrap = { def: emptyDefinition('Contact book'), dataModel: null, datasetIds: [], rowCounts: {} };
    assert.deepStrictEqual(resultOf('ex_d3'), await applyToolCall('app_set_theme', argsOf('ex_d3'), wrap));
    // Table: the real merge of the SAME arguments — key derived from the name, field keys and types, migration summary, hints.
    const merged = mergeTableOp(emptyDataModel(), argsOf('ex_d4'), {});
    assert.ok(!merged.error, JSON.stringify(merged));
    const { model } = canonicalizeDataModel(merged.model);
    const taught = resultOf('ex_d4');
    assert.strictEqual(taught.key, model.tables[0].key);
    assert.deepStrictEqual(taught.fields.map((f) => [f.key, f.type]), model.tables[0].fields.map((f) => [f.key, f.type]));
    assert.deepStrictEqual(Object.keys(taught).sort(), ['_hints', 'fields', 'key', 'migration', 'modelVersion', 'rowCount', 'tableId']);
    assert.deepStrictEqual(taught._hints, merged.hints);
    const plan = migrationPlan(emptyDataModel(), model).map((s) => String(s).replace(/tbl_[a-z0-9]{6}/g, 'tbl_cont01'));
    assert.strictEqual(taught.migration, plan.slice(0, 8).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 80)).join('; '));
    // Re-key the taught table into the model so the later calls resolve against it.
    model.tables[0].id = 'tbl_cont01';
    model.tables[0].fields.forEach((f, i) => { f.id = taught.fields[i].fieldId; });
    wrap.dataModel = model;
    // Screen, then the batch: same added types in the same order, the tempId map, no repair notes.
    const screen = await applyToolCall('app_add_screen', argsOf('ex_d6'), wrap);
    const add = await applyToolCall('app_add_components', { ...argsOf('ex_d7'), parentId: screen.sectionId }, wrap);
    assert.ok(!add.error, JSON.stringify(add));
    assert.deepStrictEqual(add.added.map((a) => a.type), resultOf('ex_d7').added.map((a) => a.type));
    assert.deepStrictEqual(Object.keys(add.ids), ['frm']);
    assert.strictEqual(add._hints, undefined, 'a clean entry: the shot must not teach a shape the normaliser has to repair');
    // The action: created as authored (a sequence: create_record with form.<name>, reset, refresh, toast).
    const action = await applyToolCall('app_set_action', argsOf('ex_d8'), wrap);
    assert.ok(!action.error, JSON.stringify(action));
    assert.deepStrictEqual(action.action, resultOf('ex_d8').action);
    assert.deepStrictEqual(Object.keys(action).sort(), Object.keys(resultOf('ex_d8')).sort());
    // The bind: nodeId (not componentId), onSubmit, the action id.
    const bind = await applyToolCall('app_bind_action', { nodeId: add.ids.frm, event: 'onSubmit', actionId: action.actionId }, wrap);
    assert.deepStrictEqual(Object.keys(bind).sort(), Object.keys(resultOf('ex_d9')).sort());
    assert.strictEqual(argsOf('ex_d9').event, 'onSubmit');
    assert.ok('nodeId' in argsOf('ex_d9') && !('componentId' in argsOf('ex_d9')));
    // Seed result shape and the values vocabulary the shot teaches.
    assert.deepStrictEqual(Object.keys(resultOf('ex_d5')).sort(), ['ids', 'inserted', 'rowCount', 'tableId']);
    const shot = JSON.stringify(msgs);
    assert.ok(shot.includes('form.name') && !shot.includes('inputMapping') && !shot.includes('"kind":"field"'), 'teaches form.<name>, never the run_automation vocabulary');
});

// ── The core (small-band) prompt — 2026-09-17 diet ─────────────────────
//
// Measured on the demo box before the diet: 76.8k chars ≈ 19.2k tokens of
// system prompt, 40 % of it the component catalog, read before the user's
// first word on every new session. The core prompt is its own text
// (builderPrompt/corePrompt.js) over the compact catalog; these tests pin
// the budget, the menu discipline and the rules the diet must not lose.

/**
 * Measured 33_542 at introduction; the ceiling is the whole core system prompt.
 * Raised to 34_100 when redact_pdf landed at 34_034: every step kind is listed
 * three times (the Kinds enum, the [SERVER] line, "Other step kinds"), so a new
 * kind costs ~40 chars by construction, and the headroom was already spent.
 * The next raise should come with a diet of the core prose instead.
 */
const CORE_PROMPT_CHAR_CEILING = 34_100;

test(`the core system prompt with the compact catalog stays under ${CORE_PROMPT_CHAR_CEILING} chars`, () => {
    const core = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });
    assert.ok(core.length < CORE_PROMPT_CHAR_CEILING, `core prompt is ${core.length} chars`);
    assert.ok(core.includes(renderCompactCatalogText()), 'catalogMode filtered puts the compact catalog in');
    assert.ok(!core.includes('### Theme (app_set_theme)'), 'and not the full one');
    assert.ok(core.length < buildSystemPrompt({ toolset: 'full' }).length / 2, 'less than half the full prompt');
    // The default catalogMode is the full catalog, on both toolsets.
    assert.ok(buildSystemPrompt({ toolset: 'core' }).includes(renderCatalogText()));
    assert.ok(buildSystemPrompt({ toolset: 'full', catalogMode: 'filtered' }).includes(renderCompactCatalogText()), 'the full prompt honours catalogMode too');
});

test('the core prompt (with its real catalog) names no tool off the core menu', () => {
    const { APP_CORE_TOOL_NAMES } = require('./builderModelProfiles');
    const core = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });
    const named = [...new Set(core.match(/\bapp_[a-z_]+/g) || [])];
    assert.deepEqual(named.filter((t) => !APP_CORE_TOOL_NAMES.has(t)), [], 'an off-menu tool leaked into the core prompt or its catalog');
    // And every mutating tool on the menu is at least mentioned — a tool the
    // prompt never names is one a small model never reaches for.
    for (const t of ['app_set_meta', 'app_set_theme', 'app_add_screen', 'app_add_components', 'app_update_component', 'app_set_action', 'app_bind_action', 'app_link_datatable', 'app_upsert_table', 'app_seed_records', 'app_query_data', 'app_set_plan', 'app_finalize', 'app_inspect_catalog', 'app_read_document']) {
        assert.ok(named.includes(t), `${t} is named in the core prompt`);
    }
});

test('the core prompt teaches naming in the first call group (NAME IT NOW)', () => {
    const core = buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' });
    const rule1 = core.split('\n').find((l) => l.startsWith('1. '));
    assert.match(rule1, /FIRST CALL GROUP on a new app, in one reply: app_set_plan \{todos\} \+ app_set_meta \{name, description, icon\} \+ app_set_theme \{preset\}/);
    assert.match(rule1, /NAME IT NOW/);
    assert.match(rule1, /in the user's own language, 2–4 words, ≤ 40 characters/);
    assert.match(rule1, /A draft still called "Untitled app" at finalize is a mistake/);
    assert.match(rule1, /`icon` one of LayoutGrid, ClipboardList/);
    // The tool's own description says the same, so the two cannot disagree.
    const { TOOL_SCHEMAS } = require('./builderTools/schemas');
    const meta = TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_meta');
    assert.match(meta.function.description, /Call it in your FIRST call group on a new app, with app_set_plan and app_set_theme/);
    assert.match(meta.function.description, /2–4 words, ≤ 40 chars/);
});

test('the owner context note renders automations and documents, their empty states, and caps the automation list', () => {
    const automations = [
        { id: 'auto_b', title: 'Send invoice', isActive: true, trigger: 'agent_call', params: ['customer', 'amount'], description: 'Mails it' },
        { id: 'auto_a', title: 'Nightly sync', isActive: false, trigger: 'schedule' },
    ];
    const docs = [{ documentId: 'doc_1', name: 'Invoice', docType: 'invoice', placeholders: [{ key: 'lines', kind: 'list', fields: ['qty', 'desc'] }, { key: 'note', kind: 'condition' }] }];
    const note = renderOwnerContextNote(automations, docs);
    assert.ok(note.startsWith(`${OWNER_CONTEXT_PREFIX}\n`), 'framed as machine-generated');
    assert.match(note, /Automations \(wire via run_automation with these exact ids\):\n- auto_a — "Nightly sync" \[inactive\] trigger:schedule\n- auto_b — "Send invoice" \[active\] trigger:agent_call params: customer, amount — Mails it/, 'sorted by id, one line each');
    assert.match(note, /Documents \(fill via a fill_document step\):\n.*\n- doc_1 — "Invoice" \[invoice\] fills: lines \(list of qty, desc\), note \(only if set\)/);
    // Empty states say what that means for the build.
    const empty = renderOwnerContextNote([], []);
    assert.match(empty, /\(none — the owner has no automations yet; a run_automation action may ship with automationId:null/);
    assert.match(empty, /\(none — the owner has no designed documents, so a fill_document step cannot be built\)/);
    // The cap: 40 lines, then a tail that says how to get the rest.
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `auto_${String(i).padStart(2, '0')}`, title: `R${i}`, isActive: true, trigger: 'manual' }));
    const capped = renderOwnerContextNote(many, []);
    assert.equal((capped.match(/^- auto_/gm) || []).length, 40);
    assert.match(capped, /\(5 more — name the automation you mean and I will find it\)/);
    assert.ok(renderOwnerContextNote(many, [], { maxAutomations: 45 }).includes('- auto_44'));
});

test('the system prompt is identical for two users with different automations — the difference rides the note', () => {
    const a = [{ id: 'auto_1', title: 'Alpha', isActive: true, trigger: 'manual' }];
    const b = [{ id: 'auto_2', title: 'Beta', isActive: true, trigger: 'webhook' }];
    assert.notEqual(renderOwnerContextNote(a, []), renderOwnerContextNote(b, []));
    // Nothing per user reaches the prompt: the same call, the same bytes.
    assert.equal(buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' }), buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' }));
    assert.equal(buildSystemPrompt({ toolset: 'full' }), buildSystemPrompt({ toolset: 'full' }));
    // The full prompt's owner sections point at the note when the caller
    // sends one (the route, ownerContext 'note'); a legacy caller that still
    // passes a list is honoured, and the prompt never says "listed below"
    // while pointing at the note.
    const full = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG', ownerContext: 'note' });
    assert.match(full, /## Automations \(the app owner's automations — wire via run_automation\)\n\n_\(the owner's automations are listed in the OWNER CONTEXT note of the user message/);
    assert.match(full, /## Documents \(the owner's designs — fill via a fill_document step\)/);
    assert.match(full, /_\(the owner's designed documents are listed in the OWNER CONTEXT note/);
    assert.match(full, /^- The owner's automations ride the OWNER CONTEXT note of the user message\. Call `app_list_automations`/m);
    assert.ok(!full.includes('listed below'), 'no "below" when nothing is below');
    const legacy = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG', automationsText: '- auto_1 — "Alpha" [active] trigger:manual' });
    assert.ok(legacy.includes('- auto_1 — "Alpha" [active] trigger:manual'));
    assert.match(legacy, /^- The owner's automations are listed below\. Call `app_list_automations`/m);
    assert.ok(!legacy.includes('OWNER CONTEXT'));
    // A caller that sends no note (the default — the MCP guide, read by an
    // agent that has the list tools) is told to call them, and never hears
    // of a note it will not receive.
    const viaTools = buildSystemPrompt({ toolset: 'full', catalogText: 'CATALOG' });
    assert.ok(!viaTools.includes('OWNER CONTEXT'), 'no note pointer without a note');
    assert.match(viaTools, /## Automations \(the app owner's automations — wire via run_automation\)\n\n_\(call `app_list_automations` for the owner's automations/);
    assert.match(viaTools, /_\(call `app_search_documents` for the owner's designed documents and `app_read_document` before filling one/);
    assert.match(viaTools, /^- The owner's automations are not in this prompt: call `app_list_automations` for the list/m);
    assert.notEqual(viaTools, full);
    // The core prompt ignores the legacy lists entirely.
    assert.equal(buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG', automationsText: 'x' }), buildSystemPrompt({ toolset: 'core', catalogText: 'CATALOG' }));
});

test('the draft state says NOT NAMED YET on its first line while the app is Untitled', () => {
    const untitled = renderDraftState(emptyDefinition());
    assert.match(untitled.split('\n')[0], /^app "Untitled app" icon=\w+ — NOT NAMED YET: call app_set_meta$/);
    const named = renderDraftState(emptyDefinition('Facturen'));
    assert.match(named.split('\n')[0], /^app "Facturen" icon=\w+$/);
    assert.ok(!named.includes('NOT NAMED YET'));
});

test('the data block\'s linked line carries the facts only; the doctrine lives in the prompt', () => {
    const { renderDataBlock } = require('./builderPrompt');
    const model = { tables: [{ id: 'tbl_l1', key: 'facturen', name: 'Facturen', source: { kind: 'datatable', datatableId: 'dt_1', mode: 'read' }, fields: [{ key: 'excl_btw', type: 'number' }], access: { default: 'app' } }] };
    const linked = new Map([['tbl_l1', { managedKind: 'nextcloud', mode: 'read' }]]);
    const block = renderDataBlock(model, [], { tbl_l1: 57 }, linked);
    const line = block.split('\n').find((l) => l.startsWith('  table tbl_l1'));
    assert.match(line, / linked=(nextcloud|studio) mode=read$/, line);
    assert.ok(!block.includes('never app_seed_records'), 'the per-table doctrine sentence is gone');
    // MISSING keeps its sentence: that one is an instruction, not doctrine.
    const missing = renderDataBlock(model, [], {}, new Map([['tbl_l1', { missing: true }]]));
    assert.match(missing, /linked=MISSING \(the Studio table is gone — re-link with app_link_datatable or remove this table\)/);
});
