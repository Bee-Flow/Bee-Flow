/**
 * componentSpecs.js — the schema contract itself. These tests pin the v2
 * surface (versions, limits, new types/kinds) and assert the spec tables are
 * internally consistent so canonicalize/validate (which are spec-driven) and
 * the FE mirrors can rely on them.
 *
 * Run: node --test appStudio/componentSpecs.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');

const {
    SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSIONS_ACCEPTED,
    LIMITS,
    BINDING_KINDS,
    FORMULA_SCOPE_ROOTS,
    ACTION_KINDS,
    ACTION_SPECS,
    CREATE_RECORD_FIELDS,
    STEP_KINDS,
    STEP_SPECS,
    CLIENT_STEP_KINDS,
    DATA_MUTATING_STEP_KINDS,
    EVENT_NAMES,
    COMPONENT_SPECS,
    COMPONENT_TYPES,
    CONTAINER_TYPES,
    INPUT_TYPES,
    STYLE_KNOBS,
    buildCatalog,
    emptyDefinition,
    getSpec,
} = specs;

// ── Version + limits ────────────────────────────────────────────────────────

test('schema version is 2 and both 1 and 2 are accepted', () => {
    assert.equal(SCHEMA_VERSION_CURRENT, 2);
    assert.deepEqual(SCHEMA_VERSIONS_ACCEPTED, [1, 2]);
});

test('v2 limits are present with the contracted values', () => {
    assert.equal(LIMITS.MAX_DEPTH, 6);
    assert.equal(LIMITS.MAX_FORMULA_LEN, 2000);
    assert.equal(LIMITS.MAX_VALIDATIONS_PER_FIELD, 10);
    assert.equal(LIMITS.MAX_ACTION_STEPS, 60);
    // Deliberately equal to MAX_DEPTH: one answer to "how deeply may things
    // nest", for components and action branches alike.
    assert.equal(LIMITS.MAX_ACTION_DEPTH, 6);
    assert.equal(LIMITS.MAX_ACTION_DEPTH, LIMITS.MAX_DEPTH);
    assert.equal(LIMITS.MAX_ACTION_LOOP_ITERATIONS, 200);
});

// ── Bindings / formula scope ────────────────────────────────────────────────

test('binding kinds add the v2 data kinds on top of v1', () => {
    // `aggregate` reuses the server's existing compileAggregate descriptor, so
    // it adds a binding kind without adding a second query vocabulary.
    assert.deepEqual(BINDING_KINDS, ['static', 'actionResult', 'formula', 'record', 'records', 'dataset', 'connector', 'aggregate']);
});

test('formula scope roots include every documented root', () => {
    for (const r of ['actions', 'form', 'forms', 'screen', 'vars', 'item', 'index', 'value', 'currentUser', 'records', 'datasets', 'connectors', 'now', 'today']) {
        assert.ok(FORMULA_SCOPE_ROOTS.includes(r), `missing scope root ${r}`);
    }
});

// ── Component catalog ───────────────────────────────────────────────────────

test('catalog grew from 19 (v1) to 53 types, all earlier types retained', () => {
    assert.equal(COMPONENT_TYPES.length, 53); // +input_dataset, +browser_view, +approval_list, +input_html (HTML mail editor)
    const v1 = ['heading', 'text', 'button', 'image', 'divider', 'spacer', 'callout', 'stat', 'keyValue', 'table', 'list', 'card', 'form', 'input_text', 'input_textarea', 'input_number', 'input_select', 'input_checkbox', 'input_date'];
    for (const t of v1) assert.ok(COMPONENT_TYPES.includes(t), `dropped v1 type ${t}`);
    for (const t of ['data_grid', 'chart', 'pivot', 'input_file', 'input_richtext', 'input_html', 'input_datetime', 'input_relation', 'input_person', 'input_multiselect', 'tabs', 'tab', 'modal', 'repeater']) {
        assert.ok(COMPONENT_TYPES.includes(t), `missing v2 type ${t}`);
    }
    for (const t of ['container', 'page_header', 'markdown', 'badge_list', 'progress', 'timeline', 'record_detail', 'filter_bar', 'kanban', 'calendar']) {
        assert.ok(COMPONENT_TYPES.includes(t), `missing v2.1 type ${t}`);
    }
    assert.ok(COMPONENT_TYPES.includes('ai_chat'), 'missing AI type ai_chat');
    // pane: the flex stack that makes a full-height sidebar/detail split
    // expressible — the one shape the 12-column grid alone cannot describe.
    assert.ok(COMPONENT_TYPES.includes('pane'), 'missing layout type pane');
    // message_thread: per-row appearance driven by a field, which `computed`
    // (props-only) cannot express — the reason a repeater is not enough.
    assert.ok(COMPONENT_TYPES.includes('message_thread'), 'missing data type message_thread');
    // file_preview: a file column holds whatever arrived, and until now the only
    // thing an app could do with it was hand out a download link.
    assert.ok(COMPONENT_TYPES.includes('file_preview'), 'missing content type file_preview');
    // v3: a workflow's stages, attachments as cards, and the state of the
    // connector feeding the app — the three things every mature app drew by
    // hand out of a list, a grid and a hope.
    for (const t of ['stepper', 'file_gallery', 'connector_status']) {
        assert.ok(COMPONENT_TYPES.includes(t), `missing v3 type ${t}`);
    }
});

test('new containers and inputs are classified correctly', () => {
    for (const t of ['tabs', 'tab', 'modal', 'repeater']) assert.ok(CONTAINER_TYPES.includes(t), `${t} should be a container`);
    for (const t of ['input_file', 'input_richtext', 'input_datetime', 'input_relation', 'input_multiselect']) assert.ok(INPUT_TYPES.includes(t), `${t} should be an input`);
    // data_grid carries the new row events
    assert.deepEqual(COMPONENT_SPECS.data_grid.events, ['onRowClick', 'onRowSelect']);
});

test('every component spec is internally consistent', () => {
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        assert.equal(typeof spec.label, 'string', `${type} label`);
        assert.equal(typeof spec.description, 'string', `${type} description`);
        assert.ok(spec.props && typeof spec.props === 'object', `${type} props`);
        assert.ok(Array.isArray(spec.styleKnobs), `${type} styleKnobs`);
        for (const knob of spec.styleKnobs) assert.ok(knob in STYLE_KNOBS, `${type} unknown style knob ${knob}`);
        // defaultStyle keys must be among the type's allowed knobs
        for (const k of Object.keys(spec.defaultStyle || {})) assert.ok(spec.styleKnobs.includes(k), `${type} defaultStyle.${k} not an allowed knob`);
        // declared events must be in the global event vocabulary
        for (const ev of spec.events || []) assert.ok(EVENT_NAMES.includes(ev), `${type} unknown event ${ev}`);
        // list/stringList item shapes carry a maxItems ceiling
        for (const [pk, fs] of Object.entries(spec.props)) {
            if (fs.type === 'list') assert.ok(typeof fs.maxItems === 'number', `${type}.${pk} list needs maxItems`);
        }
    }
});

test('stat was extended additively (v1 props still present)', () => {
    const p = COMPONENT_SPECS.stat.props;
    for (const k of ['label', 'value', 'caption', 'icon']) assert.ok(k in p, `stat lost v1 prop ${k}`);
    for (const k of ['delta', 'deltaFormat', 'trend', 'positiveIsGood']) assert.ok(k in p, `stat missing v2 prop ${k}`);
});

// ── Actions / steps ─────────────────────────────────────────────────────────

test('action kinds add open_modal/close_modal, sequence, the native AI actions and create_record', () => {
    assert.deepEqual(ACTION_KINDS, ['run_automation', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'create_record', 'navigate', 'toast', 'open_url', 'open_modal', 'close_modal', 'sequence']);
});

// "Add a row" is one of the four things a button most often does, so it is a
// top-level action as well as a sequence step. The two field tables are the
// SAME object — a field added to one and forgotten on the other is a field
// canonicalize would silently drop from every bare create_record action.
test('create_record is an action AND a step, off one shared field table', () => {
    assert.ok(ACTION_KINDS.includes('create_record'));
    assert.ok(STEP_KINDS.includes('create_record'));
    assert.equal(ACTION_SPECS.create_record.fields, STEP_SPECS.create_record.fields);
    assert.equal(ACTION_SPECS.create_record.fields, CREATE_RECORD_FIELDS);
    // It writes rows, so it stays on the server side of the partition.
    assert.ok(DATA_MUTATING_STEP_KINDS.includes('create_record'));
});

test('step kinds are partitioned into client-only and data-mutating', () => {
    // send_email belongs on the server side: it runs under a real mailbox
    // credential and has an outward-facing side effect. A client-executed
    // variant would mean trusting the browser with the recipient. The file
    // steps sit beside it: generate_file writes bytes into the owner's storage
    // envelope and file_intake pulls provider bytes into it.
    // dataset_query sits with them: it READS the owner's dataset artifacts
    // (server-side ranged I/O) and may write rows via writeTo — server by
    // definition, like kb_query (also read-shaped) already is. ai_browse runs
    // a headless-browser agent acts-as-owner: server, and on its own streaming
    // endpoint.
    // fill_document sits with generate_file for the same reason and one more:
    // it reads a document belonging to the app's OWNER, which a browser must
    // never be the one to name.
    // request_approval sits with them: it creates a durable approval record
    // (a data write with a notification side effect), acts-as-owner like
    // every record write — server by definition.
    assert.deepEqual(DATA_MUTATING_STEP_KINDS, ['run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse']);
    // …and none of the new file/dataset/browse steps is a bare v1 ACTION kind —
    // they are sequence steps only, which is what keeps the v1 action editors untouched.
    assert.ok(!ACTION_KINDS.includes('generate_file'));
    assert.ok(!ACTION_KINDS.includes('fill_document'));
    assert.ok(!ACTION_KINDS.includes('generate_presentation'));
    assert.ok(!ACTION_KINDS.includes('file_intake'));
    assert.ok(!ACTION_KINDS.includes('dataset_query'));
    assert.ok(!ACTION_KINDS.includes('ai_browse'));
    assert.ok(!ACTION_KINDS.includes('request_approval'));
    // the partition is a total, disjoint cover of STEP_KINDS
    assert.equal(new Set([...CLIENT_STEP_KINDS, ...DATA_MUTATING_STEP_KINDS]).size, STEP_KINDS.length);
    for (const k of CLIENT_STEP_KINDS) assert.ok(!DATA_MUTATING_STEP_KINDS.includes(k), `${k} cannot be both`);
    // every data-mutating step spec is tagged mutatesData:true; client ones false
    for (const k of STEP_KINDS) {
        assert.equal(STEP_SPECS[k].mutatesData, DATA_MUTATING_STEP_KINDS.includes(k), `${k} mutatesData tag mismatch`);
    }
});

test('every step spec has a fields table', () => {
    for (const k of STEP_KINDS) {
        assert.ok(STEP_SPECS[k] && STEP_SPECS[k].fields && typeof STEP_SPECS[k].fields === 'object', `${k} missing fields`);
    }
});

// ── Serialized catalog + empty def ──────────────────────────────────────────

test('buildCatalog is JSON-serializable and advertises v2', () => {
    const cat = buildCatalog();
    assert.equal(cat.schemaVersion, 2);
    assert.deepEqual(cat.acceptedSchemaVersions, [1, 2]);
    assert.deepEqual(cat.events, EVENT_NAMES);
    assert.ok(cat.actions.stepKinds && cat.actions.stepSpecs, 'catalog exposes step schema');
    assert.deepEqual(cat.bindings.formulaScopeRoots, FORMULA_SCOPE_ROOTS);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(cat)));
    assert.equal(Object.keys(cat.components).length, COMPONENT_TYPES.length);
});

test('emptyDefinition is a valid v2 app (roles seeded) and canonicalizes clean', () => {
    const def = emptyDefinition('Fresh');
    assert.equal(def.schemaVersion, 2);
    assert.deepEqual(def.roles, []);
    const { def: canon, repairs } = canonicalizeAppDefinition(def);
    assert.deepEqual(repairs, []);
    assert.equal(validateAppDefinition(canon).ok, true);
});

test('getSpec resolves known types and returns null otherwise', () => {
    assert.equal(getSpec('data_grid'), COMPONENT_SPECS.data_grid);
    assert.equal(getSpec('nope'), null);
});

test('Object.prototype keys are not component types (constructor/__proto__/toString)', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        assert.equal(getSpec(type), null, `${type} must not resolve to a spec`);
        assert.ok(!COMPONENT_TYPES.includes(type));
    }
    // …and such a node is REJECTED as an unknown type, never crashing the pipeline.
    const def = emptyDefinition('proto pollution');
    def.screens[0].sections[0].children = [{ id: 'cmp_proto1', type: 'constructor', props: { text: 'x' } }];
    const { def: canon } = canonicalizeAppDefinition(def);
    const res = validateAppDefinition(canon);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === 'node.unknown_type'), JSON.stringify(res.errors));
});

// ── v2.1 catalog batch (Wave 2B — additive on schema v2) ────────────────────

const V21_TYPES = ['container', 'page_header', 'markdown', 'badge_list', 'progress', 'timeline', 'record_detail', 'filter_bar', 'kanban', 'calendar'];

test('v2.1 limits and event additions are present', () => {
    assert.equal(LIMITS.MAX_KANBAN_COLUMNS, 12);
    assert.equal(LIMITS.MAX_RECORD_DETAIL_FIELDS, 30);
    assert.equal(LIMITS.MAX_FILTER_BAR_FIELDS, 8);
    // onChange lets a discrete input apply immediately — a triage bar rather
    // than a row of dropdowns behind a Save button. Text inputs deliberately
    // do NOT declare it: that would run an action per keystroke.
    // onDecided (v2 approvals): approval_list fires it after a decision lands.
    assert.deepEqual(EVENT_NAMES, ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided']);
    for (const t of ['input_select', 'input_checkbox', 'input_date', 'input_multiselect']) {
        assert.deepEqual(COMPONENT_SPECS[t].events, ['onChange'], `${t} applies on change`);
    }
    for (const t of ['input_text', 'input_textarea', 'input_richtext', 'input_number']) {
        assert.ok(!COMPONENT_SPECS[t].events, `${t} must not fire per keystroke`);
    }
});

test('v2.1 types are classified and evented correctly', () => {
    for (const t of ['container', 'page_header']) assert.ok(CONTAINER_TYPES.includes(t), `${t} should be a container`);
    for (const t of ['markdown', 'badge_list', 'progress', 'timeline', 'record_detail', 'filter_bar', 'kanban', 'calendar']) {
        assert.ok(!CONTAINER_TYPES.includes(t), `${t} should not be a container`);
        assert.ok(!INPUT_TYPES.includes(t), `${t} should not be an input`);
    }
    assert.deepEqual(COMPONENT_SPECS.kanban.events, ['onRowClick', 'onCardMove']);
    assert.deepEqual(COMPONENT_SPECS.timeline.events, ['onRowClick']);
    assert.deepEqual(COMPONENT_SPECS.calendar.events, ['onRowClick']);
    assert.equal(COMPONENT_SPECS.kanban.props.columns.maxItems, LIMITS.MAX_KANBAN_COLUMNS);
    assert.equal(COMPONENT_SPECS.filter_bar.props.fields.maxItems, LIMITS.MAX_FILTER_BAR_FIELDS);
    assert.equal(COMPONENT_SPECS.record_detail.props.fields.maxItems, LIMITS.MAX_RECORD_DETAIL_FIELDS);
});

test('a definition using every v2.1 type with spec defaults canonicalizes and validates clean', () => {
    // Build one node per new type: no props (canonicalize fills spec defaults),
    // containers get an empty children array.
    const def = emptyDefinition('v2.1 smoke');
    def.screens[0].sections[0].children = V21_TYPES.map((type, i) => {
        const node = { id: `cmp_v21x${i}`, type, props: {} };
        if (COMPONENT_SPECS[type].container) node.children = [];
        return node;
    });
    const { def: canon, repairs } = canonicalizeAppDefinition(def);
    // Only defaults are filled — nothing should be dropped or rewritten.
    for (const r of repairs) {
        assert.ok(['props.defaulted', 'section.style_defaulted'].includes(r.code), `unexpected repair ${r.code} at ${r.path}: ${r.message}`);
    }
    const res = validateAppDefinition(canon);
    assert.deepEqual(res.errors, [], JSON.stringify(res.errors, null, 2));
    assert.equal(res.ok, true);
    // The canonical nodes carry every spec prop with its default.
    const byType = new Map(canon.screens[0].sections[0].children.map((n) => [n.type, n]));
    for (const type of V21_TYPES) {
        const node = byType.get(type);
        assert.ok(node, `canonicalize dropped ${type}`);
        for (const [key, fs] of Object.entries(COMPONENT_SPECS[type].props)) {
            assert.deepEqual(node.props[key], fs.default === undefined ? null : fs.default, `${type}.props.${key} default`);
        }
    }
});

test('kanban onCardMove wiring survives canonicalize and validates against the event vocabulary', () => {
    const def = emptyDefinition('kanban events');
    def.actions = { act_move01: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Moved' }] } };
    def.screens[0].sections[0].children = [{
        id: 'cmp_kanban', type: 'kanban', props: {}, onCardMove: 'act_move01', onRowClick: 'act_move01',
    }];
    const { def: canon } = canonicalizeAppDefinition(def);
    const node = canon.screens[0].sections[0].children[0];
    assert.equal(node.onCardMove, 'act_move01');
    assert.equal(node.onRowClick, 'act_move01');
    const res = validateAppDefinition(canon);
    assert.deepEqual(res.errors, [], JSON.stringify(res.errors, null, 2));

    // …and a type that does NOT support onCardMove is flagged.
    const bad = emptyDefinition('bad events');
    bad.actions = { act_move01: { kind: 'toast', message: 'x' } };
    bad.screens[0].sections[0].children = [{ id: 'cmp_headin', type: 'heading', props: { text: 'T' }, onCardMove: 'act_move01' }];
    const { def: badCanon } = canonicalizeAppDefinition(bad);
    const badRes = validateAppDefinition(badCanon);
    assert.ok(badRes.errors.some((e) => e.code === 'event.not_supported'), 'heading.onCardMove should be rejected');
});

// ── The look pass (v2.2 — visual variants, additive) ────────────────────────
//
// The whole point of these enums is that every generated app stopped looking
// identical. Two invariants are load-bearing and pinned here:
//   1. IDENTITY FIRST — values[0] === default, and it names what the component
//      already rendered, so canonicalize filling the prop into a stored
//      definition changes zero pixels.
//   2. EXACT VOCABULARY — the value lists are a contract with the runtime
//      renderers and the AI builder catalog; a silent rename breaks both.

const LOOK_CONTRACT = {
    data_grid: { prop: 'look', values: ['default', 'striped', 'minimal', 'cards'] },
    table: { prop: 'look', values: ['default', 'striped', 'minimal'] },
    stat: { prop: 'look', values: ['plain', 'tile', 'tinted', 'accent', 'gradient'] },
    card: { prop: 'look', values: ['default', 'flat', 'raised', 'tinted', 'accent', 'gradient', 'solid'] },
    container: { prop: 'look', values: ['plain', 'panel', 'tinted', 'outlined'] },
    list: { prop: 'look', values: ['rows', 'cards', 'tiles'] },
    page_header: { prop: 'look', values: ['plain', 'banner', 'hero', 'split'] },
    heading: { prop: 'accent', values: ['none', 'bar', 'tinted'] },
    // 'underline' is what AppTabs renders today: a bottom-ruled strip with a
    // 2px primary underline on the active tab.
    tabs: { prop: 'look', values: ['underline', 'pills', 'boxed'] },
    kanban: { prop: 'cardLook', values: ['default', 'tinted', 'raised'] },
    progress: { prop: 'look', values: ['bar', 'slim', 'ring'] },
    // 'soft' is what AppBadgeList renders today: soft-tinted pills, no fills.
    badge_list: { prop: 'look', values: ['soft', 'outline', 'solid'] },
};

test('look pass: every look/accent/cardLook enum matches the contract, default = first value', () => {
    for (const [type, { prop, values }] of Object.entries(LOOK_CONTRACT)) {
        const fs = COMPONENT_SPECS[type].props[prop];
        assert.ok(fs, `${type}.${prop} missing`);
        assert.equal(fs.type, 'enum', `${type}.${prop} must be an enum`);
        assert.deepEqual(fs.values, values, `${type}.${prop} value list drifted`);
        assert.equal(fs.default, values[0], `${type}.${prop} default must be the identity (first) value`);
        assert.equal(typeof fs.description, 'string', `${type}.${prop} needs its catalog description`);
        assert.ok(fs.description.length > 0 && fs.description.length <= 300, `${type}.${prop} description length`);
    }
});

test('look pass: button variant gained outline and soft, default untouched', () => {
    const fs = COMPONENT_SPECS.button.props.variant;
    assert.deepEqual(fs.values, ['primary', 'secondary', 'ghost', 'danger', 'outline', 'soft']);
    assert.equal(fs.default, 'primary');
});

test('look pass: background style knob gained panel and gradient, default untouched', () => {
    // Order matters twice over: 'none' first keeps the identity default, and
    // the originals keep their positions so nothing keyed off the old list
    // shifts meaning.
    assert.deepEqual(STYLE_KNOBS.background.values, ['none', 'surface', 'tint', 'panel', 'gradient']);
    assert.equal(STYLE_KNOBS.background.default, 'none');
    // Section styles reach background through SECTION_STYLE_KNOBS; the section
    // default must stay 'none' so stored sections keep rendering identically.
    assert.equal(specs.SECTION_STYLE_DEFAULTS.background, 'none');
});

test('look pass: kanban cardLook is distinct from the per-card data coloring props', () => {
    const p = COMPONENT_SPECS.kanban.props;
    // cardLook styles EVERY card; colorKey/cardColorMap color individual cards
    // by data. Both must exist side by side — one replacing the other would
    // break stored boards.
    for (const k of ['cardLook', 'colorKey', 'cardColorMap']) assert.ok(k in p, `kanban lost ${k}`);
});

test('look pass: a stored definition without the new props canonicalizes to the identity values', () => {
    const def = emptyDefinition('look identity');
    def.screens[0].sections[0].children = [
        { id: 'cmp_look001', type: 'stat', props: { label: 'Open' } },
        { id: 'cmp_look002', type: 'tabs', props: {}, children: [] },
        { id: 'cmp_look003', type: 'badge_list', props: {} },
    ];
    const { def: canon } = canonicalizeAppDefinition(def);
    const [stat, tabs, badges] = canon.screens[0].sections[0].children;
    assert.equal(stat.props.look, 'plain');
    assert.equal(tabs.props.look, 'underline');
    assert.equal(badges.props.look, 'soft');
    assert.equal(validateAppDefinition(canon).ok, true);
});

// ── Navigate-with-params (Wave 1a additive schema) ──────────────────────────

test('navigate action + step specs carry the optional params map', () => {
    const { ACTION_SPECS } = specs;
    assert.equal(ACTION_SPECS.navigate.fields.params.type, 'navParams');
    assert.ok(!ACTION_SPECS.navigate.fields.params.required, 'params must stay optional');
    assert.equal(STEP_SPECS.navigate.fields.params.type, 'navParams');
    assert.ok(!STEP_SPECS.navigate.fields.params.required, 'step params must stay optional');
    assert.equal(LIMITS.MAX_NAVIGATE_PARAMS, 20);
});

// ── Advanced sizing — the derived knob vocabulary ────────────────────────────

test('advanced sizing knobs exist with the agreed shape and identity-preserving defaults', () => {
    const { STYLE_KNOBS } = specs;

    assert.deepEqual(STYLE_KNOBS.widthMode, { type: 'enum', values: ['span', 'px', 'pct'], default: 'span' });
    assert.deepEqual(STYLE_KNOBS.heightMode, { type: 'enum', values: ['preset', 'px', 'pct', 'vh'], default: 'preset' });

    // The defaults ARE today's behaviour: 'span' = the 12-column grid decides
    // the width, 'preset' = the existing height enum (fill included) decides
    // the height. Change either and every stored app silently re-lays-out.
    assert.equal(STYLE_KNOBS.widthMode.default, 'span');
    assert.equal(STYLE_KNOBS.heightMode.default, 'preset');
    assert.equal(STYLE_KNOBS.height.values[0], 'auto', 'the preset vocabulary must stay untouched');
    assert.deepEqual(STYLE_KNOBS.height.values, ['auto', 'sm', 'md', 'lg', 'xl', 'fill']);

    for (const k of ['widthValue', 'heightValue']) {
        const knob = STYLE_KNOBS[k];
        assert.equal(knob.type, 'unitInt', `${k} type`);
        assert.equal(knob.default, null, `${k} defaults to "not set"`);
        assert.ok(STYLE_KNOBS[knob.modeKnob], `${k} names a real mode knob`);
        // Every unit the mode offers (bar the value-less default) has a range.
        for (const mode of STYLE_KNOBS[knob.modeKnob].values) {
            const range = specs.unitRange(k, mode);
            if (mode === STYLE_KNOBS[knob.modeKnob].default) { assert.equal(range, null, `${k}/${mode} carries no value`); continue; }
            assert.ok(range && range.min < range.max, `${k}/${mode} needs a range`);
            assert.ok(range.min <= range.default && range.default <= range.max, `${k}/${mode} default inside range`);
        }
    }

    assert.deepEqual(specs.unitRange('widthValue', 'px'), { min: 40, max: 2000, step: 10, default: 320 });
    assert.deepEqual(specs.unitRange('widthValue', 'pct'), { min: 5, max: 100, step: 5, default: 50 });
    assert.deepEqual(specs.unitSpan('widthValue'), { min: 5, max: 2000 });
});

test('expandStyleKnobs derives width from span and height from height — per-type lists untouched', () => {
    const { COMPONENT_SPECS, expandStyleKnobs, SECTION_STYLE_KNOBS, ADVANCED_WIDTH_KNOBS, ADVANCED_HEIGHT_KNOBS } = specs;

    // The derivation rule, stated as a test so the FE mirror can rely on it.
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        const expanded = expandStyleKnobs(spec.styleKnobs);
        assert.equal(expanded.includes('widthMode'), spec.styleKnobs.includes('span'), `${type} width pair`);
        assert.equal(expanded.includes('heightMode'), spec.styleKnobs.includes('height'), `${type} height pair`);
        // ...and the ORIGINAL list is never mutated — it is what the frontend
        // mirror and the AI catalog are pinned against.
        assert.ok(!spec.styleKnobs.includes('widthMode'), `${type} styleKnobs must stay verbatim`);
        assert.ok(!spec.styleKnobs.includes('heightValue'), `${type} styleKnobs must stay verbatim`);
        for (const k of spec.styleKnobs) assert.ok(expanded.includes(k), `${type} kept ${k}`);
    }

    // A section has height but no span: height pair only.
    const sectionKnobs = expandStyleKnobs(SECTION_STYLE_KNOBS);
    for (const k of ADVANCED_HEIGHT_KNOBS) assert.ok(sectionKnobs.includes(k));
    for (const k of ADVANCED_WIDTH_KNOBS) assert.ok(!sectionKnobs.includes(k));

    // A type with neither (modal: gap/padding) earns nothing.
    assert.deepEqual(expandStyleKnobs(COMPONENT_SPECS.modal.styleKnobs), COMPONENT_SPECS.modal.styleKnobs);
    assert.deepEqual(expandStyleKnobs(null), []);
});

// ── Responsive visibility — the derived hide pair ────────────────────────────

test('responsive visibility knobs — enum shape, identity default, derived from span', () => {
    const { STYLE_KNOBS, RESPONSIVE_VISIBILITY_KNOBS, COMPONENT_SPECS, expandStyleKnobs, SECTION_STYLE_KNOBS } = specs;

    // 'none' first = identity: a stored app without the knobs renders (and
    // canonicalizes) byte-identically, and an invalid band resets to "shown".
    for (const k of RESPONSIVE_VISIBILITY_KNOBS) {
        assert.deepEqual(STYLE_KNOBS[k], { type: 'enum', values: ['none', 'sm', 'md', 'lg'], default: 'none' }, k);
    }

    // Availability follows `span`, exactly like the width pair — and the pair
    // never appears in a per-type list (the FE mirror and the prompt catalog
    // are pinned against the raw lists).
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        const expanded = expandStyleKnobs(spec.styleKnobs);
        assert.equal(expanded.includes('hideBelow'), spec.styleKnobs.includes('span'), `${type} hide pair`);
        assert.equal(expanded.includes('hideAbove'), spec.styleKnobs.includes('span'), `${type} hide pair`);
        assert.ok(!spec.styleKnobs.includes('hideBelow') && !spec.styleKnobs.includes('hideAbove'), `${type} styleKnobs stay verbatim`);
    }
    // A section has no span: no hide pair — hiding a whole section per band is
    // a screen-level decision, not a knob.
    assert.ok(!expandStyleKnobs(SECTION_STYLE_KNOBS).includes('hideBelow'));
});

test('styleHeightIsDefinite — what a percentage height may be a percentage of', () => {
    const { styleHeightIsDefinite, FIXED_HEIGHT_PRESETS } = specs;

    assert.equal(styleHeightIsDefinite(undefined), false);
    assert.equal(styleHeightIsDefinite({}), false);
    assert.equal(styleHeightIsDefinite({ height: 'auto' }), false);
    // The fixed presets are literal pixel counts, so they are definite anywhere.
    for (const p of FIXED_HEIGHT_PRESETS) assert.equal(styleHeightIsDefinite({ height: p }), true, p);

    assert.equal(styleHeightIsDefinite({ heightMode: 'px', heightValue: 400 }), true);
    assert.equal(styleHeightIsDefinite({ heightMode: 'vh', heightValue: 80 }), true);
    assert.equal(styleHeightIsDefinite({ heightMode: 'px' }), false, 'a mode with no number is not a height');

    // pct is only as definite as the box above it — that recursion is what
    // makes a 50%-of-50% chain legal under a real height and illegal under auto.
    assert.equal(styleHeightIsDefinite({ heightMode: 'pct', heightValue: 50 }, false), false);
    assert.equal(styleHeightIsDefinite({ heightMode: 'pct', heightValue: 50 }, true), true);

    // CHANGED with the pct-collapse fix: 'fill' used to be listed alongside the
    // fixed presets and counted as definite on its own. It is not — it renders
    // as `h-full`/`flex-1`, and 100% of an indefinite parent is indefinite. It
    // is exactly as relative as 'pct', so it takes the same recursion.
    assert.equal(styleHeightIsDefinite({ height: 'fill' }, false), false, 'fill inside auto is not a height');
    assert.equal(styleHeightIsDefinite({ height: 'fill' }, true), true, 'fill inside a real height is one');

    // An explicit mode outranks the preset in BOTH directions.
    assert.equal(styleHeightIsDefinite({ height: 'fill', heightMode: 'px', heightValue: 300 }), true);
    assert.equal(styleHeightIsDefinite({ height: 'fill', heightMode: 'pct', heightValue: 50 }, false), false);
});

test('containerPassesHeightDown — having a height and handing one down are different questions', () => {
    const {
        containerPassesHeightDown, containerHeightRoute, CONTAINER_HEIGHT_ROUTES,
        COMPONENT_SPECS, CONTAINER_TYPES, styleIsFill,
    } = specs;

    // THE BUG THIS ENCODES: a card's resolved height lands on its grid CELL,
    // and AppCard/AppContainer only add `h-full`/`flex-1` on the fill path. So a
    // card at height 'md' is a real 200px box whose children still measure
    // against an auto-height wrapper — a percentage child of it collapses.
    // `tabs`/`tab` ride the same route: a tab panel is stretched only on the
    // fill path, so a tabs group at a fixed height is a scrolling box and its
    // children still measure against an auto wrapper.
    for (const type of ['card', 'container', 'tabs', 'tab']) {
        assert.equal(containerPassesHeightDown(type, { height: 'md' }, true), false, `${type} height md`);
        assert.equal(containerPassesHeightDown(type, { heightMode: 'px', heightValue: 400 }, true), false, `${type} px`);
        assert.equal(containerPassesHeightDown(type, { heightMode: 'vh', heightValue: 60 }, true), false, `${type} vh`);
        // The one path that threads — and only when the cell above it is real.
        assert.equal(containerPassesHeightDown(type, { height: 'fill' }, true), true, `${type} fill under a height`);
        assert.equal(containerPassesHeightDown(type, { height: 'fill' }, false), false, `${type} fill under auto`);
        // A stale 'fill' beside an explicit mode is not a fill node (isFill).
        assert.equal(containerPassesHeightDown(type, { height: 'fill', heightMode: 'px', heightValue: 300 }, true), false);
    }

    // A pane wraps its children in an unconditional `h-full`, so it passes on
    // whatever height it has — px/vh/preset all keep working underneath one.
    assert.equal(containerPassesHeightDown('pane', { height: 'md' }, false), true);
    assert.equal(containerPassesHeightDown('pane', { heightMode: 'px', heightValue: 400 }, false), true);
    assert.equal(containerPassesHeightDown('pane', { heightMode: 'vh', heightValue: 60 }, false), true);
    assert.equal(containerPassesHeightDown('pane', {}, true), false, 'an auto pane has nothing to pass');
    assert.equal(containerPassesHeightDown('pane', { height: 'fill' }, true), true);
    assert.equal(containerPassesHeightDown('pane', { height: 'fill' }, false), false);
    // …including the recursion, one level down.
    assert.equal(containerPassesHeightDown('pane', { heightMode: 'pct', heightValue: 50 }, true), true);
    assert.equal(containerPassesHeightDown('pane', { heightMode: 'pct', heightValue: 50 }, false), false);

    // A container with no `height` knob can never pass one, whatever it carries.
    for (const type of ['form', 'modal', 'repeater', 'page_header']) {
        assert.equal(containerHeightRoute(type), null, type);
        assert.equal(containerPassesHeightDown(type, { height: 'md' }, true), false, type);
    }
    assert.equal(containerPassesHeightDown('list', { height: 'md' }, true), false, 'not a container at all');

    // LOCKSTEP: the route map is a claim about what AppCard/AppContainer/AppPane
    // render. Every container that owns a `height` knob must appear in it, and
    // nothing else may — so adding a height knob to `form` (or a fourth
    // height-bearing container) forces an explicit answer here instead of
    // silently defaulting to "refuses everything" or "accepts everything".
    const heightBearing = CONTAINER_TYPES.filter((t) => COMPONENT_SPECS[t].styleKnobs.includes('height'));
    assert.deepEqual(heightBearing.slice().sort(), Object.keys(CONTAINER_HEIGHT_ROUTES).sort());

    // styleIsFill mirrors the runtime's isFill(), which is what the 'fill'
    // route is keyed on.
    assert.equal(styleIsFill({ height: 'fill' }), true);
    assert.equal(styleIsFill({ height: 'fill', heightMode: 'pct', heightValue: 50 }), false);
    assert.equal(styleIsFill({ height: 'fill', heightMode: 'px' }), true, 'a mode with no number is not a height');
    assert.equal(styleIsFill({ height: 'md' }), false);
    assert.equal(styleIsFill(null), false);
});

test('sectionHeightIsDefinite — a section is the grid, so its own height is the one its children get', () => {
    const { sectionHeightIsDefinite } = specs;

    assert.equal(sectionHeightIsDefinite(undefined), false);
    assert.equal(sectionHeightIsDefinite({}), false);
    assert.equal(sectionHeightIsDefinite({ height: 'auto' }), false);
    assert.equal(sectionHeightIsDefinite({ height: 'lg' }), true);
    assert.equal(sectionHeightIsDefinite({ heightMode: 'px', heightValue: 600 }), true);
    assert.equal(sectionHeightIsDefinite({ heightMode: 'vh', heightValue: 90 }), true);
    // 'fill' counts on a SECTION and only there: AppRenderer grows the
    // full-height wrapper chain above a screen that holds one, so the section's
    // own parent is definite by construction.
    assert.equal(sectionHeightIsDefinite({ height: 'fill' }), true);
    // …and pct never does: it is refused on a section and the resolver declines
    // to emit it, so it is not in the DOM to be measured against.
    assert.equal(sectionHeightIsDefinite({ heightMode: 'pct', heightValue: 50 }), false);
});

/**
 * The server's own two lists must not drift from each other.
 *
 * ACTION_KINDS is a hand-maintained array; ACTION_SPECS is a separate object.
 * The client lockstep (inspector/actionKinds.lockstep.test.js) iterates
 * ACTION_KINDS, so it can only see kinds that reached THAT list — a kind added
 * to ACTION_SPECS alone is invisible to it, which is how this gap was found
 * (adding one there left all 27 lockstep tests green).
 *
 * Both directions bite, for different reasons:
 *   • in ACTION_SPECS, not in ACTION_KINDS — no editor will ever offer it and
 *     no lockstep will ever mention it; the work is simply invisible.
 *   • in ACTION_KINDS, not in ACTION_SPECS — worse. canonAction opens with
 *     `const spec = ACTION_SPECS[raw.kind]; if (!spec) return deepCopy(raw);`,
 *     so such an action passes through canonicalisation completely untouched:
 *     no field cleaning, no truncation, no repair notes.
 */
test('ACTION_KINDS and ACTION_SPECS name exactly the same kinds', () => {
    const { ACTION_KINDS, ACTION_SPECS } = require('./componentSpecs');
    const specKinds = Object.keys(ACTION_SPECS);
    const missingFromKinds = specKinds.filter(k => !ACTION_KINDS.includes(k));
    const missingFromSpecs = ACTION_KINDS.filter(k => !specKinds.includes(k));

    assert.deepStrictEqual(missingFromKinds, [],
        'in ACTION_SPECS but not ACTION_KINDS — no editor can offer it and the client lockstep cannot see it');
    assert.deepStrictEqual(missingFromSpecs, [],
        'in ACTION_KINDS but not ACTION_SPECS — canonAction returns such an action verbatim, uncanonicalised');
});
