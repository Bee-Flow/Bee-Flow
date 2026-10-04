'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('./validate');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { COMPONENT_TYPES, LIMITS } = require('./componentSpecs');

const has = (recs, code) => recs.some((r) => r.code === code);

// A definition exercising every one of the 19 component types, all four
// action kinds, both binding kinds and both inputMapping kinds.
function richFixture() {
    return {
        schemaVersion: 1,
        meta: { name: 'Rich app', description: 'exercises all 19 types', icon: 'LayoutGrid' },
        theme: { primary: '#0369A1', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_home01',
        screens: [
            {
                id: 'scr_home01', name: 'Home', icon: 'Home', showInNav: true, maxWidth: 'wide',
                sections: [{
                    id: 'sec_hero01',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        { id: 'cmp_head01', type: 'heading', props: { text: 'Dashboard', level: 1 }, style: { span: 12, align: 'start' } },
                        { id: 'cmp_txt001', type: 'text', props: { text: 'Welcome **back**.', muted: true } },
                        { id: 'cmp_btn001', type: 'button', props: { label: 'Ping', variant: 'secondary' }, onClick: 'act_toast1' },
                        { id: 'cmp_img001', type: 'image', props: { src: 'https://example.com/x.png', alt: 'Logo', fit: 'contain' } },
                        { id: 'cmp_div001', type: 'divider' },
                        { id: 'cmp_spc001', type: 'spacer', props: { steps: 3 } },
                        { id: 'cmp_call01', type: 'callout', props: { title: 'Note', text: 'Heads up.', tone: 'warning' } },
                        { id: 'cmp_stat01', type: 'stat', props: { label: 'Open', value: { kind: 'actionResult', actionId: 'act_run001', path: 'result.count' }, caption: 'today' } },
                        { id: 'cmp_kv0001', type: 'keyValue', props: { source: { kind: 'actionResult', actionId: 'act_run001', path: 'result.latest' }, fields: [{ key: 'name', label: 'Name' }] } },
                        { id: 'cmp_tbl001', type: 'table', props: { source: { kind: 'actionResult', actionId: 'act_run001', path: 'result.rows' }, columns: [{ key: 'title', label: 'Title', format: 'text' }], rowLimit: 10 } },
                        { id: 'cmp_lst001', type: 'list', props: { source: { kind: 'static', value: [] }, titleKey: 'title' } },
                        { id: 'cmp_card01', type: 'card', props: { title: 'Group' }, children: [
                            { id: 'cmp_txt002', type: 'text', props: { text: 'In card' } },
                        ] },
                        { id: 'cmp_form01', type: 'form', props: { name: 'frm_main', submitLabel: 'Send' }, onSubmit: 'act_run001', children: [
                            { id: 'cmp_in0001', type: 'input_text', props: { name: 'email', label: 'Email', inputType: 'email', required: true } },
                            { id: 'cmp_in0002', type: 'input_textarea', props: { name: 'message', label: 'Message', rows: 5 } },
                            { id: 'cmp_in0003', type: 'input_number', props: { name: 'amount', label: 'Amount', min: 0, max: 10, step: 1 } },
                            { id: 'cmp_in0004', type: 'input_select', props: { name: 'choice', label: 'Choice', options: [{ value: 'a', label: 'A' }] } },
                            { id: 'cmp_in0005', type: 'input_checkbox', props: { name: 'agree', label: 'I agree' } },
                            { id: 'cmp_in0006', type: 'input_date', props: { name: 'date', label: 'Date', defaultValue: 'today' } },
                        ] },
                        // APPENDED, never inserted: the checks below index these
                        // children positionally (kids(d)[12] is the form), so a
                        // component added in the middle silently retargets a
                        // dozen assertions. These two exist because an action no
                        // component can reach is now a warning
                        // (action.unreachable) and this fixture asserts none.
                        { id: 'cmp_btn002', type: 'button', props: { label: 'Details', variant: 'ghost' }, onClick: 'act_nav001' },
                        { id: 'cmp_btn003', type: 'button', props: { label: 'Docs', variant: 'ghost' }, onClick: 'act_url001' },
                    ],
                }],
            },
            { id: 'scr_page02', name: 'Details', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_two001', style: { padding: 4, gap: 3, background: 'none' }, children: [] }] },
        ],
        actions: {
            act_toast1: { kind: 'toast', message: 'Pong', tone: 'success' },
            act_run001: {
                kind: 'run_automation',
                automationId: 'auto-1',
                inputMapping: {
                    email: { kind: 'field', name: 'email', formId: 'cmp_form01' },
                    note: { kind: 'static', value: 'from app' },
                },
                onSuccess: { toast: { message: 'Done', tone: 'success' }, navigateTo: 'scr_page02' },
                onError: { toast: { message: 'Failed', tone: 'danger' } },
            },
            act_nav001: { kind: 'navigate', screenId: 'scr_page02' },
            act_url001: { kind: 'open_url', url: 'https://example.com', newTab: true },
        },
    };
}

// A v2 fixture exercising every NEW component type, the new binding kind
// (formula), a formula-driven `visible`, roles + a role ref, an action
// sequence (with open_modal / condition / set_variable / navigate steps) and a
// modal target. Kept ref-clean so it validates with zero warnings when the
// relation's table is supplied as a known table.
function richV2Fixture() {
    return {
        schemaVersion: 2,
        meta: { name: 'V2 app', description: 'exercises the v2 additions', icon: 'LayoutGrid' },
        theme: { primary: '#0369A1', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_v2home',
        roles: [{ id: 'admin', name: 'Admin' }],
        screens: [
            {
                id: 'scr_v2home', name: 'V2', icon: 'LayoutGrid', showInNav: true, maxWidth: 'wide', kind: 'dashboard', visibleToRoles: ['admin'],
                sections: [{
                    id: 'sec_v2one', style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        { id: 'cmp_grid01', type: 'data_grid', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'name', label: 'Name', format: 'text', sortable: true }], pageSize: 10, selectable: 'single' }, onRowClick: 'act_seq01' },
                        { id: 'cmp_chart1', type: 'chart', props: { chartType: 'line', source: { kind: 'static', value: [] }, xKey: 'day', series: [{ key: 'v', label: 'Value' }] } },
                        { id: 'cmp_pivot1', type: 'pivot', props: { source: { kind: 'static', value: [] }, rows: [{ key: 'region' }], values: [{ key: 'amt', agg: 'sum' }] } },
                        { id: 'cmp_stat01', type: 'stat', props: { label: 'N', value: { kind: 'formula', expr: '1 + 2' }, delta: { kind: 'static', value: 5 } }, visible: { kind: 'formula', expr: 'currentUser.id != null' } },
                        { id: 'cmp_rep01', type: 'repeater', props: { source: { kind: 'static', value: [] } }, children: [
                            { id: 'cmp_reptxt', type: 'text', props: { text: 'Item' } },
                        ] },
                        { id: 'cmp_tabs01', type: 'tabs', children: [
                            { id: 'cmp_tab01', type: 'tab', props: { label: 'One' }, children: [
                                { id: 'cmp_tabtxt', type: 'text', props: { text: 'In tab' } },
                            ] },
                        ] },
                        { id: 'cmp_modal1', type: 'modal', props: { title: 'Details', size: 'md' }, children: [
                            { id: 'cmp_modtxt', type: 'text', props: { text: 'Modal body' } },
                        ] },
                        { id: 'cmp_frm01', type: 'form', props: { name: 'frm_v2', submitLabel: 'Save' }, onSubmit: 'act_save1', children: [
                            { id: 'cmp_file01', type: 'input_file', props: { name: 'doc', label: 'Document' } },
                            { id: 'cmp_rich01', type: 'input_richtext', props: { name: 'body', label: 'Body' } },
                            { id: 'cmp_dt001', type: 'input_datetime', props: { name: 'when', label: 'When' } },
                            { id: 'cmp_rel01', type: 'input_relation', props: { name: 'owner', label: 'Owner', tableId: 'tbl_people', displayField: 'name' } },
                            { id: 'cmp_ms001', type: 'input_multiselect', props: { name: 'tags', label: 'Tags', options: [{ value: 'a', label: 'A' }], defaultValue: ['a'] } },
                        ] },
                        // v2.1 catalog batch (Wave 2B) — layout/content/data/interactive.
                        { id: 'cmp_phead1', type: 'page_header', props: { title: 'V2 things', subtitle: 'All of them', icon: 'LayoutGrid' }, children: [
                            { id: 'cmp_phbtn1', type: 'button', props: { label: 'New' }, onClick: 'act_mod01' },
                        ] },
                        { id: 'cmp_cont01', type: 'container', children: [
                            { id: 'cmp_conttx', type: 'text', props: { text: 'In a column' } },
                        ] },
                        { id: 'cmp_md0001', type: 'markdown', props: { content: '## Notes\n\n- one\n- two' } },
                        { id: 'cmp_badge1', type: 'badge_list', props: { source: { kind: 'static', value: [] }, labelKey: 'tag', colorKey: 'tone', colorMap: [{ value: 'open', color: 'info' }] } },
                        { id: 'cmp_prog01', type: 'progress', props: { value: { kind: 'formula', expr: '1 + 2' }, max: 10, format: 'fraction', label: 'Done', tone: 'success' } },
                        { id: 'cmp_time01', type: 'timeline', props: { source: { kind: 'static', value: [] }, titleKey: 'title', dateKey: 'at', rowLimit: 10 }, onRowClick: 'act_seq01' },
                        { id: 'cmp_rdet01', type: 'record_detail', props: { source: { kind: 'static', value: null }, fields: [{ key: 'name', label: 'Name', format: 'text' }], columns: 2 } },
                        { id: 'cmp_filt01', type: 'filter_bar', props: { fields: [{ name: 'q', label: 'Search', type: 'search' }, { name: 'status', type: 'select', options: [{ value: 'open', label: 'Open' }] }] } },
                        { id: 'cmp_kanb01', type: 'kanban', props: { source: { kind: 'static', value: [] }, groupByField: 'status', columns: [{ value: 'open', label: 'Open', color: 'info' }], titleKey: 'title' }, onCardMove: 'act_seq01', onRowClick: 'act_seq01' },
                        { id: 'cmp_cal001', type: 'calendar', props: { source: { kind: 'static', value: [] }, dateKey: 'due', view: 'month' }, onRowClick: 'act_seq01' },
                    ],
                }],
            },
        ],
        actions: {
            act_save1: { kind: 'toast', message: 'Saved', tone: 'success' },
            act_mod01: { kind: 'open_modal', modalId: 'cmp_modal1' },
            act_seq01: {
                kind: 'sequence',
                steps: [
                    { kind: 'confirm', message: 'Are you sure?' },
                    { kind: 'toast', message: 'Working…', tone: 'info' },
                    { kind: 'open_modal', modalId: 'cmp_modal1' },
                    { kind: 'condition', expr: 'form.doc != null', then: [{ kind: 'navigate', screenId: 'scr_v2home' }], else: [{ kind: 'set_variable', name: 'seen', value: { kind: 'static', value: true } }] },
                ],
            },
        },
    };
}

// Canonicalize once — validate assumes canonical input; error tests then
// surgically break a clone.
const base = canonicalizeAppDefinition(richFixture()).def;
const baseV2 = canonicalizeAppDefinition(richV2Fixture()).def;

function broken(mutate, opts) {
    const def = structuredClone(base);
    mutate(def);
    return validateAppDefinition(def, opts);
}

const kids = (def) => def.screens[0].sections[0].children;

// ── Happy path ──────────────────────────────────────────────────────────────

test('canonicalized fixtures (all component types) validate clean', () => {
    const types = new Set();
    const walk = (nodes) => nodes.forEach((n) => { types.add(n.type); if (n.children) walk(n.children); });
    for (const b of [base, baseV2]) b.screens.forEach((s) => s.sections.forEach((sec) => walk(sec.children)));
    // The two fixtures exercise the full pre-expansion catalog (31 types);
    // newer catalog additions are covered by their own colocated tests and
    // the catalog-lockstep test — every fixture type must still be legal.
    assert.ok(types.size >= 31, `fixtures exercise ${types.size} types`);
    for (const t of types) assert.ok(COMPONENT_TYPES.includes(t), `fixture type ${t} is in the catalog`);

    const res = validateAppDefinition(base);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.ok, true);

    // The v2 fixture references a data table — supply it so the relation
    // resolves (publish gate) and the app validates with zero warnings.
    const res2 = validateAppDefinition(baseV2, { knownTables: ['tbl_people'] });
    assert.deepEqual(res2.errors, []);
    assert.deepEqual(res2.warnings, []);
    assert.equal(res2.ok, true);
});

test('records carry the automation-validate shape {code, severity, path, message, hint}', () => {
    const res = broken((d) => { kids(d)[0].props.level = 9; });
    const rec = res.errors.find((r) => r.code === 'prop.range');
    assert.equal(rec.severity, 'error');
    assert.match(rec.path, /children\[0\]\.props\.level/);
    assert.equal(typeof rec.message, 'string');
    assert.equal(typeof rec.hint, 'string');
});

// ── Top-level shape ─────────────────────────────────────────────────────────

test('top-level shape errors', () => {
    assert.ok(has(validateAppDefinition(null).errors, 'shape.not_object'));
    assert.ok(has(broken((d) => { d.schemaVersion = 1; }).errors, 'shape.schema_version'));
    assert.ok(has(broken((d) => { d.meta.name = '  '; }).errors, 'meta.name_missing'));
    assert.ok(has(broken((d) => { d.meta.name = 'x'.repeat(LIMITS.MAX_NAME_LEN + 1); }).errors, 'meta.name_too_long'));
    assert.ok(has(broken((d) => { d.screens = []; }).errors, 'screens.missing'));
    assert.ok(has(broken((d) => { d.screens = 'nope'; }).errors, 'screens.missing'));
    assert.ok(has(broken((d) => { d.homeScreenId = 'scr_zzzz99'; }).errors, 'home.unresolved'));
    assert.ok(has(broken((d) => { d.actions = []; }).errors, 'actions.invalid'));
});

// ── Ids ─────────────────────────────────────────────────────────────────────

test('id format and global uniqueness', () => {
    assert.ok(has(broken((d) => { d.screens[0].sections[0].id = 'section-1'; }).errors, 'id.format'));
    // duplicates across entity KINDS are still duplicates — ids are global
    assert.ok(has(broken((d) => { d.screens[1].id = 'scr_home01'; }).errors, 'id.duplicate'));
    assert.ok(has(broken((d) => { kids(d)[0].id = 'sec_hero01'; }).errors, 'id.duplicate'));
});

// ── Screens & sections ──────────────────────────────────────────────────────

test('screen and section structure errors', () => {
    assert.ok(has(broken((d) => { d.screens[1] = 42; }).errors, 'screen.not_object'));
    assert.ok(has(broken((d) => { d.screens[1].name = ''; }).errors, 'screen.name_missing'));
    assert.ok(has(broken((d) => { d.screens[1].sections = 'x'; }).errors, 'screen.sections_invalid'));
    assert.ok(has(broken((d) => { d.screens[1].sections = [null]; }).errors, 'section.not_object'));
    assert.ok(has(broken((d) => { d.screens[1].sections[0].children = 'x'; }).errors, 'section.children_invalid'));
    assert.ok(has(broken((d) => { d.screens[1].sections[0].children = [42]; }).errors, 'node.not_object'));
});

// ── Components ──────────────────────────────────────────────────────────────

test('unknown component type gets a closest-match hint', () => {
    const res = broken((d) => { d.screens[1].sections[0].children = [{ id: 'cmp_zzzz01', type: 'input_txt', props: {} }]; });
    const rec = res.errors.find((r) => r.code === 'node.unknown_type');
    assert.ok(rec);
    assert.match(rec.hint, /input_text/);
});

test('prop checks: required/type/range/enum/maxLen/unknown', () => {
    assert.ok(has(broken((d) => { kids(d)[0].props = 'x'; }).errors, 'node.props_invalid'));
    assert.ok(has(broken((d) => { kids(d)[0].props = {}; }).errors, 'prop.required'));
    assert.ok(has(broken((d) => { kids(d)[0].props.text = 42; }).errors, 'prop.type'));
    assert.ok(has(broken((d) => { kids(d)[0].props.text = 'x'.repeat(201); }).errors, 'prop.too_long'));
    assert.ok(has(broken((d) => { kids(d)[0].props.level = 9; }).errors, 'prop.range'));
    assert.ok(has(broken((d) => { kids(d)[0].props.level = 2.5; }).errors, 'prop.type'));
    assert.ok(has(broken((d) => { kids(d)[2].props.variant = 'jumbo'; }).errors, 'prop.enum'));
    assert.ok(has(broken((d) => { kids(d)[0].props.bogus = 1; }).errors, 'prop.unknown'));
    assert.ok(has(broken((d) => { kids(d)[3].props.src = 'http://example.com/x.png'; }).errors, 'prop.url_invalid'));
    assert.ok(has(broken((d) => { kids(d)[3].props.src = 'not a url'; }).errors, 'prop.url_invalid'));
    // input_date defaultValue: enum with allowIsoDate
    assert.ok(!has(broken((d) => { kids(d)[12].children[5].props.defaultValue = '2026-07-03'; }).errors, 'prop.enum'));
    assert.ok(has(broken((d) => { kids(d)[12].children[5].props.defaultValue = 'tomorrow'; }).errors, 'prop.enum'));
});

test('list prop checks: maxItems, itemShape, unknown item keys warn', () => {
    const opts = (items) => (d) => { kids(d)[12].children[3].props.options = items; };
    assert.ok(has(broken(opts(Array.from({ length: LIMITS.MAX_SELECT_OPTIONS + 1 }, (_, i) => ({ value: `v${i}` })))).errors, 'prop.too_many_items'));
    assert.ok(has(broken(opts(['str'])).errors, 'prop.item_invalid'));
    assert.ok(has(broken(opts([{ value: 42 }])).errors, 'prop.item_invalid'));
    assert.ok(has(broken(opts([{ label: 'A' }])).errors, 'prop.item_required'));
    const res = broken(opts([{ value: 'a', wat: 1 }]));
    assert.ok(has(res.warnings, 'prop.item_unknown_key'));
    assert.equal(res.ok, true); // unknown item keys alone don't block
});

test('style checks: unknown knob for the type, invalid values', () => {
    assert.ok(has(broken((d) => { kids(d)[0].style.padding = 2; }).errors, 'style.unknown_key')); // heading has no padding knob
    assert.ok(has(broken((d) => { kids(d)[0].style.span = 99; }).errors, 'style.invalid'));
    assert.ok(has(broken((d) => { kids(d)[0].style.align = 'middle'; }).errors, 'style.invalid'));
    assert.ok(has(broken((d) => { kids(d)[0].style = 'x'; }).errors, 'style.invalid'));
});

test('binding checks', () => {
    assert.ok(has(broken((d) => { kids(d)[7].props.value = 'bare'; }).errors, 'binding.invalid'));
    assert.ok(has(broken((d) => { kids(d)[7].props.value = { kind: 'magic' }; }).errors, 'binding.kind_invalid'));
    assert.ok(has(broken((d) => { kids(d)[7].props.value.actionId = 'act_none99'; }).errors, 'binding.action_unresolved'));
    assert.ok(has(broken((d) => { kids(d)[7].props.value.path = 'rows[0].x'; }).errors, 'binding.path_invalid'));
    // numeric indices as plain dot segments are the supported spelling
    assert.ok(!has(broken((d) => { kids(d)[7].props.value.path = 'rows.0.x'; }).errors, 'binding.path_invalid'));
});

test('children only on containers', () => {
    assert.ok(has(broken((d) => { kids(d)[0].children = []; }).errors, 'node.children_not_allowed'));
    assert.ok(has(broken((d) => { kids(d)[11].children = 'x'; }).errors, 'node.children_invalid'));
});

test('form rules: inputs outside forms warn, nested forms and duplicate names error', () => {
    const outside = broken((d) => {
        d.screens[1].sections[0].children = [{ id: 'cmp_solo01', type: 'input_text', props: { name: 'solo', label: 'Solo' } }];
    });
    assert.ok(has(outside.warnings, 'input.outside_form'));
    assert.equal(outside.ok, true); // warning, not error

    assert.ok(has(broken((d) => {
        kids(d)[12].children.push({ id: 'cmp_form02', type: 'form', props: { name: 'frm_x' }, children: [] });
    }).errors, 'form.nested'));

    assert.ok(has(broken((d) => { kids(d)[12].children[1].props.name = 'email'; }).errors, 'form.duplicate_input_name'));
});

test('events: only where the spec allows, and must resolve', () => {
    assert.ok(has(broken((d) => { kids(d)[1].onClick = 'act_toast1'; }).errors, 'event.not_supported'));
    assert.ok(has(broken((d) => { kids(d)[2].onClick = 'act_ghost1'; }).errors, 'event.action_unresolved'));
});

// ── Actions ─────────────────────────────────────────────────────────────────

test('action structure and per-kind field errors', () => {
    assert.ok(has(broken((d) => { d.actions.act_bad001 = null; }).errors, 'action.not_object'));
    assert.ok(has(broken((d) => { d.actions.act_toast1.kind = 'noop'; }).errors, 'action.kind_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_toast1.extra = 1; }).errors, 'action.unknown_field'));
    assert.ok(has(broken((d) => { d.actions.act_run001.automationId = 42; }).errors, 'action.automation_invalid'));
    assert.ok(has(broken((d) => { delete d.actions.act_nav001.screenId; }).errors, 'action.navigate_missing'));
    assert.ok(has(broken((d) => { d.actions.act_nav001.screenId = 'scr_ghost9'; }).errors, 'action.navigate_unresolved'));
    assert.ok(has(broken((d) => { d.actions.act_toast1.message = ''; }).errors, 'action.toast_message_missing'));
    assert.ok(has(broken((d) => { d.actions.act_toast1.message = 'x'.repeat(501); }).errors, 'action.toast_message_too_long'));
    assert.ok(has(broken((d) => { d.actions.act_toast1.tone = 'loud'; }).errors, 'action.toast_tone_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_url001.url = 'not a url'; }).errors, 'action.url_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_url001.url = 42; }).errors, 'action.url_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_url001.url = 'http://example.com'; }).errors, 'action.url_not_https'));
    assert.ok(has(broken((d) => { d.actions.act_url001.newTab = 'yes'; }).errors, 'action.newtab_invalid'));
});

test('run_automation: unset automation is a warning (templates ship null)', () => {
    const res = broken((d) => { d.actions.act_run001.automationId = null; });
    assert.ok(has(res.warnings, 'action.automation_unset'));
    assert.equal(res.ok, true);
});

test('opts.ownedAutomations gates publish: missing / inactive / active, array or Map', () => {
    const missing = broken(() => {}, { ownedAutomations: [] });
    assert.ok(has(missing.errors, 'action.automation_missing'));

    const inactive = broken(() => {}, { ownedAutomations: [{ id: 'auto-1', userId: 'u1', isActive: false }] });
    assert.ok(has(inactive.errors, 'action.automation_inactive'));

    const active = broken(() => {}, { ownedAutomations: [{ id: 'auto-1', userId: 'u1', isActive: true }] });
    assert.equal(active.ok, true);

    const viaMap = broken(() => {}, { ownedAutomations: new Map([['auto-1', { isActive: true }]]) });
    assert.equal(viaMap.ok, true);
});

test('inputMapping checks: structure errors, unresolved names warn', () => {
    assert.ok(has(broken((d) => { d.actions.act_run001.inputMapping = 'x'; }).errors, 'action.mapping_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_run001.inputMapping.email = { kind: 'weird' }; }).errors, 'action.mapping_kind_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_run001.inputMapping.email = 'bare'; }).errors, 'action.mapping_kind_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_run001.inputMapping.email = { kind: 'field' }; }).errors, 'action.mapping_name_missing'));

    const formUnknown = broken((d) => { d.actions.act_run001.inputMapping.email.formId = 'cmp_ghost9'; });
    assert.ok(has(formUnknown.warnings, 'action.mapping_form_unknown'));
    assert.equal(formUnknown.ok, true);

    const fieldUnknown = broken((d) => { d.actions.act_run001.inputMapping.email.name = 'nope'; });
    assert.ok(has(fieldUnknown.warnings, 'action.mapping_field_unknown'));
    assert.equal(fieldUnknown.ok, true);
});

test('effects checks', () => {
    assert.ok(has(broken((d) => { d.actions.act_run001.onSuccess = 'x'; }).errors, 'action.effects_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_run001.onSuccess.toast = {}; }).errors, 'action.effects_toast_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_run001.onSuccess.toast.tone = 'party'; }).errors, 'action.toast_tone_invalid'));
    assert.ok(has(broken((d) => { d.actions.act_run001.onSuccess.navigateTo = 'scr_ghost9'; }).errors, 'action.effects_navigate_unresolved'));
    assert.ok(has(broken((d) => { d.actions.act_run001.onSuccess.confetti = 1; }).errors, 'action.unknown_field'));
});

// ── LIMITS ceilings ─────────────────────────────────────────────────────────

function synth({ screens, sectionsPerScreen = 1, childrenPerSection = 0, actions = 0 } = {}) {
    const pad = (i) => String(i).padStart(4, '0');
    return {
        schemaVersion: 1,
        meta: { name: 'caps' },
        homeScreenId: 'scr_x0000',
        screens: Array.from({ length: screens }, (_, si) => ({
            id: `scr_x${pad(si)}`,
            name: 'S',
            sections: Array.from({ length: sectionsPerScreen }, (_, ci) => ({
                id: `sec_x${pad(si)}${pad(ci)}`.slice(0, 12),
                children: Array.from({ length: childrenPerSection }, () => ({})),
            })),
        })),
        actions: Object.fromEntries(Array.from({ length: actions }, (_, i) => [`act_x${pad(i)}`, { kind: 'toast', message: 'x' }])),
    };
}

test('caps from LIMITS fail fast', () => {
    assert.ok(has(validateAppDefinition(synth({ screens: LIMITS.MAX_SCREENS + 1 })).errors, 'shape.too_many_screens'));
    assert.ok(has(validateAppDefinition(synth({ screens: 1, sectionsPerScreen: LIMITS.MAX_SECTIONS_PER_SCREEN + 1 })).errors, 'screen.too_many_sections'));
    assert.ok(has(validateAppDefinition(synth({ screens: 1, childrenPerSection: LIMITS.MAX_TOTAL_NODES })).errors, 'shape.too_many_nodes'));
    assert.ok(has(validateAppDefinition(synth({ screens: 1, actions: LIMITS.MAX_ACTIONS + 1 })).errors, 'shape.too_many_actions'));
    assert.ok(has(broken((d) => { kids(d)[1].props.text = 'x'.repeat(LIMITS.MAX_DEFINITION_BYTES + 1); }).errors, 'shape.too_large'));
});

test('depth cap: MAX_DEPTH (v3 = 6) below the screen, containers +1 each', () => {
    // section(1) → card(2) → card(3) → card(4) → card(5) → leaf(6) is legal.
    // This is the shape the v3 bump exists for: a tabbed pane whose tab holds a
    // toolbar — section → pane → tabs → tab → page_header → button.
    const legal = broken((d) => {
        d.screens[1].sections[0].children = [{ id: 'cmp_deep01', type: 'card', props: {}, children: [
            { id: 'cmp_deep02', type: 'card', props: {}, children: [
                { id: 'cmp_deep03', type: 'card', props: {}, children: [
                    { id: 'cmp_deep04', type: 'card', props: {}, children: [
                        { id: 'cmp_deep0a', type: 'heading', props: { text: 'x' } },
                    ] },
                ] },
            ] },
        ] }];
    });
    assert.ok(!has(legal.errors, 'shape.too_deep'));
    // …but a component nested one container deeper sits at depth 7.
    const tooDeep = broken((d) => {
        d.screens[1].sections[0].children = [{ id: 'cmp_deep01', type: 'card', props: {}, children: [
            { id: 'cmp_deep02', type: 'card', props: {}, children: [
                { id: 'cmp_deep03', type: 'card', props: {}, children: [
                    { id: 'cmp_deep04', type: 'card', props: {}, children: [
                        { id: 'cmp_deep05', type: 'card', props: {}, children: [
                            { id: 'cmp_deep06', type: 'heading', props: { text: 'x' } },
                        ] },
                    ] },
                ] },
            ] },
        ] }];
    });
    assert.ok(has(tooDeep.errors, 'shape.too_deep'));
});

test('unserializable definitions are rejected, not thrown', () => {
    const def = structuredClone(base);
    def.meta.self = def; // circular
    const res = validateAppDefinition(def);
    assert.ok(has(res.errors, 'shape.unserializable'));
});

test('does not crash on raw garbage', () => {
    const res = validateAppDefinition({
        schemaVersion: 1,
        meta: { name: 'x' },
        screens: [{ id: 5, sections: [{ children: [{ type: 'card', children: [null, 7, { type: 'form', children: [{ type: 'form' }] }] }] }] }],
        actions: { a: null },
    });
    assert.equal(res.ok, false);
    assert.ok(res.errors.length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// v2 — new binding kinds, node logic, roles, action sequences, new components
// ═══════════════════════════════════════════════════════════════════════════

const kidsV2 = (def) => def.screens[0].sections[0].children;
function brokenV2(mutate, opts = { knownTables: ['tbl_people'] }) {
    const def = structuredClone(baseV2);
    mutate(def);
    return validateAppDefinition(def, opts);
}

test('formula binding: parse errors error, unknown roots warn, clean formulas pass', () => {
    // stat.value in baseV2 is a formula
    assert.ok(has(brokenV2((d) => { kidsV2(d)[3].props.value = { kind: 'formula', expr: '1 +' }; }).errors, 'formula.parse_error'));
    const rec = brokenV2((d) => { kidsV2(d)[3].props.value = { kind: 'formula', expr: '1 +' }; }).errors.find((e) => e.code === 'formula.parse_error');
    assert.match(rec.message, /position \d+/); // carries e.index
    assert.ok(has(brokenV2((d) => { kidsV2(d)[3].props.value = { kind: 'formula', expr: 'nope.x + 1' }; }).warnings, 'unknown_formula_root'));
    assert.equal(brokenV2((d) => { kidsV2(d)[3].props.value = { kind: 'formula', expr: 'records.people.length' }; }).ok, true);
});

test('record/records/dataset bindings: unset warns, unverified in draft, missing at publish', () => {
    assert.ok(has(brokenV2((d) => { kidsV2(d)[0].props.source = { kind: 'records', tableId: null }; }).warnings, 'binding.table_unset'));
    // no knownTables → draft, unverified
    assert.ok(has(brokenV2((d) => { kidsV2(d)[0].props.source = { kind: 'records', tableId: 'tbl_ghost' }; }, {}).warnings, 'binding.table_unverified'));
    // knownTables supplied → publish gate errors on a dangling table
    assert.ok(has(brokenV2((d) => { kidsV2(d)[0].props.source = { kind: 'records', tableId: 'tbl_ghost' }; }).errors, 'binding.table_missing'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[0].props.source = { kind: 'records', tableId: 'tbl_people', limit: -3 }; }).errors, 'binding.limit_invalid'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[1].props.source = { kind: 'dataset', datasetId: 'ds_ghost' }; }, { knownDatasets: ['ds_ok'] }).errors, 'binding.dataset_missing'));
});

test('node logic: bad visible formula, computed checks, validation rules', () => {
    assert.ok(has(brokenV2((d) => { kidsV2(d)[3].visible = { kind: 'formula', expr: '1 +' }; }).errors, 'formula.parse_error'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[3].enabledWhen = 'nope'; }).errors, 'node.logic_invalid'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[3].computed = { value: { kind: 'nope' } }; }).errors, 'node.computed_invalid'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[3].computed = { zzz: { kind: 'formula', expr: '1' } }; }).warnings, 'node.computed_unknown_prop'));

    // validations live on inputs — form.children[0] is input_file
    const val = (rule) => (d) => { kidsV2(d)[7].children[0].validations = [rule]; };
    assert.ok(has(brokenV2(val({ type: 'weird' })).errors, 'validation.type_invalid'));
    assert.ok(has(brokenV2(val({ type: 'minLength', value: -1 })).errors, 'validation.value_invalid'));
    assert.ok(has(brokenV2(val({ type: 'format' })).errors, 'validation.format_invalid'));
    assert.ok(has(brokenV2(val({ type: 'formula', expr: '1 +' })).errors, 'formula.parse_error'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[7].children[0].validations = Array.from({ length: LIMITS.MAX_VALIDATIONS_PER_FIELD + 1 }, () => ({ type: 'required' })); }).errors, 'validations.too_many'));
    // validations on a non-input component → warning
    assert.ok(has(brokenV2((d) => { kidsV2(d)[1].validations = [{ type: 'required' }]; }).warnings, 'validations.not_input'));
});

test('roles: invalid entry, duplicate, unknown reference warns', () => {
    assert.ok(has(brokenV2((d) => { d.roles = [{ name: 'no id' }]; }).errors, 'role.invalid'));
    assert.ok(has(brokenV2((d) => { d.roles = [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]; }).errors, 'role.duplicate'));
    assert.ok(has(brokenV2((d) => { d.screens[0].visibleToRoles = ['ghostrole']; }).warnings, 'roles.ref_unknown'));
    assert.ok(has(brokenV2((d) => { d.screens[0].kind = 'wizard'; }).errors, 'screen.kind_invalid'));
});

test('open_modal actions resolve against modal component ids', () => {
    assert.ok(has(brokenV2((d) => { d.actions.act_mod01.modalId = 'cmp_ghost'; }).errors, 'action.modal_unresolved'));
    assert.ok(has(brokenV2((d) => { delete d.actions.act_mod01.modalId; }).errors, 'action.modal_missing'));
});

test('action sequence: kinds, refs, loop bounds, depth, count, partition', () => {
    const steps = (s) => (d) => { d.actions.act_seq01.steps = s; };
    assert.ok(has(brokenV2(steps([{ kind: 'frobnicate' }])).errors, 'action.step_kind_invalid'));
    assert.ok(has(brokenV2(steps([{ kind: 'navigate', screenId: 'scr_ghost' }])).errors, 'action.step_navigate_unresolved'));
    assert.ok(has(brokenV2(steps([{ kind: 'open_modal', modalId: 'cmp_ghost' }])).errors, 'action.modal_unresolved'));
    assert.ok(has(brokenV2(steps([{ kind: 'loop', source: { kind: 'static', value: [] }, maxIterations: LIMITS.MAX_ACTION_LOOP_ITERATIONS + 1, steps: [] }])).errors, 'action.step_field_invalid'));
    assert.ok(has(brokenV2(steps([{ kind: 'condition', expr: '1 +', then: [], else: [] }])).errors, 'formula.parse_error'));
    // client/server partition: a client step may not carry a data field
    assert.ok(has(brokenV2(steps([{ kind: 'toast', message: 'x', tableId: 'tbl_people' }])).errors, 'action.step_partition'));
    // a data step legitimately carries tableId
    assert.equal(brokenV2(steps([{ kind: 'delete_record', tableId: 'tbl_people', recordId: { kind: 'static', value: 'r1' } }])).ok, true);
    // count + depth ceilings
    assert.ok(has(brokenV2(steps(Array.from({ length: LIMITS.MAX_ACTION_STEPS + 1 }, () => ({ kind: 'toast', message: 'x' })))).errors, 'action.too_many_steps'));
    let deep = [{ kind: 'toast', message: 'leaf' }];
    for (let i = 0; i < LIMITS.MAX_ACTION_DEPTH + 1; i++) deep = [{ kind: 'condition', expr: 'form.x', then: deep, else: [] }];
    assert.ok(has(brokenV2(steps(deep)).errors, 'action.step_too_deep'));
    // a run_automation step with an unset automation warns (mirrors the top-level)
    assert.ok(has(brokenV2(steps([{ kind: 'run_automation', automationId: null }])).warnings, 'action.automation_unset'));
});

test('new component props validate (data_grid columns cap, multiselect strings, relation ref)', () => {
    assert.ok(has(brokenV2((d) => { kidsV2(d)[0].props.columns = Array.from({ length: LIMITS.MAX_DATA_GRID_COLUMNS + 1 }, (_, i) => ({ key: `c${i}` })); }).errors, 'prop.too_many_items'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[7].children[4].props.defaultValue = [42]; }).errors, 'prop.item_invalid'));
    assert.ok(has(brokenV2((d) => { kidsV2(d)[7].children[3].props.tableId = 'tbl_ghost'; }).errors, 'binding.table_missing'));
});

// ── native AI steps/actions (ai_extract / ai_generate / kb_query) ────────────

test('native AI steps: schema, writeTo and stringList validate; a well-formed AI step passes', () => {
    const steps = (s) => (d) => { d.actions.act_seq01.steps = s; };
    // A well-formed ai_extract that writes into a known table (source is a
    // formula binding over the form field — the shape the inspector emits).
    const okExtract = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string' }, { name: 'amount', type: 'number' }],
        writeTo: { tableId: 'tbl_people', mapping: { name: 'vendor' } }, resultVar: 'rows',
    };
    assert.equal(brokenV2(steps([okExtract])).ok, true);

    // schema field errors
    assert.ok(has(brokenV2(steps([{ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.d' }, schema: [] }])).errors, 'action.ai_schema_empty'));
    assert.ok(has(brokenV2(steps([{ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.d' }, schema: [{ name: 'bad name', type: 'string' }] }])).errors, 'action.ai_schema_invalid'));
    assert.ok(has(brokenV2(steps([{ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.d' }, schema: [{ name: 'x', type: 'weird' }] }])).errors, 'action.ai_schema_invalid'));

    // writeTo shape + table ref
    assert.ok(has(brokenV2(steps([{ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.d' }, schema: [{ name: 'x', type: 'string' }], writeTo: { tableId: 'tbl_people', mapping: 'nope' } }])).errors, 'action.ai_writeto_invalid'));
    assert.ok(has(brokenV2(steps([{ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.d' }, schema: [{ name: 'x', type: 'string' }], writeTo: { tableId: 'tbl_ghost', mapping: { name: 'x' } } }])).errors, 'binding.table_missing'));

    // upsertOn — the column that decides which row an extracted row IS. A key
    // the mapping never writes matches nothing, so it would silently insert
    // exactly the duplicates it was added to prevent.
    assert.ok(has(brokenV2(steps([{ kind: 'ai_extract', source: { kind: 'formula', expr: 'form.d' }, schema: [{ name: 'x', type: 'string' }], writeTo: { tableId: 'tbl_people', mapping: { name: 'x' }, upsertOn: 'email' } }])).errors, 'action.ai_writeto_invalid'));

    // required fields on ai_generate / kb_query
    assert.ok(has(brokenV2(steps([{ kind: 'ai_generate', prompt: 'hi', output: 'text' }])).errors, 'action.step_field_required')); // resultVar
    assert.ok(has(brokenV2(steps([{ kind: 'kb_query', knowledgeBaseIds: ['kb1'], resultVar: 'r' }])).errors, 'action.step_field_required')); // query

    // stringList (knowledgeBaseIds) must be an array of strings
    assert.ok(has(brokenV2(steps([{ kind: 'kb_query', query: { kind: 'static', value: 'q' }, knowledgeBaseIds: 'nope', resultVar: 'r' }])).errors, 'action.step_field_invalid'));

    // client/server partition: a client-only step still can't carry a data field
    assert.ok(has(brokenV2(steps([{ kind: 'toast', message: 'x', tableId: 'tbl_people' }])).errors, 'action.step_partition'));
});

test('native AI actions validate as bare v1 actions too', () => {
    const missing = brokenV2((d) => { d.actions.act_ai01 = { kind: 'ai_generate', prompt: 'hi', output: 'text' }; });
    assert.ok(has(missing.errors, 'action.step_field_required')); // resultVar required
    const okAct = brokenV2((d) => { d.actions.act_ai01 = { kind: 'ai_generate', prompt: 'hi', output: 'text', resultVar: 'out' }; });
    assert.ok(!has(okAct.errors, 'action.step_field_required'));
    assert.ok(!has(okAct.errors, 'action.unknown_field'));
});

test('canonicalize preserves AI action fields (schema/writeTo/knowledgeBaseIds survive a save)', () => {
    const def = structuredClone(baseV2);
    def.actions.act_ai01 = {
        kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
        schema: [{ name: 'vendor', type: 'string', required: true }, { name: 'total', type: 'number' }],
        knowledgeBaseIds: ['kb1', 'kb2'],
        writeTo: { tableId: 'tbl_people', mapping: { name: 'vendor' } },
        resultVar: 'rows',
    };
    const { def: canon } = canonicalizeAppDefinition(def);
    const a = canon.actions.act_ai01;
    assert.equal(a.kind, 'ai_extract');
    assert.equal(a.schema.length, 2);
    assert.deepEqual(a.schema[0], { name: 'vendor', type: 'string', required: true });
    assert.deepEqual(a.knowledgeBaseIds, ['kb1', 'kb2']);
    assert.deepEqual(a.writeTo, { tableId: 'tbl_people', mapping: { name: 'vendor' } });
});

// ── Navigate-with-params (additive; resolved client-side → screen.params) ────

test('navigate params: canonicalize passes them through and they validate clean', () => {
    const def = structuredClone(base);
    def.actions.act_nav001.params = {
        recordId: { kind: 'formula', expr: 'vars.rowId' },
        mode: { kind: 'static', value: 'view' },
    };
    const { def: canon } = canonicalizeAppDefinition(def);
    assert.deepEqual(canon.actions.act_nav001.params, {
        recordId: { kind: 'formula', expr: 'vars.rowId' },
        mode: { kind: 'static', value: 'view' },
    });
    const res = validateAppDefinition(canon);
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
});

test('navigate params: shape, key, kind, count and formula errors', () => {
    const withParams = (params) => broken((d) => { d.actions.act_nav001.params = params; });
    assert.ok(has(withParams('x').errors, 'action.params_invalid'));
    assert.ok(has(withParams({ 'bad key': { kind: 'static', value: 1 } }).errors, 'action.param_key_invalid'));
    assert.ok(has(withParams({ a: 42 }).errors, 'action.param_kind_invalid'));
    assert.ok(has(withParams({ a: { kind: 'weird' } }).errors, 'action.param_kind_invalid'));
    assert.ok(has(withParams({ a: { kind: 'formula', expr: '1 +' } }).errors, 'formula.parse_error'));
    assert.ok(has(withParams({ a: { kind: 'formula', expr: `1 + ${'x'.repeat(LIMITS.MAX_FORMULA_LEN)}` } }).errors, 'formula.too_long'));
    const many = {};
    for (let i = 0; i <= LIMITS.MAX_NAVIGATE_PARAMS; i++) many[`k${i}`] = { kind: 'static', value: i };
    assert.ok(has(withParams(many).errors, 'action.params_too_many'));
    // an out-of-scope formula root warns (compiles, resolves to undefined)
    assert.ok(has(withParams({ a: { kind: 'formula', expr: 'bogusroot.x' } }).warnings, 'unknown_formula_root'));
});

test('navigate STEP params: canonical pass-through, validation, broken formula flagged', () => {
    const def = structuredClone(baseV2);
    def.actions.act_seq01.steps = [
        { kind: 'navigate', screenId: 'scr_v2home', params: { recordId: { kind: 'formula', expr: 'item.id' } } },
    ];
    const { def: canon } = canonicalizeAppDefinition(def);
    assert.deepEqual(canon.actions.act_seq01.steps[0].params, { recordId: { kind: 'formula', expr: 'item.id' } });
    const clean = validateAppDefinition(canon, { knownTables: ['tbl_people'] });
    assert.deepEqual(clean.errors, []);

    const bad = brokenV2((d) => {
        d.actions.act_seq01.steps = [{ kind: 'navigate', screenId: 'scr_v2home', params: { a: { kind: 'formula', expr: '1 +' } } }];
    });
    assert.ok(has(bad.errors, 'formula.parse_error'));
});

// ═══════════════════════════════════════════════════════════════════════════
// Wave 2A — data-aware validation (opts.dataModel / opts.datasets)
// ═══════════════════════════════════════════════════════════════════════════

// A canonical-shaped data model: one table with two fields.
const DATA_MODEL = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_people', key: 'people', name: 'People',
        fields: [
            { id: 'fld_name01', key: 'name', type: 'text', required: true, unique: false },
            { id: 'fld_stat01', key: 'status', type: 'select', options: [{ value: 'active' }], required: false, unique: false },
        ],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};

const dataOpts = (extra = {}) => ({ dataModel: DATA_MODEL, datasets: [{ id: 'ds_ok0001' }], ...extra });

function withBinding(binding) {
    const def = structuredClone(baseV2);
    def.screens[0].sections[0].children[0].props.source = binding;
    return def;
}

test('data-aware checks are SKIPPED when opts.dataModel is undefined (existing callers untouched)', () => {
    const def = withBinding({ kind: 'records', tableId: 'tbl_ghost', filter: [{ field: 'nope', op: 'eq', value: 1 }] });
    const res = validateAppDefinition(def, { knownTables: ['tbl_ghost'] });
    assert.ok(!has(res.errors, 'binding.unknown_table'));
    assert.ok(!has(res.errors, 'binding.unknown_field'));
    assert.ok(!has(res.warnings, 'binding.unknown_table'));
});

test('binding.unknown_table: record/records tableId must exist in the data model', () => {
    const res = validateAppDefinition(withBinding({ kind: 'records', tableId: 'tbl_ghost' }), dataOpts());
    const rec = res.errors.find((e) => e.code === 'binding.unknown_table');
    assert.ok(rec, JSON.stringify(res.errors));
    assert.equal(rec.severity, 'error');
    assert.ok(rec.path && rec.message && rec.hint);
    // record kind too
    assert.ok(has(validateAppDefinition(withBinding({ kind: 'record', tableId: 'tbl_ghost' }), dataOpts()).errors, 'binding.unknown_table'));
    // a resolving table is clean; null model = every table unknown
    assert.ok(!has(validateAppDefinition(withBinding({ kind: 'records', tableId: 'tbl_people' }), dataOpts()).errors, 'binding.unknown_table'));
    assert.ok(has(validateAppDefinition(withBinding({ kind: 'records', tableId: 'tbl_people' }), { dataModel: null }).errors, 'binding.unknown_table'));
});

test('binding.unknown_dataset: dataset bindings resolve against opts.datasets', () => {
    assert.ok(has(validateAppDefinition(withBinding({ kind: 'dataset', datasetId: 'ds_ghost' }), dataOpts()).errors, 'binding.unknown_dataset'));
    assert.ok(!has(validateAppDefinition(withBinding({ kind: 'dataset', datasetId: 'ds_ok0001' }), dataOpts()).errors, 'binding.unknown_dataset'));
    // datasets accepted as plain ids too
    assert.ok(!has(validateAppDefinition(withBinding({ kind: 'dataset', datasetId: 'ds_ok0001' }), { dataModel: DATA_MODEL, datasets: ['ds_ok0001'] }).errors, 'binding.unknown_dataset'));
});

test('binding.unknown_field: filter/sort field keys must be on the table; system columns allowed', () => {
    const filt = (field) => withBinding({ kind: 'records', tableId: 'tbl_people', filter: [{ field, op: 'eq', value: 'x' }] });
    assert.ok(has(validateAppDefinition(filt('nope'), dataOpts()).errors, 'binding.unknown_field'));
    assert.ok(!has(validateAppDefinition(filt('name'), dataOpts()).errors, 'binding.unknown_field'));
    for (const sys of ['id', 'created_at', 'updated_at', 'created_by', 'org_id']) {
        assert.ok(!has(validateAppDefinition(filt(sys), dataOpts()).errors, 'binding.unknown_field'), `system column ${sys} allowed`);
    }
    const sorted = (field) => withBinding({ kind: 'records', tableId: 'tbl_people', sort: [{ field, dir: 'asc' }] });
    assert.ok(has(validateAppDefinition(sorted('nope'), dataOpts()).errors, 'binding.unknown_field'));
    assert.ok(!has(validateAppDefinition(sorted('created_at'), dataOpts()).errors, 'binding.unknown_field'));
});

test('filter grammar: {field,op,value} entries; formula-valued filters parse-compile; bad shapes error', () => {
    const b = (filter) => validateAppDefinition(withBinding({ kind: 'records', tableId: 'tbl_people', filter }), dataOpts());
    // formula-valued filter accepted, expr compiled (never executed)
    const okFormula = b([{ field: 'name', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }]);
    assert.deepEqual(okFormula.errors, [], JSON.stringify(okFormula.errors));
    // broken formula expr → parse error
    assert.ok(has(b([{ field: 'name', op: 'eq', value: { kind: 'formula', expr: '1 +' } }]).errors, 'formula.parse_error'));
    // out-of-scope root warns
    assert.ok(has(b([{ field: 'name', op: 'eq', value: { kind: 'formula', expr: 'bogus.x' } }]).warnings, 'unknown_formula_root'));
    // bad op / bad entry / non-array-non-string filter
    assert.ok(has(b([{ field: 'name', op: 'looks_like', value: 1 }]).errors, 'binding.filter_invalid'));
    assert.ok(has(b(['bare']).errors, 'binding.filter_invalid'));
    assert.ok(has(b(42).errors, 'binding.filter_invalid'));
    // in/between arrays of literals are fine; non-formula object values are not
    assert.ok(!has(b([{ field: 'status', op: 'in', value: ['active', 'gone'] }]).errors, 'binding.filter_invalid'));
    assert.ok(has(b([{ field: 'name', op: 'eq', value: { some: 'object' } }]).errors, 'binding.filter_invalid'));
    // legacy string filter still compiles as a formula
    assert.ok(has(b('1 +').errors, 'formula.parse_error'));
    // sort shape errors
    const s = (sort) => validateAppDefinition(withBinding({ kind: 'records', tableId: 'tbl_people', sort }), dataOpts());
    assert.ok(has(s([{ field: 'name', dir: 'sideways' }]).errors, 'binding.sort_invalid'));
    assert.ok(has(s(['x']).errors, 'binding.sort_invalid'));
    assert.ok(!has(s({ field: 'name', dir: 'desc' }).errors, 'binding.sort_invalid'), 'single sort object accepted');
});

test('step.unknown_table / step.unknown_field on create/update/delete_record steps', () => {
    const withSteps = (steps) => {
        const def = structuredClone(baseV2);
        def.actions.act_seq01.steps = steps;
        return def;
    };
    const ghostTable = validateAppDefinition(withSteps([
        { kind: 'create_record', tableId: 'tbl_ghost', values: { name: { kind: 'static', value: 'x' } } },
    ]), dataOpts());
    assert.ok(has(ghostTable.errors, 'step.unknown_table'), JSON.stringify(ghostTable.errors));

    const ghostField = validateAppDefinition(withSteps([
        { kind: 'update_record', tableId: 'tbl_people', recordId: { kind: 'static', value: 'rec_1' }, values: { nope: { kind: 'static', value: 'x' } } },
    ]), dataOpts());
    assert.ok(has(ghostField.errors, 'step.unknown_field'), JSON.stringify(ghostField.errors));

    // system columns are NOT writable
    assert.ok(has(validateAppDefinition(withSteps([
        { kind: 'create_record', tableId: 'tbl_people', values: { created_by: { kind: 'static', value: 'me' } } },
    ]), dataOpts()).errors, 'step.unknown_field'));

    // clean writes pass; delete only needs the table to resolve
    const clean = validateAppDefinition(withSteps([
        { kind: 'create_record', tableId: 'tbl_people', values: { name: { kind: 'static', value: 'x' }, status: { kind: 'formula', expr: 'vars.status' } } },
        { kind: 'delete_record', tableId: 'tbl_people', recordId: { kind: 'static', value: 'rec_1' } },
    ]), dataOpts());
    assert.deepEqual(clean.errors, [], JSON.stringify(clean.errors));
    assert.ok(has(validateAppDefinition(withSteps([
        { kind: 'delete_record', tableId: 'tbl_ghost', recordId: { kind: 'static', value: 'rec_1' } },
    ]), dataOpts()).errors, 'step.unknown_table'));
});

test('opts.dataRefsAsWarnings demotes data-reference findings to warnings (save stays ok)', () => {
    const def = withBinding({ kind: 'records', tableId: 'tbl_ghost', filter: [{ field: 'nope', op: 'eq', value: 1 }] });
    const res = validateAppDefinition(def, dataOpts({ dataRefsAsWarnings: true }));
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.ok(has(res.warnings, 'binding.unknown_table'));
    const w = res.warnings.find((x) => x.code === 'binding.unknown_table');
    assert.equal(w.severity, 'warning');
    // structural filter errors are NOT demoted — a malformed op still blocks
    const bad = validateAppDefinition(withBinding({ kind: 'records', tableId: 'tbl_people', filter: [{ field: 'name', op: 'zap' }] }), dataOpts({ dataRefsAsWarnings: true }));
    assert.ok(has(bad.errors, 'binding.filter_invalid'));
});

test('binding.unknown_connector: connector bindings resolve against model.connectors[]', () => {
    // DATA_MODEL has no connectors → every connector ref is unknown (publish-gate error).
    const res = validateAppDefinition(withBinding({ kind: 'connector', connectorId: 'conn_ghost1' }), dataOpts());
    const rec = res.errors.find((e) => e.code === 'binding.unknown_connector');
    assert.ok(rec, JSON.stringify(res.errors));
    assert.equal(rec.severity, 'error');
    assert.ok(rec.path && rec.message && rec.hint);
    // A model carrying the connector resolves clean.
    const modelWithConn = { ...DATA_MODEL, connectors: [{ id: 'conn_ok0001', kind: 'automation', name: 'X', automationId: 'a' }] };
    assert.ok(!has(validateAppDefinition(withBinding({ kind: 'connector', connectorId: 'conn_ok0001' }), { dataModel: modelWithConn, datasets: [] }).errors, 'binding.unknown_connector'));
    // Without a data model (draft) it is only an unverified WARNING, never an error.
    const draft = validateAppDefinition(withBinding({ kind: 'connector', connectorId: 'conn_ok0001' }), {});
    assert.ok(!has(draft.errors, 'binding.unknown_connector'));
    // connector params: a formula param compiles; a bad literal errors.
    assert.ok(has(validateAppDefinition(withBinding({ kind: 'connector', connectorId: 'conn_ok0001', params: { q: { kind: 'formula', expr: 'vars.q' } } }), { dataModel: modelWithConn, datasets: [] }).errors, 'binding.unknown_connector') === false);
    assert.ok(has(validateAppDefinition(withBinding({ kind: 'connector', connectorId: 'conn_ok0001', params: { q: { nested: true } } }), { dataModel: modelWithConn, datasets: [] }).errors, 'binding.params_invalid'));
});

// ── send_email ──────────────────────────────────────────────────────────────

const MAILBOX_MODEL = {
    ...DATA_MODEL,
    connectors: [
        { id: 'conn_mail01', kind: 'mailbox', name: 'Inbox', provider: 'gmail',
          sync: { tableId: 'tbl_people', mode: 'upsert', keyField: 'provider_message_id', retentionDays: 90 } },
        { id: 'conn_rest01', kind: 'rest', name: 'Feed', url: 'https://example.com/f' },
    ],
};

function withAction(action) {
    const def = structuredClone(baseV2);
    def.actions = { ...(def.actions || {}), act_mail01: action };
    return def;
}

const sendStep = (extra = {}) => ({
    kind: 'send_email',
    connectorId: 'conn_mail01',
    body: { kind: 'static', value: 'hoi' },
    ...extra,
});

test('send_email validates against a mailbox connector', () => {
    const res = validateAppDefinition(
        withAction({ kind: 'sequence', steps: [sendStep()] }),
        { dataModel: MAILBOX_MODEL, datasets: [] },
    );
    assert.ok(!has(res.errors, 'action.send_email_connector_invalid'), JSON.stringify(res.errors));
});

test('send_email pointed at a non-mailbox connector is a publish-gate error', () => {
    // It would validate against the generic connector list and then fail at
    // runtime with nothing the author could act on.
    const res = validateAppDefinition(
        withAction({ kind: 'sequence', steps: [sendStep({ connectorId: 'conn_rest01' })] }),
        { dataModel: MAILBOX_MODEL, datasets: [] },
    );
    assert.ok(has(res.errors, 'action.send_email_connector_invalid'), JSON.stringify(res.errors));
});

test('send_email may NOT run inside a loop', () => {
    // One click over a 500-row binding would be 500 outbound messages from a
    // real person's mailbox. This is the guard that matters most on this step.
    const res = validateAppDefinition(
        withAction({
            kind: 'sequence',
            steps: [{
                kind: 'loop',
                source: { kind: 'static', value: [] },
                steps: [sendStep()],
            }],
        }),
        { dataModel: MAILBOX_MODEL, datasets: [] },
    );
    assert.ok(has(res.errors, 'action.send_email_in_loop'), JSON.stringify(res.errors));
});

test('burying the send deeper inside the loop does not evade the guard', () => {
    const res = validateAppDefinition(
        withAction({
            kind: 'sequence',
            steps: [{
                kind: 'loop',
                source: { kind: 'static', value: [] },
                steps: [{
                    kind: 'condition',
                    expr: 'vars.ok',
                    then: [sendStep()],
                }],
            }],
        }),
        { dataModel: MAILBOX_MODEL, datasets: [] },
    );
    assert.ok(has(res.errors, 'action.send_email_in_loop'), JSON.stringify(res.errors));
});

test('a send_email outside any loop stays legal', () => {
    const res = validateAppDefinition(
        withAction({
            kind: 'sequence',
            steps: [
                { kind: 'condition', expr: 'vars.ok', then: [sendStep()] },
                { kind: 'toast', message: 'Verstuurd' },
            ],
        }),
        { dataModel: MAILBOX_MODEL, datasets: [] },
    );
    assert.ok(!has(res.errors, 'action.send_email_in_loop'), JSON.stringify(res.errors));
});

// ── aggregate binding ───────────────────────────────────────────────────────

test('aggregate binding: a count-per-field validates clean', () => {
    // The whole sidebar pill row of a support desk is this one binding.
    const res = validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people',
        groupBy: [{ field: 'status' }],
        aggregates: [{ fn: 'count', as: 'count' }],
    }), dataOpts());
    assert.ok(!has(res.errors, 'binding.aggregate_invalid'), JSON.stringify(res.errors));
    assert.ok(!has(res.errors, 'binding.unknown_field'), JSON.stringify(res.errors));
});

test('aggregate binding: table and field references are resolved', () => {
    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_ghost', aggregates: [{ fn: 'count' }],
    }), dataOpts()).errors, 'binding.unknown_table'));

    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people', groupBy: [{ field: 'nope' }],
    }), dataOpts()).errors, 'binding.unknown_field'));

    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people', aggregates: [{ fn: 'sum', field: 'nope' }],
    }), dataOpts()).errors, 'binding.unknown_field'));
});

test('aggregate binding: unknown function or bucket errors', () => {
    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people', aggregates: [{ fn: 'median', field: 'name' }],
    }), dataOpts()).errors, 'binding.aggregate_invalid'));

    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people', groupBy: [{ field: 'name', bucket: 'decade' }],
    }), dataOpts()).errors, 'binding.aggregate_invalid'));
});

test('aggregate binding: only count may run without a field', () => {
    assert.ok(!has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people', aggregates: [{ fn: 'count' }],
    }), dataOpts()).errors, 'binding.aggregate_invalid'));

    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people', aggregates: [{ fn: 'p50' }],
    }), dataOpts()).errors, 'binding.aggregate_invalid'));
});

test('aggregate binding: an empty descriptor is refused', () => {
    // It would compile to nothing and silently render an empty tile.
    assert.ok(has(validateAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people',
    }), dataOpts()).errors, 'binding.aggregate_empty'));
});

test('aggregate binding: canonicalize drops what the compiler would reject', () => {
    const def = canonicalizeAppDefinition(withBinding({
        kind: 'aggregate', tableId: 'tbl_people',
        groupBy: [{ field: 'status', bucket: 'decade' }, { field: 'name' }],
        aggregates: [{ fn: 'median', field: 'name' }, { fn: 'count', as: 'n' }],
        pick: { row: 'first', column: 'n' },
    })).def;
    const b = def.screens[0].sections[0].children[0].props.source;

    assert.equal(b.kind, 'aggregate');
    assert.equal(b.groupBy.length, 2);
    assert.ok(!('bucket' in b.groupBy[0]), 'an unknown bucket is stripped, not stored');
    assert.deepEqual(b.aggregates, [{ fn: 'count', as: 'n' }]);
    assert.deepEqual(b.pick, { row: 'first', column: 'n' });
});

// ── Structural warnings: things that pass every shape check and still don't work
//
// These three rules exist because the support-desk template validated with zero
// errors AND zero warnings while being visibly broken: an action wired to
// nothing (its screen was permanently empty), a pane that clipped its own reply
// composer off the bottom, and buttons that did nothing when clicked. Shape
// validation cannot see any of that, so it has to be stated separately.

test('an action no component can reach is a warning', () => {
    const res = broken((d) => { d.actions.act_orph01 = { kind: 'toast', message: 'hi', tone: 'info' }; });
    assert.ok(has(res.warnings, 'action.unreachable'));
    assert.equal(res.errors.length, 0, 'a half-wired app still saves');

    // A ROW action counts as wiring — it is how a repeater/data_grid runs one.
    const wired = broken((d) => {
        d.actions.act_orph01 = { kind: 'toast', message: 'hi', tone: 'info' };
        kids(d)[10].props.itemActions = [{ label: 'Do', actionId: 'act_orph01' }];
        kids(d)[10].type = 'repeater';
        kids(d)[10].children = [];
    });
    assert.ok(!has(wired.warnings, 'action.unreachable'));

    // data_grid's spelling of the same idea (props.rowActions) counts too —
    // the reachability walker and the runtime must agree on both prop names.
    const gridWired = brokenV2((d) => {
        d.actions.act_orph01 = { kind: 'toast', message: 'hi', tone: 'info' };
        kidsV2(d)[0].props.rowActions = [{ label: 'Do', actionId: 'act_orph01' }];
    });
    assert.ok(!has(gridWired.warnings, 'action.unreachable'));
});

test('a per-row actionId must resolve; empty string stays the unwired state', () => {
    // A typo'd rowActions actionId used to validate clean and render a button
    // that silently did nothing (AppDataGrid runs entry.actionId on click).
    assert.ok(has(brokenV2((d) => {
        kidsV2(d)[0].props.rowActions = [{ label: 'Do', actionId: 'act_ghost9' }];
    }).errors, 'event.action_unresolved'));
    // The inspector's "not wired yet" state is deliberate and legal.
    assert.ok(!has(brokenV2((d) => {
        kidsV2(d)[0].props.rowActions = [{ label: 'Do', actionId: '' }];
    }).errors, 'event.action_unresolved'));
});

test('a button wired to nothing is a warning, unless it submits a form', () => {
    assert.ok(has(broken((d) => { delete kids(d)[2].onClick; }).warnings, 'component.control_inert'));
    // role:'submit' INSIDE a form is the one legitimate wire-free button.
    assert.ok(!has(broken((d) => {
        kids(d)[12].children.push({
            id: 'cmp_btnsub1', type: 'button', props: { label: 'Send', role: 'submit' },
        });
    }).warnings, 'component.control_inert'));
    // …and outside one it is exactly as dead as any other unwired button: the
    // runtime gives it type="submit" and no onClick, and there is no enclosing
    // <form> for the browser to submit. The exemption used to be granted on the
    // role alone, regardless of where the button sat.
    assert.ok(has(broken((d) => {
        delete kids(d)[2].onClick;
        kids(d)[2].props.role = 'submit';
    }).warnings, 'component.control_inert'));
});

test('a form that shows a Submit button but has no onSubmit is a warning', () => {
    assert.ok(has(broken((d) => { delete kids(d)[12].onSubmit; }).warnings, 'form.no_submit_action'));
    // A form whose fields save themselves says so by hiding the button.
    assert.ok(!has(broken((d) => {
        delete kids(d)[12].onSubmit;
        kids(d)[12].props.showSubmit = false;
    }).warnings, 'form.no_submit_action'));
    assert.ok(!has(broken(() => {}).warnings, 'form.no_submit_action'));
});

test('a non-scrolling pane that stacks more than it can show is a warning', () => {
    const paneWith = (n, props) => (d) => {
        d.screens[1].sections[0].children = [{
            id: 'cmp_pane01', type: 'pane', props,
            children: Array.from({ length: n }, (_, i) => ({
                id: `cmp_p${String(i).padStart(5, '0')}`, type: 'text', props: { text: `row ${i}` },
            })),
        }];
    };
    assert.ok(has(broken(paneWith(11, { scroll: 'none' })).warnings, 'component.pane_clips'));
    // Its own scrollbar → nothing is cut off.
    assert.ok(!has(broken(paneWith(11, { scroll: 'auto' })).warnings, 'component.pane_clips'));
    // A short stack fits.
    assert.ok(!has(broken(paneWith(3, { scroll: 'none' })).warnings, 'component.pane_clips'));
});

test('a pane whose growing child fills is fine however many children it has', () => {
    const res = broken((d) => {
        d.screens[1].sections[0].children = [{
            id: 'cmp_pane02', type: 'pane', props: { scroll: 'none' },
            children: [
                ...Array.from({ length: 10 }, (_, i) => ({
                    id: `cmp_q${String(i).padStart(5, '0')}`, type: 'text', props: { text: `row ${i}` },
                })),
                { id: 'cmp_fill01', type: 'text', props: { text: 'grows' }, style: { height: 'fill' } },
            ],
        }];
    });
    assert.ok(!has(res.warnings, 'component.pane_clips'));
});

test('a server-side formula reading a currentUser attribute the server has no idea about warns', () => {
    // The bug this pins: the editor's scope panel offered currentUser.name, the
    // browser resolved it, and buildServerScope had only id + roles — so every
    // audit row an action wrote recorded an empty "Who", for as long as the
    // feature existed, with nothing anywhere saying so.
    const withStep = (expr) => broken((d) => {
        d.actions.act_toast1 = {
            kind: 'sequence',
            steps: [{
                kind: 'create_record', tableId: 'tbl_people',
                values: { who: { kind: 'formula', expr } },
            }],
        };
    }, { knownTables: ['tbl_people'] });

    assert.ok(has(withStep('currentUser.displayName').warnings, 'formula.server_scope_unknown'));
    // The attributes the server DOES build are silent…
    assert.ok(!has(withStep('currentUser.name').warnings, 'formula.server_scope_unknown'));
    assert.ok(!has(withStep('currentUser.email').warnings, 'formula.server_scope_unknown'));
    assert.ok(!has(withStep('currentUser.id').warnings, 'formula.server_scope_unknown'));
});

test('a CLIENT step keeps the full browser scope — no server-scope warning there', () => {
    const res = broken((d) => {
        d.actions.act_toast1 = {
            kind: 'sequence',
            steps: [{ kind: 'set_variable', name: 'who', value: { kind: 'formula', expr: 'currentUser.displayName' } }],
        };
    });
    assert.ok(!has(res.warnings, 'formula.server_scope_unknown'));
});

test('send_email that says nothing about what it replies to warns', () => {
    const send = (extra) => broken((d) => {
        d.actions.act_toast1 = {
            kind: 'sequence',
            steps: [{
                kind: 'send_email', connectorId: 'conn_x',
                body: { kind: 'static', value: 'hi' }, ...extra,
            }],
        };
    });
    // Unthreaded: the customer gets a detached mail and the next sync files it
    // as a SECOND ticket.
    assert.ok(has(send({}).warnings, 'action.send_email_unthreaded'));
    assert.ok(!has(send({ replyToThreadKey: { kind: 'formula', expr: 'vars.thread' } }).warnings, 'action.send_email_unthreaded'));
    assert.ok(!has(send({ replyToRecordId: { kind: 'formula', expr: 'vars.msgId' } }).warnings, 'action.send_email_unthreaded'));
    // Both at once is an error — the two answers can disagree.
    assert.ok(has(send({
        replyToRecordId: { kind: 'formula', expr: 'vars.msgId' },
        replyToThreadKey: { kind: 'formula', expr: 'vars.thread' },
    }).errors, 'action.send_email_reply_ambiguous'));
});

// ── Advanced sizing — px/% width and height ─────────────────────────────────
//
// kids()[0] is a heading (span, no height); kids()[11] is a card (span AND
// height) sitting directly in an auto-height section.

test('advanced sizing: a legal px/% width validates clean and does not disturb span', () => {
    // The contract: the value sizes the BOX, `span` still places the CELL, so
    // both may be set at once and neither is an error.
    assert.equal(broken((d) => { kids(d)[0].style.widthMode = 'px'; kids(d)[0].style.widthValue = 240; }).ok, true);
    assert.equal(broken((d) => {
        kids(d)[0].style.span = 6;
        kids(d)[0].style.widthMode = 'pct';
        kids(d)[0].style.widthValue = 60;
    }).ok, true);
    assert.equal(broken((d) => { kids(d)[11].style.heightMode = 'vh'; kids(d)[11].style.heightValue = 70; }).ok, true);
});

test('advanced sizing: the pairs must agree — a value with no unit, a unit with no value', () => {
    // A measurement nobody can read: widthValue alone means nothing, because
    // the unit lives in widthMode and its default ('span') carries no number.
    const orphanValue = broken((d) => { kids(d)[0].style.widthValue = 900; });
    assert.ok(has(orphanValue.errors, 'style.unit_without_mode'));
    const rec = orphanValue.errors.find((e) => e.code === 'style.unit_without_mode');
    assert.match(rec.message, /widthMode/);
    assert.match(rec.message, /ignored/);
    assert.match(rec.hint, /"px"/);

    // Explicitly saying 'span' is the same case, said out loud.
    assert.ok(has(broken((d) => { kids(d)[0].style.widthMode = 'span'; kids(d)[0].style.widthValue = 900; }).errors, 'style.unit_without_mode'));
    assert.ok(has(broken((d) => { kids(d)[11].style.heightValue = 300; }).errors, 'style.unit_without_mode'));

    // The mirror image: a unit with nothing to apply renders as if untouched.
    const orphanMode = broken((d) => { kids(d)[0].style.widthMode = 'px'; });
    assert.ok(has(orphanMode.errors, 'style.mode_without_value'));
    assert.match(orphanMode.errors.find((e) => e.code === 'style.mode_without_value').hint, /40\.\.2000/);
    assert.ok(has(broken((d) => { kids(d)[11].style.heightMode = 'vh'; }).errors, 'style.mode_without_value'));

    // null is the legitimate "not set" state, not a half-configured pair.
    assert.equal(broken((d) => { kids(d)[0].style.widthValue = null; }).ok, true);
});

test('advanced sizing: a value outside its unit range is an error naming that unit', () => {
    const tooWide = broken((d) => { kids(d)[0].style.widthMode = 'px'; kids(d)[0].style.widthValue = 5000; });
    assert.ok(has(tooWide.errors, 'style.invalid'));
    assert.match(tooWide.errors.find((e) => e.code === 'style.invalid').message, /px range 40\.\.2000/);

    // 900 is fine in px and nonsense in pct — the SAME number, judged by the mode.
    assert.equal(broken((d) => { kids(d)[0].style.widthMode = 'px'; kids(d)[0].style.widthValue = 900; }).ok, true);
    assert.ok(has(broken((d) => { kids(d)[0].style.widthMode = 'pct'; kids(d)[0].style.widthValue = 900; }).errors, 'style.invalid'));
    assert.ok(has(broken((d) => { kids(d)[0].style.widthMode = 'px'; kids(d)[0].style.widthValue = 100.5; }).errors, 'style.invalid'));
});

test('responsive visibility: legal on span-bearing types, refused where there is no span', () => {
    assert.equal(broken((d) => { kids(d)[0].style.hideBelow = 'md'; kids(d)[0].style.hideAbove = 'lg'; }).ok, true);
    assert.ok(has(broken((d) => { kids(d)[0].style.hideBelow = 'huge'; }).errors, 'style.invalid'));
    // A modal has no span — its box is a portaled dialog, not a grid cell.
    assert.ok(has(brokenV2((d) => { kidsV2(d)[6].style = { hideBelow: 'sm' }; }).errors, 'style.unknown_key'));
});

// A percentage-height child, for pushing into whatever container is under test.
const pctChild = (id, heightValue = 80) => ({
    id, type: 'list', props: { source: { kind: 'static', value: [] }, titleKey: 't' },
    style: { heightMode: 'pct', heightValue },
});
const pctErr = (res) => res.errors.find((e) => e.code === 'style.height_pct_indefinite');

test('advanced sizing: a percentage height is rejected unless its parent HANDS one down', () => {
    // The card sits in an auto-height section, so `50%` of nothing is nothing —
    // and a knob that silently does nothing is the failure mode this rejects.
    const floating = broken((d) => { kids(d)[11].style.heightMode = 'pct'; kids(d)[11].style.heightValue = 50; });
    assert.ok(has(floating.errors, 'style.height_pct_indefinite'));
    const rec = floating.errors.find((e) => e.code === 'style.height_pct_indefinite');
    assert.match(rec.message, /section/);
    assert.match(rec.hint, /"vh"|"px"/);

    // Give the section a height and the very same style becomes legal.
    for (const sectionHeight of ['fill', 'lg']) {
        assert.equal(broken((d) => {
            d.screens[0].sections[0].style.height = sectionHeight;
            kids(d)[11].style.heightMode = 'pct';
            kids(d)[11].style.heightValue = 50;
        }).ok, true, `section height ${sectionHeight}`);
    }
    // ...as does a section sized in vh.
    assert.equal(broken((d) => {
        d.screens[0].sections[0].style.heightMode = 'vh';
        d.screens[0].sections[0].style.heightValue = 90;
        kids(d)[11].style.heightMode = 'pct';
        kids(d)[11].style.heightValue = 50;
    }).ok, true);

    // CHANGED (this block pinned the shipped behaviour, and the shipped
    // behaviour was wrong): a card at `height:'md'` used to make a percentage
    // child legal, and the browser then collapsed it to nothing — the exact
    // "silently does nothing" outcome this error code exists to prevent. The
    // card's 200px lands on its grid CELL; AppCard renders an auto-height
    // wrapper plus its own grid inside that cell and gives them
    // `h-full`/`flex-1` ONLY when the card is filling. So the child has nothing
    // to measure against, and validation now says so instead of blessing it.
    for (const cardHeight of [{ height: 'md' }, { heightMode: 'px', heightValue: 400 }, { heightMode: 'vh', heightValue: 60 }]) {
        const res = broken((d) => {
            Object.assign(kids(d)[11].style, cardHeight);
            kids(d)[11].children.push(pctChild('cmp_lst009'));
        });
        assert.ok(has(res.errors, 'style.height_pct_indefinite'), JSON.stringify(cardHeight));
        // The message must name the move that fixes it, not just the symptom.
        assert.match(pctErr(res).message, /only passes its height down .*"fill"/);
        assert.match(pctErr(res).hint, /`height` to "fill"/);
        assert.match(pctErr(res).hint, /"px"|"vh"/);
    }
    // ...and an auto-height card does not help either.
    assert.ok(has(broken((d) => {
        kids(d)[11].children.push(pctChild('cmp_lst009'));
    }).errors, 'style.height_pct_indefinite'));

    // The one shape that DOES work, and the one the message points at: a fill
    // card inside a full-height section. AppCard threads `h-full min-h-0` /
    // `flex-1 min-h-0` down exactly here, and nowhere else.
    assert.equal(broken((d) => {
        d.screens[0].sections[0].style.height = 'fill';
        kids(d)[11].style.height = 'fill';
        kids(d)[11].children.push(pctChild('cmp_lst009'));
    }).ok, true, 'fill card in a fill section');
    assert.equal(broken((d) => {
        d.screens[0].sections[0].style.heightMode = 'px';
        d.screens[0].sections[0].style.heightValue = 600;
        kids(d)[11].style.height = 'fill';
        kids(d)[11].children.push(pctChild('cmp_lst009'));
    }).ok, true, 'fill card in a px section');

    // CHANGED, same family, found while fixing the above: `height:'fill'` is
    // not a height on its own — it renders as `h-full`, and 100% of an
    // auto-height section is auto. A fill card in an auto section was accepted
    // and collapsed exactly like the case above.
    assert.ok(has(broken((d) => {
        kids(d)[11].style.height = 'fill';
        kids(d)[11].children.push(pctChild('cmp_lst009'));
    }).errors, 'style.height_pct_indefinite'), 'fill card in an AUTO section');

    // A stale `height:'fill'` beside an explicit heightMode is not a fill card:
    // the runtime's isFill() lets the mode win, so the wrapper stays auto.
    assert.ok(has(broken((d) => {
        d.screens[0].sections[0].style.height = 'fill';
        Object.assign(kids(d)[11].style, { height: 'fill', heightMode: 'px', heightValue: 300 });
        kids(d)[11].children.push(pctChild('cmp_lst009'));
    }).errors, 'style.height_pct_indefinite'), 'an explicit mode outranks a stale fill');
});

test('advanced sizing: each KIND of container answers the percentage question separately', () => {
    // The v2 fixture is the one carrying a container/tabs/repeater/page_header:
    //   4 repeater · 5 tabs · 6 modal · 7 form · 8 page_header · 9 container
    // `container` threads exactly like a card (AppContainer.jsx) — fill only.
    assert.ok(has(brokenV2((d) => {
        kidsV2(d)[9].style = { ...kidsV2(d)[9].style, height: 'md' };
        kidsV2(d)[9].children.push(pctChild('cmp_lst010'));
    }).errors, 'style.height_pct_indefinite'), 'container at height md');
    assert.equal(brokenV2((d) => {
        d.screens[0].sections[0].style.height = 'fill';
        kidsV2(d)[9].style = { ...kidsV2(d)[9].style, height: 'fill' };
        kidsV2(d)[9].children.push(pctChild('cmp_lst010'));
    }).ok, true, 'fill container in a fill section');

    // A PANE is the one container that wraps its children in an unconditional
    // `h-full` (AppPane.jsx), so every height it can have reaches them. px and
    // vh are the documented answer and must not become collateral damage here.
    const withPane = (paneStyle) => broken((d) => {
        kids(d).push({
            id: 'cmp_pane01', type: 'pane', props: { direction: 'vertical', scroll: 'auto' },
            style: { span: 12, ...paneStyle }, children: [pctChild('cmp_lst011')],
        });
    });
    for (const paneStyle of [{ height: 'md' }, { height: 'xl' }, { heightMode: 'px', heightValue: 500 }, { heightMode: 'vh', heightValue: 70 }]) {
        assert.equal(withPane(paneStyle).ok, true, `pane ${JSON.stringify(paneStyle)}`);
    }
    // An auto pane has nothing to hand down — and here "give the parent a
    // height" IS the true advice, which is why the message is not shared with
    // the card case above.
    const autoPane = withPane({});
    assert.ok(has(autoPane.errors, 'style.height_pct_indefinite'));
    assert.match(pctErr(autoPane).message, /pane is auto-height/);
    assert.match(pctErr(autoPane).hint, /Give the pane a `height`/);

    // A `tab` owns a height knob now and rides the fill route, so the advice is
    // the card/container one: make the TAB fill, do not go looking for a wrapper.
    const inTab = brokenV2((d) => { kidsV2(d)[5].children[0].children.push(pctChild('cmp_lst012')); });
    assert.ok(has(inTab.errors, 'style.height_pct_indefinite'));
    assert.match(pctErr(inTab).message, /tab only passes its height down/);
    assert.match(pctErr(inTab).hint, /Set the tab's `height` to "fill"/);

    // A container type with no `height` knob can never pass one on, whatever
    // the author does to it — so the hint sends them somewhere else entirely.
    const inForm = brokenV2((d) => { kidsV2(d)[7].children.push(pctChild('cmp_lst017')); });
    assert.match(pctErr(inForm).message, /form has no height of its own/);
    assert.match(pctErr(inForm).hint, /Wrap this list in a card or container/);
    for (const [label, mutate] of [
        ['form', (d) => kidsV2(d)[7].children.push(pctChild('cmp_lst013'))],
        ['repeater', (d) => kidsV2(d)[4].children.push(pctChild('cmp_lst014'))],
        ['page_header', (d) => kidsV2(d)[8].children.push(pctChild('cmp_lst015'))],
        ['modal', (d) => kidsV2(d)[6].children.push(pctChild('cmp_lst016'))],
    ]) {
        // Even under a full-height section: the missing link is the container
        // itself, not the screen above it.
        const res = brokenV2((d) => { d.screens[0].sections[0].style.height = 'fill'; mutate(d); });
        assert.ok(has(res.errors, 'style.height_pct_indefinite'), label);
        assert.match(pctErr(res).message, /has no height of its own/, label);
    }
});

test('advanced sizing: the recursion — a relative parent is only as definite as ITS parent', () => {
    // 50%-of-50%: legal under a real height, illegal under auto. Through panes,
    // because a pane is the container that actually passes a height down.
    const nest = (sectionStyle) => (d) => {
        Object.assign(d.screens[0].sections[0].style, sectionStyle);
        kids(d).push({
            id: 'cmp_pane01', type: 'pane', props: { direction: 'vertical', scroll: 'auto' },
            style: { span: 12, height: 'fill' },
            children: [{
                id: 'cmp_pane02', type: 'pane', props: { direction: 'vertical', scroll: 'auto' },
                style: { span: 12, heightMode: 'pct', heightValue: 50 },
                children: [pctChild('cmp_lst017', 50)],
            }],
        });
    };
    assert.equal(broken(nest({ height: 'fill' })).ok, true, '50% of 50% under a full-height section');
    assert.equal(broken(nest({ heightMode: 'vh', heightValue: 80 })).ok, true, '…and under a vh section');
    // Under an auto section the whole chain is auto: the outer pane's `fill` is
    // 100% of nothing, so BOTH percentages are refused, not just the deepest.
    const collapsed = broken(nest({}));
    assert.equal(collapsed.errors.filter((e) => e.code === 'style.height_pct_indefinite').length, 2);
});

test('advanced sizing: px and vh stay usable everywhere pct is refused', () => {
    // Refusing pct is only honest if the documented answer still works in
    // exactly those positions — otherwise the fix is just a smaller feature.
    for (const style of [{ heightMode: 'px', heightValue: 300 }, { heightMode: 'vh', heightValue: 40 }]) {
        const fixed = (id) => ({ id, type: 'list', props: { source: { kind: 'static', value: [] }, titleKey: 't' }, style: { ...style } });
        assert.equal(broken((d) => {
            kids(d)[11].style.height = 'md';                             // card, auto wrapper
            kids(d)[11].children.push(fixed('cmp_lst018'));
            kids(d)[12].children.push(fixed('cmp_lst020'));              // form (no height knob)
        }).ok, true, `base ${JSON.stringify(style)}`);
        assert.equal(brokenV2((d) => {
            kidsV2(d)[9].children.push(fixed('cmp_lst019'));             // auto container
            kidsV2(d)[5].children[0].children.push(fixed('cmp_lst021')); // tab
            kidsV2(d)[8].children.push(fixed('cmp_lst022'));             // page_header
        }).ok, true, `v2 ${JSON.stringify(style)}`);
    }
});

test('advanced sizing: a section may never use a percentage height', () => {
    const res = broken((d) => {
        d.screens[0].sections[0].style.heightMode = 'pct';
        d.screens[0].sections[0].style.heightValue = 50;
    });
    assert.ok(has(res.errors, 'style.height_pct_indefinite'));
    assert.match(res.errors.find((e) => e.code === 'style.height_pct_indefinite').message, /screen/);
    // vh/px on a section are the supported answers.
    assert.equal(broken((d) => {
        d.screens[0].sections[0].style.heightMode = 'px';
        d.screens[0].sections[0].style.heightValue = 600;
    }).ok, true);
});

test('advanced sizing: knobs are derived — a type without span/height cannot use them', () => {
    // heading has `span` but no `height`: the width pair applies, the height
    // pair does not, and the hint lists what actually is legal.
    const res = broken((d) => { kids(d)[0].style.heightMode = 'px'; kids(d)[0].style.heightValue = 100; });
    assert.ok(has(res.errors, 'style.unknown_key'));
    assert.match(res.errors.find((e) => e.code === 'style.unknown_key').hint, /widthMode/);
    assert.ok(!has(broken((d) => { kids(d)[0].style.widthMode = 'px'; kids(d)[0].style.widthValue = 100; }).errors, 'style.unknown_key'));
});

// ── dataset_query: the selector-arity rule and what it must NOT block ───────
//
// A genome search screen is one form with three optional fields — gene OR
// region OR rsID — wired to ONE step. Every selector is then a formula reading
// form.<name>. An arity rule that counted those as "set" made that screen
// unbuildable and pushed authors towards three near-identical actions, so the
// static check now judges only what it can actually decide.

function datasetQueryDef(step) {
    return {
        schemaVersion: 2,
        meta: { name: 'Genome', description: '', icon: 'Dna' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_g',
        screens: [{
            id: 'scr_g', name: 'Genome', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_g', style: {}, children: [] }],
        }],
        actions: { act_q: { kind: 'sequence', steps: [{ kind: 'dataset_query', dataset: { kind: 'formula', expr: 'form.dataset' }, resultVar: 'out', ...step }] } },
    };
}
const dqCodes = (step) => {
    const res = validateAppDefinition(datasetQueryDef(step));
    return { errors: res.errors, warnings: res.warnings };
};

test('dataset_query: three FORM-DRIVEN selectors are allowed — the run time decides arity', () => {
    const { errors } = dqCodes({
        gene: { kind: 'formula', expr: 'form.gene' },
        region: { kind: 'formula', expr: 'form.region' },
        rsid: { kind: 'formula', expr: 'form.rsid' },
    });
    assert.ok(!has(errors, 'action.dataset_query_selector'),
        'a one-form/three-optional-fields search must be buildable');
});

test('dataset_query: two FIXED selectors are still an error — that is decidable here', () => {
    const { errors } = dqCodes({ gene: 'BRCA1', rsid: 'rs429358' });
    assert.ok(has(errors, 'action.dataset_query_selector'));
    assert.match(errors.find((e) => e.code === 'action.dataset_query_selector').message, /gene and rsid/);
});

test('dataset_query: no selector at all is an error — that would ask for the whole file', () => {
    const { errors } = dqCodes({});
    assert.ok(has(errors, 'action.dataset_query_selector'));
    assert.match(errors.find((e) => e.code === 'action.dataset_query_selector').message, /needs a slice selector/);
});

test('dataset_query: exactly one fixed selector is clean', () => {
    assert.ok(!has(dqCodes({ gene: 'BRCA1' }).errors, 'action.dataset_query_selector'));
    assert.ok(!has(dqCodes({ region: { kind: 'static', value: 'chr17:100-200' } }).errors, 'action.dataset_query_selector'));
});

test('dataset_query: a fixed selector NEXT TO a form one warns — it can only ever conflict', () => {
    const { errors, warnings } = dqCodes({ gene: 'BRCA1', rsid: { kind: 'formula', expr: 'form.rsid' } });
    // Not an error: it runs fine until the viewer fills the field. But the
    // fixed selector is always set, so the moment they do, arity fails.
    assert.ok(!has(errors, 'action.dataset_query_selector'));
    assert.ok(has(warnings, 'action.dataset_query_mixed_selector'));
});

test('dataset_query: an EMPTY fixed selector does not count as set', () => {
    // A cleared field left behind as "" must not make a single-selector step
    // read as a two-selector one.
    assert.ok(!has(dqCodes({ gene: 'BRCA1', region: '' }).errors, 'action.dataset_query_selector'));
});

// ── create_record as a top-level ACTION ────────────────────────────────────

/**
 * The same checks the STEP gets. validateAction hand-writes per-kind checks and
 * ran the generic per-field validator for the AI kinds only, so a bare
 * create_record action would have inherited that gap: a table that does not
 * exist, a column that does not exist, a values map that is not a map — all
 * saved cleanly and failed at the first click, which is the shape of bug this
 * whole redesign exists to stop shipping.
 */
test('create_record ACTION is checked per field, exactly like the step', () => {
    const withAction = (action) => {
        const def = structuredClone(baseV2);
        def.actions.act_add001 = action;
        return def;
    };

    const ghostTable = validateAppDefinition(withAction({
        kind: 'create_record', tableId: 'tbl_ghost', values: { name: { kind: 'static', value: 'x' } },
    }), dataOpts());
    assert.ok(has(ghostTable.errors, 'step.unknown_table'), JSON.stringify(ghostTable.errors));

    const ghostField = validateAppDefinition(withAction({
        kind: 'create_record', tableId: 'tbl_people', values: { nope: { kind: 'static', value: 'x' } },
    }), dataOpts());
    assert.ok(has(ghostField.errors, 'step.unknown_field'), JSON.stringify(ghostField.errors));

    // A table that was never picked is flagged — the same soft "not until you
    // publish" warning the STEP gets, not silence.
    const noTable = validateAppDefinition(withAction({
        kind: 'create_record', values: { name: { kind: 'static', value: 'x' } },
    }), dataOpts());
    const noTableCodes = [...noTable.errors, ...noTable.warnings].map((r) => r.code);
    assert.ok(noTableCodes.length > 0, 'a create_record with no table said nothing at all');

    const badValues = validateAppDefinition(withAction({
        kind: 'create_record', tableId: 'tbl_people', values: 'name=x',
    }), dataOpts());
    assert.ok(has(badValues.errors, 'action.step_field_invalid'), JSON.stringify(badValues.errors));

    // A binding that points at nothing is caught too.
    const ghostAction = validateAppDefinition(withAction({
        kind: 'create_record',
        tableId: 'tbl_people',
        values: { name: { kind: 'actionResult', actionId: 'act_nope', path: 'result.x' } },
    }), dataOpts());
    assert.ok(has(ghostAction.errors, 'binding.action_unresolved'), JSON.stringify(ghostAction.errors));

    // …and a clean one passes.
    const clean = validateAppDefinition(withAction({
        kind: 'create_record',
        tableId: 'tbl_people',
        values: { name: { kind: 'static', value: 'x' }, status: { kind: 'formula', expr: 'vars.status' } },
        resultVar: 'created',
    }), dataOpts());
    assert.deepEqual(clean.errors, [], JSON.stringify(clean.errors));
});

/**
 * The strongest form of "exactly like the step": run the SAME payload down both
 * paths and demand the same findings. A per-kind check bolted onto one path and
 * not the other is precisely how the action path ended up with no column check.
 */
test('create_record: the action path and the step path report the same findings', () => {
    const payloads = [
        { kind: 'create_record', tableId: 'tbl_ghost', values: { name: { kind: 'static', value: 'x' } } },
        { kind: 'create_record', tableId: 'tbl_people', values: { nope: { kind: 'static', value: 'x' } } },
        { kind: 'create_record', tableId: 'tbl_people', values: { created_by: { kind: 'static', value: 'me' } } },
        { kind: 'create_record', tableId: 'tbl_people', values: { name: { kind: 'static', value: 'x' } } },
    ];
    // `action.unreachable` is about WIRING, not about the payload: the extra
    // action is not on any component's event, and the extra step is inside one
    // that is. It is the one finding the two paths are meant to differ on.
    const codesOf = (res) => [...res.errors, ...res.warnings]
        .map((r) => r.code).filter((c) => c !== 'action.unreachable').sort();
    for (const payload of payloads) {
        const asAction = structuredClone(baseV2);
        asAction.actions.act_add001 = structuredClone(payload);

        const asStep = structuredClone(baseV2);
        asStep.actions.act_seq01.steps = [structuredClone(payload)];

        assert.deepEqual(
            codesOf(validateAppDefinition(asAction, dataOpts())),
            codesOf(validateAppDefinition(asStep, dataOpts())),
            `action and step disagree on ${JSON.stringify(payload)}`,
        );
    }
});

// An action-level message that says "Step" is a message about the wrong thing:
// the author is looking at an action editor, not a flow canvas.
test('action-level field errors name the ACTION, not a step', () => {
    const def = structuredClone(baseV2);
    def.actions.act_add001 = { kind: 'create_record', tableId: 'tbl_people', values: {}, resultVar: 'x'.repeat(80) };
    const res = validateAppDefinition(def, dataOpts());
    const msg = res.errors.map((e) => e.message).join(' | ');
    assert.ok(/Action "act_add001" \(create_record\)/.test(msg) || /resultVar/.test(msg), msg);
});
