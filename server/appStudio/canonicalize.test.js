'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
// One test asserts the canonicalizer's OUTPUT passes the validator — the two
// have to agree, or the AI is handed a definition it cannot finalize.
const { validateAppDefinition } = require('./validate');
const { ID_RE, LIMITS, SECTION_STYLE_DEFAULTS, THEME_SPEC, SCHEMA_VERSION_CURRENT, emptyDefinition, COMPONENT_SPECS } = require('./componentSpecs');

const codes = (repairs) => new Set(repairs.map((r) => r.code));

function deepFreeze(o) {
    if (o && typeof o === 'object') {
        for (const v of Object.values(o)) deepFreeze(v);
        Object.freeze(o);
    }
    return o;
}

// Minimal well-formed def factory — canonicalizes with zero repairs when
// `children` are themselves fully canonical.
function wrap(children = [], overrides = {}) {
    return {
        schemaVersion: 1,
        meta: { name: 'T' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{
            id: 'scr_main01',
            name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children }],
        }],
        actions: {},
        ...overrides,
    };
}

// ── Top-level shape ─────────────────────────────────────────────────────────

test('non-object input → empty shell with shape.not_object', () => {
    for (const bad of [null, 42, 'x', [1]]) {
        const { def, repairs } = canonicalizeAppDefinition(bad);
        assert.ok(codes(repairs).has('shape.not_object'));
        assert.equal(def.schemaVersion, SCHEMA_VERSION_CURRENT); // v2
        assert.deepEqual(def.roles, []);
        assert.deepEqual(def.screens, []);
        assert.deepEqual(def.actions, {});
        assert.equal(def.homeScreenId, null);
        assert.equal(def.meta.name, 'Untitled app');
        assert.equal(def.theme.primary, THEME_SPEC.primary.default);
    }
});

test('never mutates its input', () => {
    const sloppy = deepFreeze({
        schemaVersion: 2,
        meta: { name: 'x'.repeat(200), icon: 7 },
        theme: { primary: 'teal', radius: 'round' },
        homeScreenId: 'home',
        screens: [{
            id: 'home',
            name: 42,
            sections: [{ children: [
                { type: 'button', props: { label: 'Go', bogus: 1 }, style: { span: '20' }, onClick: 'doit', children: [{ type: 'text', props: { text: 'hi' } }] },
                'junk',
            ] }],
        }],
        actions: { doit: { kind: 'toast', message: 'hi', tone: 'loud', extra: 1 } },
    });
    const before = JSON.stringify(sloppy);
    const { def } = canonicalizeAppDefinition(sloppy); // throws if we mutate a frozen object
    assert.equal(JSON.stringify(sloppy), before);
    assert.notEqual(def, sloppy);
});

test('emptyDefinition canonicalizes with zero repairs', () => {
    const { def, repairs } = canonicalizeAppDefinition(emptyDefinition('My app'));
    assert.deepEqual(repairs, []);
    assert.equal(def.meta.name, 'My app');
});

test('idempotent: canonical output re-canonicalizes with zero repairs', () => {
    const sloppy = wrap([
        { type: 'heading', props: { text: 'Hi', level: '2' }, style: { span: 20, wat: 1 } },
        { id: 'cmp_form01', type: 'form', children: [{ type: 'input_text', props: { name: 'email', label: 'Email' } }] },
        { type: 'stat', props: { label: 'N', value: 42 } },
    ], {
        actions: { doit: { kind: 'toast', message: 'hi', tone: 'loud' } },
    });
    const first = canonicalizeAppDefinition(sloppy);
    assert.ok(first.repairs.length > 0);
    const second = canonicalizeAppDefinition(first.def);
    assert.deepEqual(second.repairs, []);
    assert.deepEqual(second.def, first.def);
});

test('idempotent: every registered template canonicalizes to a fixed point', () => {
    // Regression: app-crm-pipeline / app-ticket-tracker / app-quote-intake once
    // diverged on the second pass — kanban's columnsSource/swimlanesSource
    // (binding props with a spec default of null) were default-filled to null
    // in pass 1, then wrapped as {kind:'static',value:null} in pass 2. The
    // second pass over an already-canonical definition must be a byte-identical
    // no-op with zero repairs, for every template, so no future template can
    // reintroduce the bug.
    const { TEMPLATES } = require('./templates');
    for (const t of TEMPLATES) {
        const first = canonicalizeAppDefinition(t.definition);
        const second = canonicalizeAppDefinition(first.def);
        assert.deepEqual(second.repairs, [], `${t.id}: second pass emitted repairs`);
        assert.deepEqual(second.def, first.def, `${t.id}: second pass changed the definition`);
        // deepEqual ignores key order; canonical bytes must not.
        assert.equal(JSON.stringify(second.def), JSON.stringify(first.def), `${t.id}: second pass changed the canonical bytes`);
    }
});

test('binding prop with a null spec default: null round-trips as null (kanban columnsSource)', () => {
    // Omitted → default-filled to null (null means "not bound", and
    // validate.js accepts null for optional props).
    const first = canonicalizeAppDefinition(wrap([
        { id: 'cmp_board01', type: 'kanban', props: { source: { kind: 'static', value: [] } } },
    ]));
    const board = first.def.screens[0].sections[0].children[0];
    assert.equal(board.props.columnsSource, null);
    assert.equal(board.props.swimlanesSource, null);
    // Second pass must keep the null — not wrap it as {kind:'static',value:null}.
    const second = canonicalizeAppDefinition(first.def);
    assert.deepEqual(second.repairs, []);
    assert.deepEqual(second.def, first.def);

    // Explicit null is the default spelled out — kept as null, no repair.
    const explicit = canonicalizeAppDefinition(wrap([
        { id: 'cmp_board01', type: 'kanban', props: { columnsSource: null } },
    ]));
    assert.equal(explicit.def.screens[0].sections[0].children[0].props.columnsSource, null);
    assert.ok(!codes(explicit.repairs).has('binding.wrapped'));

    // A real binding stays a binding — the null passthrough is null-only.
    const bound = canonicalizeAppDefinition(wrap([
        { id: 'cmp_board01', type: 'kanban', props: { columnsSource: { kind: 'records', tableId: 'tbl_cols01' } } },
    ]));
    assert.deepEqual(
        bound.def.screens[0].sections[0].children[0].props.columnsSource,
        { kind: 'records', tableId: 'tbl_cols01' }
    );
});

test('schemaVersion / meta / theme repaired to spec defaults', () => {
    const { def, repairs } = canonicalizeAppDefinition({
        schemaVersion: 9,   // neither 1 nor 2 → normalized to current with a repair
        meta: 'nope',
        theme: { primary: 'teal', radius: 'round', density: 'compact' },
        screens: 'nope',
    });
    const c = codes(repairs);
    assert.ok(c.has('shape.schema_version'));
    assert.ok(c.has('meta.invalid'));
    assert.ok(c.has('theme.value_invalid'));
    assert.ok(c.has('screens.invalid'));
    assert.equal(def.schemaVersion, SCHEMA_VERSION_CURRENT); // v2
    assert.equal(def.meta.name, 'Untitled app');
    assert.equal(def.theme.primary, THEME_SPEC.primary.default); // bad hex → default
    assert.equal(def.theme.radius, 'md');                        // bad enum → default
    assert.equal(def.theme.density, 'compact');                  // valid → kept
    assert.equal(def.theme.appearance, 'auto');                  // missing → default, silently
    assert.deepEqual(def.screens, []);
});

test('meta fields: empty name defaulted, long name truncated', () => {
    const r1 = canonicalizeAppDefinition(wrap([], { meta: { name: '' } }));
    assert.ok(codes(r1.repairs).has('meta.field_invalid'));
    assert.equal(r1.def.meta.name, 'Untitled app');
    const r2 = canonicalizeAppDefinition(wrap([], { meta: { name: 'x'.repeat(LIMITS.MAX_NAME_LEN + 5) } }));
    assert.ok(codes(r2.repairs).has('string.truncated'));
    assert.equal(r2.def.meta.name.length, LIMITS.MAX_NAME_LEN);
});

// ── Ids & reference rewriting ───────────────────────────────────────────────

test('invalid ids regenerated and references rewritten (homeScreenId, navigate, onClick, actionResult)', () => {
    const { def, repairs } = canonicalizeAppDefinition({
        schemaVersion: 1,
        meta: { name: 'T' },
        theme: {},
        homeScreenId: 'home',
        screens: [{
            id: 'home',
            name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'do-thing' },
                { id: 'cmp_stat01', type: 'stat', props: { label: 'N', value: { actionId: 'do-thing', path: 'result.count' } } },
            ] }],
        }],
        actions: {
            'do-thing': { kind: 'toast', message: 'hi' },
            'act_nav001': { kind: 'navigate', screenId: 'home' },
        },
    });
    assert.ok(codes(repairs).has('id.generated'));

    const screenId = def.screens[0].id;
    assert.match(screenId, ID_RE);
    assert.equal(def.homeScreenId, screenId);
    // homeScreenId resolved by REWRITE, not by falling back to the first screen
    assert.ok(!codes(repairs).has('home.defaulted'));

    const toastId = Object.keys(def.actions).find((k) => def.actions[k].kind === 'toast');
    assert.match(toastId, ID_RE);
    assert.notEqual(toastId, 'do-thing');

    const [btn, stat] = def.screens[0].sections[0].children;
    assert.equal(btn.onClick, toastId);
    assert.deepEqual(stat.props.value, { kind: 'actionResult', actionId: toastId, path: 'result.count' });
    assert.equal(def.actions.act_nav001.screenId, screenId);
});

test('duplicate valid ids: later occurrence re-keyed, references keep pointing at the first', () => {
    const base = wrap([]);
    base.screens.push({ id: 'scr_main01', name: 'Two', sections: [{ id: 'sec_two001', style: { ...SECTION_STYLE_DEFAULTS }, children: [] }] });
    base.actions = { act_nav001: { kind: 'navigate', screenId: 'scr_main01' } };
    const { def, repairs } = canonicalizeAppDefinition(base);
    assert.ok(codes(repairs).has('id.duplicate'));
    assert.equal(def.screens[0].id, 'scr_main01');
    assert.notEqual(def.screens[1].id, 'scr_main01');
    assert.match(def.screens[1].id, ID_RE);
    assert.equal(def.actions.act_nav001.screenId, 'scr_main01'); // NOT rewritten
});

test('duplicate INVALID ids: no reference rewrite (ambiguous), both re-keyed', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'hero', type: 'text', props: { text: 'a' } },
        { id: 'hero', type: 'text', props: { text: 'b' } },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('id.generated'));
    assert.ok(c.has('id.duplicate'));
    const [a, b] = def.screens[0].sections[0].children;
    assert.match(a.id, ID_RE);
    assert.match(b.id, ID_RE);
    assert.notEqual(a.id, b.id);
});

// ── Style knobs ─────────────────────────────────────────────────────────────

test('style: clamp, numeric-string coercion, enum/color defaulting, unknown keys dropped', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head01', type: 'heading', props: { text: 'Hi', level: 2 }, style: { span: 20, align: 'middle', color: 'blue', wat: 1 } },
        { id: 'cmp_head02', type: 'heading', props: { text: 'Hi', level: 2 }, style: { span: '4', color: 'primary' } },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('style.clamped'));
    assert.ok(c.has('style.invalid'));
    assert.ok(c.has('style.unknown_key'));
    const [h1, h2] = def.screens[0].sections[0].children;
    assert.deepEqual(h1.style, { span: 12, align: 'start', color: null });
    assert.deepEqual(h2.style, { span: 4, color: 'primary' });
});

test('style: responsive visibility — valid kept, invalid band reset, dropped where span is absent', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head03', type: 'heading', props: { text: 'Hi', level: 2 }, style: { span: 4, hideBelow: 'md', hideAbove: 'huge' } },
        { id: 'cmp_moda02', type: 'modal', props: {}, style: { gap: 3, padding: 4, hideBelow: 'sm' }, children: [] },
    ]));
    const [h, modal] = def.screens[0].sections[0].children;
    assert.equal(h.style.hideBelow, 'md');
    assert.equal(h.style.hideAbove, 'none', 'unknown band resets to the identity value (shown)');
    // modal has no span, so the derived pair does not apply: dropped like any
    // unknown key — a portaled dialog has no grid cell to hide.
    assert.ok(!('hideBelow' in modal.style));
    assert.ok(codes(repairs).has('style.unknown_key'));
});

// ── Props ───────────────────────────────────────────────────────────────────

test('props: unknown keys dropped with legal-key hint, defaults filled, numeric strings coerced, strings truncated', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head01', type: 'heading', props: { text: 'x'.repeat(300), level: '3', bogus: 1 } },
        { id: 'cmp_btn001', type: 'button', props: {} },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('props.unknown_key'));
    assert.ok(c.has('props.coerced'));
    assert.ok(c.has('string.truncated'));
    assert.ok(c.has('props.defaulted'));
    const unknownRec = repairs.find((r) => r.code === 'props.unknown_key');
    assert.match(unknownRec.message, /text, level/); // lists legal keys
    const [h, b] = def.screens[0].sections[0].children;
    assert.equal(h.props.text.length, 200);
    assert.equal(h.props.level, 3);
    assert.ok(!('bogus' in h.props));
    assert.deepEqual(b.props, { label: 'Button', variant: 'primary', iconLeft: null, role: 'button', disabledWhen: null });
});

test('non-object props rebuilt from defaults', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head01', type: 'heading', props: 'nope' },
    ]));
    assert.ok(codes(repairs).has('props.invalid'));
    assert.equal(def.screens[0].sections[0].children[0].props.text, 'Heading');
});

test('list prop: non-array reset to default; item strings truncated', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_sel001', type: 'input_select', props: { name: 'c', label: 'C', options: 'nope' } },
        { id: 'cmp_kv0001', type: 'keyValue', props: { fields: [{ key: 'x'.repeat(200), label: 'A' }] } },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('props.invalid'));
    assert.ok(c.has('string.truncated'));
    const [sel, kv] = def.screens[0].sections[0].children;
    assert.deepEqual(sel.props.options, []);
    assert.equal(kv.props.fields[0].key.length, 120);
});

test('form name defaulted to frm_<id suffix>', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_form01', type: 'form', props: {} },
    ]));
    assert.ok(codes(repairs).has('form.name_defaulted'));
    assert.equal(def.screens[0].sections[0].children[0].props.name, 'frm_form01');
});

// ── Bindings ────────────────────────────────────────────────────────────────

test('bindings: bare value → static, {actionId} → actionResult, {value} → static, extras pruned', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_stat01', type: 'stat', props: { label: 'A', value: 42 } },
        { id: 'cmp_stat02', type: 'stat', props: { label: 'B', value: { actionId: 'act_run001', path: 'n' } } },
        { id: 'cmp_kv0001', type: 'keyValue', props: { source: { value: ['a'] } } },
        { id: 'cmp_stat03', type: 'stat', props: { label: 'C', value: { kind: 'static', value: '0', extra: 'x' } } },
    ], { actions: { act_run001: { kind: 'run_automation', automationId: null } } }));
    assert.ok(codes(repairs).has('binding.wrapped'));
    const [s1, s2, kv, s3] = def.screens[0].sections[0].children;
    assert.deepEqual(s1.props.value, { kind: 'static', value: 42 });
    assert.deepEqual(s2.props.value, { kind: 'actionResult', actionId: 'act_run001', path: 'n' });
    assert.deepEqual(kv.props.source, { kind: 'static', value: ['a'] });
    assert.deepEqual(s3.props.value, { kind: 'static', value: '0' }); // extras pruned silently
});

// ── Node shape ──────────────────────────────────────────────────────────────

test('visible: non-boolean coerced to true', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_txt001', type: 'text', props: { text: 'hi' }, visible: 'yes' },
        { id: 'cmp_txt002', type: 'text', props: { text: 'hi' }, visible: false },
    ]));
    assert.ok(codes(repairs).has('node.visible_invalid'));
    const [a, b] = def.screens[0].sections[0].children;
    assert.equal(a.visible, true);
    assert.equal(b.visible, false); // explicit false is kept
});

test('children on a non-container: valid nodes hoisted as following siblings, rest dropped', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head01', type: 'heading', props: { text: 'Hi' }, children: [
            { id: 'cmp_btn001', type: 'button', props: { label: 'Go' } },
            'junk',
            { type: 'gizmo9000' },
        ] },
        { id: 'cmp_txt001', type: 'text', props: { text: 'after' } },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('node.children_hoisted'));
    assert.ok(c.has('node.children_dropped'));
    const kids = def.screens[0].sections[0].children;
    assert.deepEqual(kids.map((n) => n.type), ['heading', 'button', 'text']);
    assert.ok(!('children' in kids[0]));
});

test('container keeps object children, drops non-object entries', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_card01', type: 'card', children: [null, { id: 'cmp_txt001', type: 'text', props: { text: 'in card' } }] },
        { id: 'cmp_card02', type: 'card', children: 'nope' },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('node.invalid'));
    assert.ok(c.has('node.children_dropped'));
    const [card1, card2] = def.screens[0].sections[0].children;
    assert.equal(card1.children.length, 1);
    assert.equal(card1.children[0].type, 'text');
    assert.deepEqual(card2.children, []);
});

test('unknown component type: payload preserved for the validator', () => {
    const { def } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_wild01', type: 'gizmo', props: { x: 1 } },
    ]));
    const node = def.screens[0].sections[0].children[0];
    assert.equal(node.type, 'gizmo');
    assert.deepEqual(node.props, { x: 1 });
});

test('pathological nesting cut at the hard depth cap', () => {
    let node = { type: 'card' };
    for (let i = 0; i < 35; i++) node = { type: 'card', children: [node] };
    const { repairs } = canonicalizeAppDefinition(wrap([node]));
    assert.ok(codes(repairs).has('node.too_deep'));
});

// ── Screens & sections ──────────────────────────────────────────────────────

test('screen/section shape repairs', () => {
    const { def, repairs } = canonicalizeAppDefinition({
        schemaVersion: 1,
        meta: { name: 'T' },
        theme: {},
        screens: [
            { id: 'scr_one001', name: 42, showInNav: 'yes', maxWidth: 'huge', sections: [
                { id: 'sec_one001', children: [] },     // missing style
                'garbage',                              // non-object section
                { id: 'sec_two001', style: { ...SECTION_STYLE_DEFAULTS, wat: 1 }, children: 'nope' },
            ] },
            'garbage',                                  // non-object screen
            { id: 'scr_two001', name: 'B', sections: 'nope' },
        ],
        actions: {},
    });
    const c = codes(repairs);
    assert.ok(c.has('screen.field_invalid'));
    assert.ok(c.has('section.style_defaulted'));
    assert.ok(c.has('section.invalid'));
    assert.ok(c.has('style.unknown_key'));
    assert.ok(c.has('section.children_invalid'));
    assert.ok(c.has('screen.invalid'));
    assert.ok(c.has('screen.sections_invalid'));
    assert.ok(c.has('home.defaulted')); // no homeScreenId given
    assert.equal(def.screens.length, 2);
    const s1 = def.screens[0];
    assert.equal(s1.name, 'Screen');
    assert.equal(s1.showInNav, true);
    assert.equal(s1.maxWidth, 'medium');
    assert.deepEqual(s1.sections[0].style, SECTION_STYLE_DEFAULTS);
    assert.deepEqual(s1.sections[1].children, []);
    assert.deepEqual(def.screens[1].sections, []);
    assert.equal(def.homeScreenId, 'scr_one001');
});

// ── Events & homeScreenId resolution ────────────────────────────────────────

test('dangling onClick removed; non-string onClick dropped', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_btn001', type: 'button', props: { label: 'A' }, onClick: 'act_gone01' },
        { id: 'cmp_btn002', type: 'button', props: { label: 'B' }, onClick: 42 },
    ]));
    const c = codes(repairs);
    assert.ok(c.has('event.dangling'));
    assert.ok(c.has('event.invalid'));
    const [a, b] = def.screens[0].sections[0].children;
    assert.ok(!('onClick' in a));
    assert.ok(!('onClick' in b));
});

test('dangling homeScreenId falls back to the first screen', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], { homeScreenId: 'scr_zzzz99' }));
    assert.ok(codes(repairs).has('home.defaulted'));
    assert.equal(def.homeScreenId, 'scr_main01');
});

// ── Actions ─────────────────────────────────────────────────────────────────

test('actions: unknown fields dropped, tone defaulted, effects pruned, mappings wrapped', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], {
        actions: {
            act_aaaa01: { kind: 'toast', message: 'x'.repeat(600), tone: 'loud', extra: 1 },
            act_bbbb01: { kind: 'open_url', url: 'https://x.com', newTab: 'yes' },
            act_cccc01: {
                kind: 'run_automation',
                automationId: 7,
                inputMapping: { a: 'bare', b: { name: 'email', formId: 'cmp_form01' }, c: { value: 3 } },
                onSuccess: { toast: { message: 'ok', tone: 'party' }, navigateTo: 42, confetti: true },
                onError: 'nope',
            },
            act_dddd01: 'junk',
            act_eeee01: { kind: 'run_automation', automationId: null, inputMapping: 'nope' },
        },
    }));
    const c = codes(repairs);
    assert.ok(c.has('action.unknown_field'));
    assert.ok(c.has('action.tone_invalid'));
    assert.ok(c.has('string.truncated'));
    assert.ok(c.has('action.field_invalid'));
    assert.ok(c.has('action.effects_pruned'));
    assert.ok(c.has('action.effects_invalid'));
    assert.ok(c.has('action.invalid'));
    assert.ok(c.has('mapping.wrapped'));
    assert.ok(c.has('mapping.invalid'));

    const a = def.actions.act_aaaa01;
    assert.equal(a.message.length, 500);
    assert.equal(a.tone, 'info');
    assert.ok(!('extra' in a));

    assert.equal(def.actions.act_bbbb01.newTab, true);

    const run = def.actions.act_cccc01;
    assert.equal(run.automationId, null);
    assert.deepEqual(run.inputMapping.a, { kind: 'static', value: 'bare' });
    assert.deepEqual(run.inputMapping.b, { kind: 'field', name: 'email', formId: 'cmp_form01' });
    assert.deepEqual(run.inputMapping.c, { kind: 'static', value: 3 });
    assert.deepEqual(run.onSuccess, { toast: { message: 'ok', tone: 'info' } });
    assert.ok(!('onError' in run));

    assert.ok(!('act_dddd01' in def.actions));
    assert.ok(!('inputMapping' in def.actions.act_eeee01));
});

/**
 * Regression: canonAction only copies fields whose `fs.type` it handles, so an
 * unhandled type is deleted on save without a repair to show for it. The AI
 * kinds are the first ACTIONS to carry `binding` and `int` fields — until those
 * branches existed, saving an ai_extract dropped its required `source` and the
 * builder was told the step was "missing required `source`" while the inspector
 * still displayed the field they had picked.
 */
test('AI actions keep their binding and int fields across a save', () => {
    const { def } = canonicalizeAppDefinition(wrap([], {
        actions: {
            act_ext001: {
                kind: 'ai_extract',
                source: { kind: 'formula', expr: 'form.file' },
                schema: [{ name: 'vendor', type: 'string', description: 'who sent it', required: true }],
                writeTo: { tableId: 'tbl_inv001', mapping: { vendor: 'vendor' } },
                modelTier: 'standard',
                knowledgeBaseIds: ['kb1'],
            },
            act_gen001: {
                kind: 'ai_generate',
                prompt: 'Summarize {{form.notes}}',
                attachments: { kind: 'formula', expr: 'form.doc' },
                output: 'text',
                resultVar: 'out',
            },
            act_kb0001: {
                kind: 'kb_query',
                query: { kind: 'formula', expr: 'form.q' },
                knowledgeBaseIds: ['kb1'],
                topK: 4,
                resultVar: 'hits',
            },
        },
    }));

    assert.deepEqual(def.actions.act_ext001.source, { kind: 'formula', expr: 'form.file' });
    assert.deepEqual(def.actions.act_ext001.writeTo, { tableId: 'tbl_inv001', mapping: { vendor: 'vendor' } });
    assert.deepEqual(def.actions.act_gen001.attachments, { kind: 'formula', expr: 'form.doc' });
    assert.deepEqual(def.actions.act_kb0001.query, { kind: 'formula', expr: 'form.q' });
    assert.equal(def.actions.act_kb0001.topK, 4);
});

test('a numeric-string topK on an action is coerced, like everywhere else', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], {
        actions: {
            act_kb0002: { kind: 'kb_query', query: { kind: 'static', value: 'x' }, knowledgeBaseIds: ['kb1'], topK: '6', resultVar: 'r' },
        },
    }));
    assert.ok(codes(repairs).has('props.coerced'));
    assert.equal(def.actions.act_kb0002.topK, 6);
});

test('actions map: non-object actions container reset to {}', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], { actions: [] }));
    assert.ok(codes(repairs).has('actions.invalid'));
    assert.deepEqual(def.actions, {});
});

test('repair records carry {code, path, message}', () => {
    const { repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head01', type: 'heading', props: { text: 'Hi' }, style: { span: 99 } },
    ]));
    assert.ok(repairs.length > 0);
    for (const r of repairs) {
        assert.equal(typeof r.code, 'string');
        assert.equal(typeof r.path, 'string');
        assert.equal(typeof r.message, 'string');
    }
    const clamp = repairs.find((r) => r.code === 'style.clamped');
    assert.match(clamp.path, /screens\[0\]\.sections\[0\]\.children\[0\]\.style\.span/);
});

// ── v2: schema migration ────────────────────────────────────────────────────

test('v1 input migrates to v2 silently, roles seeded []', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], { schemaVersion: 1 }));
    assert.equal(def.schemaVersion, SCHEMA_VERSION_CURRENT);
    assert.deepEqual(def.roles, []);
    assert.ok(!codes(repairs).has('shape.schema_version'), 'migration is not a repair');
});

// ── v2: new binding kinds ───────────────────────────────────────────────────

test('formula binding: kept and truncated to MAX_FORMULA_LEN', () => {
    const longExpr = '1 + '.repeat(LIMITS.MAX_FORMULA_LEN) + '1';
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_stat01', type: 'stat', props: { label: 'X', value: { kind: 'formula', expr: 'form.total * 2' } } },
        { id: 'cmp_stat02', type: 'stat', props: { label: 'Y', value: { kind: 'formula', expr: longExpr } } },
    ]));
    const [a, b] = def.screens[0].sections[0].children;
    assert.deepEqual(a.props.value, { kind: 'formula', expr: 'form.total * 2' });
    assert.equal(b.props.value.expr.length, LIMITS.MAX_FORMULA_LEN);
    assert.ok(codes(repairs).has('string.truncated'));
});

test('record/records/dataset bindings: shape normalized, limit coerced', () => {
    const { def } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_stat01', type: 'stat', props: { label: 'A', value: { kind: 'record', tableId: 'tbl_a', recordId: 'r1', path: 'name' } } },
        { id: 'cmp_tbl001', type: 'table', props: { source: { kind: 'records', tableId: 'tbl_a', filter: 'item.active', sort: 'name', limit: '10' } } },
        { id: 'cmp_lst001', type: 'list', props: { source: { kind: 'dataset', datasetId: 'ds_x', params: { region: 'eu' } } } },
    ]));
    const [s, t, l] = def.screens[0].sections[0].children;
    // REVERSED deliberately. This used to assert that `recordId` survives
    // canonicalisation — which it did, into a field no consumer ever read, so
    // the binding quietly returned the table's FIRST row instead of r1. It now
    // becomes the id filter it always meant. See canonicalize.recordId.test.js.
    assert.deepEqual(s.props.value, {
        kind: 'record', tableId: 'tbl_a', path: 'name',
        filter: [{ field: 'id', op: 'eq', value: 'r1' }],
    });
    assert.deepEqual(t.props.source, { kind: 'records', tableId: 'tbl_a', filter: 'item.active', sort: 'name', limit: 10 });
    assert.deepEqual(l.props.source, { kind: 'dataset', datasetId: 'ds_x', params: { region: 'eu' } });
});

// ── v2: node logic fields ───────────────────────────────────────────────────

test('visible accepts a formula; invalid logic fields dropped', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        {
            id: 'cmp_txt001', type: 'text', props: { text: 'hi' },
            visible: { kind: 'formula', expr: 'form.ok' },
            visibleWhen: true,
            enabledWhen: { kind: 'formula', expr: 'currentUser.id' },
            readOnly: 'nope',
            computed: { text: { kind: 'formula', expr: '"n=" + form.n' }, bogus: 42 },
            validations: [{ type: 'required', message: 'Required' }, 'junk'],
            visibleToRoles: ['admin', 7],
        },
    ]));
    const n = def.screens[0].sections[0].children[0];
    assert.deepEqual(n.visible, { kind: 'formula', expr: 'form.ok' });
    assert.equal(n.visibleWhen, true);
    assert.deepEqual(n.enabledWhen, { kind: 'formula', expr: 'currentUser.id' });
    assert.ok(!('readOnly' in n), 'invalid readOnly dropped');
    assert.deepEqual(n.computed, { text: { kind: 'formula', expr: '"n=" + form.n' } });
    assert.equal(n.validations.length, 2);
    assert.deepEqual(n.visibleToRoles, ['admin']);
    const c = codes(repairs);
    assert.ok(c.has('node.logic_invalid'));
    assert.ok(c.has('node.computed_invalid'));
    assert.ok(c.has('roles.ref_invalid'));
});

test('validations over the per-field ceiling are truncated', () => {
    const many = Array.from({ length: LIMITS.MAX_VALIDATIONS_PER_FIELD + 3 }, () => ({ type: 'required' }));
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_in0001', type: 'input_text', props: { name: 'a', label: 'A' }, validations: many },
    ]));
    assert.equal(def.screens[0].sections[0].children[0].validations.length, LIMITS.MAX_VALIDATIONS_PER_FIELD);
    assert.ok(codes(repairs).has('validations.truncated'));
});

// ── v2: screen fields + roles ───────────────────────────────────────────────

test('screen kind + visibleToRoles kept; roles cleaned', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], {
        roles: [{ id: 'admin', name: 'Admin' }, { id: 'admin', name: 'Dupe' }, 'junk', { name: 'no-id' }],
        screens: [{ id: 'scr_main01', name: 'Home', kind: 'dashboard', visibleToRoles: ['admin'], sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS }, children: [] }] }],
        homeScreenId: 'scr_main01',
    }));
    assert.deepEqual(def.roles, [{ id: 'admin', name: 'Admin' }]);
    assert.equal(def.screens[0].kind, 'dashboard');
    assert.deepEqual(def.screens[0].visibleToRoles, ['admin']);
    const c = codes(repairs);
    assert.ok(c.has('role.duplicate'));
    assert.ok(c.has('role.invalid'));
});

// ── v2: action sequences ────────────────────────────────────────────────────

test('sequence action: steps cleaned, unknown step fields dropped, nested branches kept', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([], {
        actions: {
            act_seq001: {
                kind: 'sequence',
                steps: [
                    { kind: 'toast', message: 'Hi', tone: 'loud', extra: 1 },
                    { kind: 'condition', expr: 'form.x > 0', then: [{ kind: 'navigate', screenId: 'scr_main01' }], else: [{ kind: 'set_variable', name: 'v', value: 5 }] },
                    { kind: 'loop', source: { kind: 'static', value: [] }, maxIterations: '50', steps: [{ kind: 'toast', message: 'each' }] },
                ],
            },
        },
    }));
    const seq = def.actions.act_seq001;
    assert.equal(seq.steps.length, 3);
    assert.equal(seq.steps[0].tone, 'info', 'invalid tone defaulted');
    assert.ok(!('extra' in seq.steps[0]), 'unknown step field dropped');
    assert.equal(seq.steps[1].then[0].kind, 'navigate');
    assert.deepEqual(seq.steps[1].else[0].value, { kind: 'static', value: 5 }, 'set_variable value wrapped as a binding');
    assert.equal(seq.steps[2].maxIterations, 50, 'numeric string coerced');
    assert.ok(codes(repairs).has('step.unknown_field'));
});

/**
 * The record steps carry `resultVar`.
 *
 * The client runner already wrote it for every server step, and
 * collectVariableRefs already counted it — but with no field in STEP_SPECS,
 * canonicalize dropped it on every save. That made "create the story, then
 * create its tasks under it" unwritable: the new row's id lived only in
 * `actions.<id>.result.id`, which the very next server step overwrites. A
 * parent-then-children sequence is the shape of every hierarchy, so this is
 * what makes epics-with-stories authorable at all.
 */
test('create/update/delete_record keep resultVar across a save', () => {
    const { def } = canonicalizeAppDefinition(wrap([], {
        actions: {
            act_seq002: {
                kind: 'sequence',
                steps: [
                    { kind: 'create_record', tableId: 'tbl_items1', values: { title: 'Story' }, resultVar: 'newStory' },
                    { kind: 'update_record', tableId: 'tbl_items1', recordId: { kind: 'formula', expr: 'vars.newStory.id' }, values: { rank: 1 }, resultVar: 'bumped' },
                    { kind: 'delete_record', tableId: 'tbl_items1', recordId: { kind: 'formula', expr: 'vars.newStory.id' }, resultVar: 'gone' },
                ],
            },
        },
    }));
    const steps = def.actions.act_seq002.steps;
    assert.equal(steps[0].resultVar, 'newStory');
    assert.equal(steps[1].resultVar, 'bumped');
    assert.equal(steps[2].resultVar, 'gone');
    // …and the child step can then reference it, which is the whole point.
    assert.deepEqual(steps[1].recordId, { kind: 'formula', expr: 'vars.newStory.id' });
});

// ── Connector bindings ──────────────────────────────────────────────────────

test('connector binding: shape preserved, formula params rebuilt, literals kept', () => {
    const { def } = canonicalizeAppDefinition(wrap([
        {
            id: 'cmp_tbl001', type: 'table',
            props: {
                source: {
                    kind: 'connector',
                    connectorId: 'conn_abc123',
                    params: { q: 'hello', page: { kind: 'formula', expr: 'vars.page' }, junk: 42 },
                },
            },
        },
    ]));
    const src = def.screens[0].sections[0].children[0].props.source;
    assert.equal(src.kind, 'connector');
    assert.equal(src.connectorId, 'conn_abc123');
    assert.equal(src.params.q, 'hello');
    assert.deepEqual(src.params.page, { kind: 'formula', expr: 'vars.page' });
    assert.equal(src.params.junk, 42);
});

test('binding pick survives on dataset/records/record, junk dropped', () => {
    const stat = (id, value) => ({ id, type: 'stat', props: { value } });
    const { def } = canonicalizeAppDefinition(wrap([
        stat('cmp_pick001', { kind: 'dataset', datasetId: 'ds_abc123', pick: { row: 'first', column: 'total' } }),
        stat('cmp_pick002', { kind: 'records', tableId: 'tbl_abc123', pick: { row: 'last', column: 'amount' } }),
        stat('cmp_pick003', { kind: 'record', tableId: 'tbl_abc123', pick: { column: 'name' } }),
        stat('cmp_pick004', { kind: 'dataset', datasetId: 'ds_abc123', pick: { row: 'sideways', column: 42 } }),
        stat('cmp_pick005', { kind: 'dataset', datasetId: 'ds_abc123' }),
    ]));
    const val = (i) => def.screens[0].sections[0].children[i].props.value;
    assert.deepEqual(val(0).pick, { row: 'first', column: 'total' });
    assert.deepEqual(val(1).pick, { row: 'last', column: 'amount' });
    assert.deepEqual(val(2).pick, { column: 'name' });
    // Neither field is usable, so the lens is dropped rather than half-kept.
    assert.equal('pick' in val(3), false);
    assert.equal('pick' in val(4), false);
});

/**
 * An aggregate binding may take its QUESTION from a formula.
 *
 * Every part of an aggregate descriptor frozen into the definition means a
 * chart can only ever ask the one question its author wrote. Letting groupBy
 * and aggregates resolve from `vars` lets a saved report row be the question,
 * which is what a self-service dashboard needs. `tableId` deliberately stays
 * literal: it anchors the field-reference checks and the server's table gate.
 */
test('aggregate groupBy/aggregates survive as formulas, and the table stays literal', () => {
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        {
            id: 'cmp_rep001', type: 'chart',
            props: {
                chartType: 'bar', xKey: 'label', series: [{ key: 'value', label: 'Value' }],
                source: {
                    kind: 'aggregate',
                    tableId: 'tbl_sales1',
                    groupBy: { kind: 'formula', expr: 'vars.report.group_by' },
                    aggregates: { kind: 'formula', expr: 'vars.report.measures' },
                    limit: 50,
                },
            },
        },
    ]));
    const src = def.screens[0].sections[0].children[0].props.source;
    assert.deepEqual(src.groupBy, { kind: 'formula', expr: 'vars.report.group_by' });
    assert.deepEqual(src.aggregates, { kind: 'formula', expr: 'vars.report.measures' });
    assert.equal(src.tableId, 'tbl_sales1');
    assert.deepEqual(codes(repairs).has('binding.aggregate_invalid'), false);
});

test('a literal aggregate descriptor is unchanged by the dynamic path', () => {
    const { def } = canonicalizeAppDefinition(wrap([
        {
            id: 'cmp_rep002', type: 'chart',
            props: {
                chartType: 'bar', xKey: 'label', series: [{ key: 'n', label: 'Count' }],
                source: {
                    kind: 'aggregate', tableId: 'tbl_sales1',
                    groupBy: [{ field: 'region', as: 'label' }],
                    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                },
            },
        },
    ]));
    const src = def.screens[0].sections[0].children[0].props.source;
    assert.deepEqual(src.groupBy, [{ field: 'region', as: 'label' }]);
    assert.deepEqual(src.aggregates, [{ fn: 'count', field: '*', as: 'n' }]);
});

// ── Advanced sizing (widthMode/widthValue, heightMode/heightValue) ───────────

const sizedCard = (style) => wrap([
    { id: 'cmp_card01', type: 'card', props: { title: 'G' }, style, children: [] },
]);
const styleOf = (def) => def.screens[0].sections[0].children[0].style;
// cleanStyle seeds the type's defaultStyle, so an expectation is "the type's
// defaults, plus what the author actually said".
const withDefaults = (type, extra) => ({ ...COMPONENT_SPECS[type].defaultStyle, ...extra });

test('advanced sizing: IDENTITY — a definition without the knobs stores exactly what it always did', () => {
    // Every shape the old vocabulary could take, canonicalized: no widthMode,
    // no heightMode, no widthValue, no heightValue anywhere. If canonicalize
    // ever starts seeding a default, this is the test that fails.
    const before = canonicalizeAppDefinition(wrap([
        { id: 'cmp_head01', type: 'heading', props: { text: 'Hi', level: 2 }, style: { span: 6, align: 'center' } },
        { id: 'cmp_card01', type: 'card', props: { title: 'G' }, style: { span: 4, height: 'fill', padding: 2 }, children: [] },
        { id: 'cmp_img001', type: 'image', props: { src: 'https://e.com/a.png' }, style: { height: 'lg' } },
    ]));
    assert.deepEqual(before.def.screens[0].sections[0].children.map((c) => c.style), [
        withDefaults('heading', { span: 6, align: 'center' }),
        withDefaults('card', { span: 4, height: 'fill', padding: 2 }),
        withDefaults('image', { height: 'lg' }),
    ]);
    for (const style of before.def.screens[0].sections[0].children.map((c) => c.style)) {
        for (const k of ['widthMode', 'widthValue', 'heightMode', 'heightValue']) {
            assert.equal(k in style, false, `identity: ${k} must not be seeded`);
        }
    }
    assert.equal(before.def.screens[0].sections[0].style.heightMode, undefined);
    // Idempotent: a second pass adds nothing and repairs nothing.
    const again = canonicalizeAppDefinition(before.def);
    assert.deepEqual(again.def, before.def);
    assert.deepEqual(again.repairs.filter((r) => r.code.startsWith('style.')), []);
});

test('advanced sizing: values clamp to the range their MODE names, whatever the key order', () => {
    // px window is 40..2000; pct is 5..100. Same number, different verdict —
    // which is the whole reason the mode is resolved before the loop rather
    // than as Object.entries happens to reach it.
    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ widthMode: 'px', widthValue: 5000 })).def).widthValue, 2000);
    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ widthValue: 5000, widthMode: 'px' })).def).widthValue, 2000);
    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ widthValue: 500, widthMode: 'pct' })).def).widthValue, 100);
    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ widthMode: 'px', widthValue: 3 })).def).widthValue, 40);
    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ heightMode: 'vh', heightValue: 250 })).def).heightValue, 100);
    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ heightMode: 'px', heightValue: 1 })).def).heightValue, 24);

    // Numeric strings coerce and fractions round, exactly like the int knobs.
    const { def, repairs } = canonicalizeAppDefinition(sizedCard({ widthMode: 'px', widthValue: '640.4' }));
    assert.equal(styleOf(def).widthValue, 640);
    assert.ok(codes(repairs).has('style.clamped'));
});

test('advanced sizing: "not set" is dropped, garbage is dropped, an inert value is flagged', () => {
    // null is what the inspector commits when the author switches back to
    // columns — it must round-trip to nothing at all, not to a default.
    const cleared = canonicalizeAppDefinition(sizedCard({ span: 4, widthMode: 'span', widthValue: null, heightValue: undefined }));
    assert.deepEqual(styleOf(cleared.def), withDefaults('card', { span: 4, widthMode: 'span' }));
    assert.ok(!codes(cleared.repairs).has('style.invalid'));

    assert.equal(styleOf(canonicalizeAppDefinition(sizedCard({ widthMode: 'px', widthValue: 'wide' })).def).widthValue, undefined);

    // A number with no unit to be measured in: KEPT (nothing the author wrote
    // is thrown away) but clamped to the widest window and reported — validate
    // is what turns it into an error.
    const inert = canonicalizeAppDefinition(sizedCard({ widthValue: 900 }));
    assert.equal(styleOf(inert.def).widthValue, 900);
    assert.ok(codes(inert.repairs).has('style.inert_unit'));
    const rec = inert.repairs.find((r) => r.code === 'style.inert_unit');
    assert.match(rec.message, /widthMode/);
});

test('advanced sizing: a section cannot use a percentage height — repaired with a reason', () => {
    const def = wrap([]);
    def.screens[0].sections[0].style = { ...SECTION_STYLE_DEFAULTS, heightMode: 'pct', heightValue: 50 };
    const res = canonicalizeAppDefinition(def);
    const style = res.def.screens[0].sections[0].style;
    assert.equal(style.heightMode, 'preset', 'reset to the identity default');
    const rec = res.repairs.find((r) => r.code === 'style.invalid' && /percentage/.test(r.message));
    assert.ok(rec, 'the repair has to say WHY, not just that it happened');
    assert.match(rec.message, /vh|px/);

    // …and the NUMBER goes with the mode. Everywhere else canonicalize keeps a
    // value whose mode carries no unit, because the author chose that mode.
    // Here the author did not — we did, on the line above — so a surviving
    // heightValue would hand them `style.unit_without_mode` ("heightValue is
    // set but heightMode is \"preset\"") for a mode they never wrote, on a
    // definition canonicalize itself produced. And app_add_section is the ONLY
    // section tool: with no app_update_section to fix it, that error would
    // block app_finalize until the whole screen was deleted.
    assert.ok(!('heightValue' in style), 'the stranded number is dropped with the mode');
    assert.deepEqual(validateAppDefinition(res.def).errors.filter((e) => e.path.includes('.style.')), [],
        'canonicalize output must pass its own validator');
    const second = canonicalizeAppDefinition(res.def);
    assert.deepEqual(second.def, res.def, 'still a one-pass fixed point');
    assert.deepEqual(second.repairs.filter((r) => r.code.startsWith('style.')), [],
        're-canonicalizing a repaired section reports nothing new');

    // vh and px on a section are fine — they measure something real.
    def.screens[0].sections[0].style = { ...SECTION_STYLE_DEFAULTS, heightMode: 'vh', heightValue: 80 };
    const ok = canonicalizeAppDefinition(def);
    assert.equal(ok.def.screens[0].sections[0].style.heightMode, 'vh');
    assert.equal(ok.def.screens[0].sections[0].style.heightValue, 80);
});

test('advanced sizing: the knobs are derived, so a type without span/height still rejects them', () => {
    // `tab` has neither span nor height → neither pair applies.
    const { def, repairs } = canonicalizeAppDefinition(wrap([
        { id: 'cmp_tabs01', type: 'tabs', props: { tabs: [{ id: 'cmp_tab0001', label: 'A' }] }, children: [
            { id: 'cmp_tab0001', type: 'tab', props: { label: 'A' }, style: { widthMode: 'px', widthValue: 300 }, children: [] },
        ] },
    ]));
    const tab = def.screens[0].sections[0].children[0].children[0];
    assert.deepEqual(tab.style, withDefaults('tab', {}));
    assert.ok(codes(repairs).has('style.unknown_key'));
});

// ── create_record as a top-level ACTION ────────────────────────────────────

/**
 * canonAction had no `recordValues` branch. Every field type an ACTION_SPECS
 * entry can name has to have one, or the field is simply not copied into the
 * cleaned action: no error, no repair note, the author's column values gone on
 * the first save and a button that inserts an empty row. cleanStep has had the
 * branch since create_record was a step; canonAction is the copy that did not.
 */
test('create_record action: column values survive canonicalization', () => {
    const def = wrap([], {
        actions: {
            act_add001: {
                kind: 'create_record',
                tableId: 'tbl_orders',
                values: {
                    title: { kind: 'static', value: 'New order' },
                    owner: { kind: 'formula', expr: 'currentUser.id' },
                },
                resultVar: 'created',
            },
        },
    });
    const { def: out } = canonicalizeAppDefinition(def);
    const action = out.actions.act_add001;
    assert.equal(action.kind, 'create_record');
    assert.equal(action.tableId, 'tbl_orders');
    assert.deepEqual(action.values, {
        title: { kind: 'static', value: 'New order' },
        owner: { kind: 'formula', expr: 'currentUser.id' },
    });
    assert.equal(action.resultVar, 'created');
});

test('create_record action: a non-object values map is reset to {}, with a repair note', () => {
    const def = wrap([], {
        actions: { act_add001: { kind: 'create_record', tableId: 'tbl_orders', values: 'title=x' } },
    });
    const { def: out, repairs } = canonicalizeAppDefinition(def);
    assert.deepEqual(out.actions.act_add001.values, {});
    assert.ok(codes(repairs).has('step.field_invalid'));
});

/**
 * The class behind the recordValues bug, pinned.
 *
 * canonAction is an if/else chain over `fs.type`. Every field type it does not
 * know used to fall off the end and never reach `out` — the author's value
 * gone, no error, no repair note. That is how create_record shipped an action
 * that inserted an empty row, and any field type added to ACTION_SPECS later
 * would have done the same thing again.
 *
 * So this does not test a type. It tests what happens to a type nobody has
 * written a branch for yet, which is the only thing that can catch the next one.
 */
test('a field type with no canonicalisation branch is KEPT and reported, never dropped', () => {
    const { ACTION_SPECS } = require('./componentSpecs/actionSpecs');
    const { canonAction } = require('./canonicalize/actions');

    const kind = Object.keys(ACTION_SPECS)[0];
    const spec = ACTION_SPECS[kind];
    const original = spec.fields;
    // A type that deliberately matches no branch in the chain.
    spec.fields = { ...original, __probe: { type: 'a_type_nobody_handled_yet' } };
    try {
        const notes = [];
        const out = canonAction(
            { kind, __probe: { keep: 'me' } },
            'x',
            (code, path, msg) => notes.push({ code, path, msg }),
        );
        assert.deepStrictEqual(out.__probe, { keep: 'me' },
            'an unhandled field type must survive canonicalisation — dropping it is silent data loss');
        assert.ok(notes.some(n => n.code === 'action.field_uncanonicalised'),
            'and it must say so, or the gap is invisible until a user reports missing data');
    } finally {
        spec.fields = original;
    }
});
