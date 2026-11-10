/**
 * The client triggers of schema 3 on the server: an event slot that holds a list of action
 * ids, screen.events.onOpen, screen.timers and definition.watchers, plus onClick and onChange
 * on the types that newly fire them. Canonical form, schema version, validation, the run
 * gate, the public surface and the AI builder's existing tools.
 *
 * Run: cd server && node --test appStudio/clientTriggers.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { resolvePublicSurface, buildPublicDefinition } = require('./publicAccess');
const { actionRoleAccess } = require('../routes/studioAppRunGate');
const { applyBindActionTool } = require('./builderTools/definitionTools/actions');
const { applyUpdateScreen } = require('./builderTools/definitionTools/screens');
const { applyInspectCatalog } = require('./builderTools/inspectionTools');

const toast = (message) => ({ kind: 'toast', message });

/** One screen, one section, the given nodes; three toast actions. */
function app({ nodes = [], screen = {}, extra = {}, screens = null } = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Triggers', description: '', icon: 'LayoutGrid' },
        homeScreenId: 'scr_home01',
        roles: [],
        screens: screens || [{ id: 'scr_home01', name: 'Home', sections: [{ id: 'sec_main01', style: {}, children: nodes }], ...screen }],
        actions: { act_aaaa01: toast('a'), act_bbbb01: toast('b'), act_cccc01: toast('c') },
        ...extra,
    };
}
const button = (onClick) => ({ id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick });
const canon = (def) => canonicalizeAppDefinition(def);
const node0 = (def) => def.screens[0].sections[0].children[0];
const codes = (findings) => findings.map((f) => f.code);

test('a slot with one id stays a string and the definition stays on the base version', () => {
    const { def } = canon(app({ nodes: [button('act_aaaa01')] }));
    assert.equal(node0(def).onClick, 'act_aaaa01');
    assert.equal(def.schemaVersion, 2);
    const { def: one } = canon(app({ nodes: [button(['act_aaaa01'])] }));
    assert.equal(node0(one).onClick, 'act_aaaa01', 'a list of one is stored as the plain id');
    assert.equal(one.schemaVersion, 2);
});

test('a list of action ids is kept in order, raises the version and is capped at five', () => {
    const { def } = canon(app({ nodes: [button(['act_bbbb01', 'act_aaaa01'])] }));
    assert.deepEqual(node0(def).onClick, ['act_bbbb01', 'act_aaaa01']);
    assert.equal(def.schemaVersion, 3);
    assert.equal(validateAppDefinition(def).errors.length, 0, JSON.stringify(validateAppDefinition(def).errors));

    const six = ['act_aaaa01', 'act_bbbb01', 'act_cccc01', 'act_aaaa01', 'act_bbbb01', 'act_cccc01'];
    const capped = canon(app({ nodes: [button(six)] }));
    assert.equal(node0(capped.def).onClick.length, 5);
    assert.ok(capped.repairs.some((r) => r.code === 'event.too_many_actions'));
});

test('an id that names no action is dropped from a list, and a list with nothing left is removed', () => {
    const { def, repairs } = canon(app({ nodes: [button(['act_aaaa01', 'act_gone01'])] }));
    assert.equal(node0(def).onClick, 'act_aaaa01');
    assert.ok(repairs.some((r) => r.code === 'event.dangling'));
    const { def: none } = canon(app({ nodes: [button(['act_gone01', 'act_gone02'])] }));
    assert.equal(node0(none).onClick, undefined);
});

test('the validator checks every id of a list that skipped the canonicalizer', () => {
    const def = canon(app({ nodes: [button(['act_aaaa01', 'act_bbbb01'])] })).def;
    node0(def).onClick = ['act_aaaa01', 'act_nope01'];
    assert.ok(codes(validateAppDefinition(def).errors).includes('event.action_unresolved'));
});

test('screen.events.onOpen and screen.timers are cleaned, written after the sections, and need version 3', () => {
    const raw = app({ screen: { events: { onOpen: ['act_aaaa01', 'act_bbbb01'], onClose: 'act_cccc01' }, timers: [{ everySeconds: 2, actionId: 'act_cccc01' }, { id: 'poll', everySeconds: 30, actionId: 'act_gone01' }] } });
    const { def, repairs } = canon(raw);
    const screen = def.screens[0];
    assert.deepEqual(screen.events, { onOpen: ['act_aaaa01', 'act_bbbb01'] });
    assert.deepEqual(screen.timers, [{ id: 'timer1', everySeconds: 5, actionId: 'act_cccc01' }]);
    assert.deepEqual(Object.keys(screen).slice(-3), ['sections', 'events', 'timers']);
    assert.equal(def.schemaVersion, 3);
    for (const code of ['screen.events_invalid', 'trigger.number_clamped', 'trigger.id_generated', 'event.dangling']) assert.ok(repairs.some((r) => r.code === code), code);
    assert.deepEqual(validateAppDefinition(def).errors, []);
    assert.deepEqual(canon(def).def, def, 'a second pass changes nothing');
});

test('a screen without triggers keeps its bytes, and null removes them', () => {
    const plain = canon(app()).def;
    assert.equal('events' in plain.screens[0], false);
    assert.equal('timers' in plain.screens[0], false);
    const cleared = canon(app({ screen: { events: null, timers: null } })).def;
    assert.equal(JSON.stringify(cleared), JSON.stringify(plain));
});

test('watchers: cleaned, dangling ones removed, a bad formula is an error, version 3', () => {
    const raw = app({ extra: { watchers: [
        { id: 'status', expr: ' vars.status ', actionId: 'act_aaaa01', debounceMs: 0 },
        { expr: 'vars.x', actionId: 'act_gone01' },
        { id: 'qty', expr: 'vars.qty', actionId: 'act_bbbb01', debounceMs: 99999 },
    ] } });
    const { def } = canon(raw);
    assert.deepEqual(def.watchers, [
        { id: 'status', expr: 'vars.status', actionId: 'act_aaaa01' },
        { id: 'qty', expr: 'vars.qty', actionId: 'act_bbbb01', debounceMs: 10000 },
    ]);
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(validateAppDefinition(def).errors, []);
    def.watchers[0].expr = 'vars.status ==';
    assert.ok(codes(validateAppDefinition(def).errors).includes('formula.parse_error'));
});

test('an action run only by a screen trigger or a watcher is not reported as unreachable', () => {
    const { def } = canon(app({ screen: { events: { onOpen: 'act_aaaa01' }, timers: [{ id: 't', everySeconds: 10, actionId: 'act_bbbb01' }] }, extra: { watchers: [{ id: 'w', expr: 'vars.a', actionId: 'act_cccc01' }] } }));
    const unreachable = validateAppDefinition(def).warnings.filter((w) => w.code === 'action.unreachable');
    assert.deepEqual(unreachable, []);
});

test('card, image, stat, callout and container take onClick, and the five inputs take onChange', () => {
    const nodes = [
        { id: 'cmp_card01', type: 'card', props: {}, children: [], onClick: 'act_aaaa01' },
        { id: 'cmp_img001', type: 'image', props: {}, onClick: 'act_aaaa01' },
        { id: 'cmp_stat01', type: 'stat', props: { label: 'N' }, onClick: 'act_aaaa01' },
        { id: 'cmp_call01', type: 'callout', props: {}, onClick: 'act_aaaa01' },
        { id: 'cmp_cont01', type: 'container', props: {}, children: [], onClick: 'act_aaaa01' },
        { id: 'cmp_form01', type: 'form', props: { name: 'f' }, children: [
            { id: 'cmp_dt0001', type: 'input_datetime', props: { name: 'when', label: 'When' }, onChange: 'act_bbbb01' },
            { id: 'cmp_rel001', type: 'input_relation', props: { name: 'rel', label: 'Rel' }, onChange: 'act_bbbb01' },
            { id: 'cmp_per001', type: 'input_person', props: { name: 'who', label: 'Who' }, onChange: 'act_bbbb01' },
            { id: 'cmp_rich01', type: 'input_richtext', props: { name: 'body', label: 'Body' }, onChange: 'act_bbbb01' },
            { id: 'cmp_html01', type: 'input_html', props: { name: 'mail', label: 'Mail' }, onChange: 'act_bbbb01' },
        ] },
    ];
    const { def } = canon(app({ nodes }));
    assert.equal(def.schemaVersion, 3);
    assert.ok(!codes(validateAppDefinition(def).errors).includes('event.not_supported'), JSON.stringify(validateAppDefinition(def).errors));
    // Without the new events the same app stays on the base version.
    const bare = JSON.parse(JSON.stringify(nodes).replaceAll('"onClick":"act_aaaa01"', '"x":1').replaceAll('"onChange":"act_bbbb01"', '"x":1'));
    assert.equal(canon(app({ nodes: bare })).def.schemaVersion, 2);
});

test('the public surface counts the onOpen and timers of public screens only, and ships only their watchers', () => {
    const screens = [
        { id: 'scr_pub001', name: 'Form', events: { onOpen: 'act_aaaa01' }, sections: [{ id: 'sec_p00001', style: {}, children: [] }] },
        { id: 'scr_back01', name: 'Back office', timers: [{ id: 't', everySeconds: 30, actionId: 'act_bbbb01' }], sections: [{ id: 'sec_b00001', style: {}, children: [] }] },
    ];
    const { def } = canon(app({ screens, extra: {
        publicAccess: { entryScreenId: 'scr_pub001', screenIds: ['scr_pub001'] },
        watchers: [{ id: 'pub', expr: 'vars.a', actionId: 'act_aaaa01' }, { id: 'back', expr: 'vars.b', actionId: 'act_cccc01' }],
    } }));
    const surface = resolvePublicSurface(def);
    assert.deepEqual([...surface.actionIds].sort(), ['act_aaaa01']);
    const page = buildPublicDefinition(def, surface);
    assert.deepEqual(Object.keys(page.actions), ['act_aaaa01']);
    assert.deepEqual(page.watchers, [{ id: 'pub', expr: 'vars.a', actionId: 'act_aaaa01' }]);
});

test('the run gate: a screen trigger is as reachable as its screen, a list slot as its node, a watcher for everyone', () => {
    const screens = [
        { id: 'scr_admin1', name: 'Admin', visibleToRoles: ['admin'], events: { onOpen: 'act_aaaa01' }, sections: [{ id: 'sec_a00001', style: {}, children: [
            { id: 'cmp_btn001', type: 'button', props: { label: 'x' }, onClick: ['act_cccc01', 'act_bbbb01'] },
        ] }] },
    ];
    const def = { screens, actions: { act_aaaa01: toast('a'), act_bbbb01: toast('b'), act_cccc01: toast('c') }, watchers: [] };
    assert.deepEqual(actionRoleAccess(def, 'act_aaaa01', 'member'), { referenced: true, allowed: false });
    assert.deepEqual(actionRoleAccess(def, 'act_aaaa01', 'admin'), { referenced: true, allowed: true });
    assert.deepEqual(actionRoleAccess(def, 'act_bbbb01', 'member'), { referenced: true, allowed: false });
    def.watchers = [{ id: 'w', expr: 'vars.a', actionId: 'act_bbbb01' }];
    assert.deepEqual(actionRoleAccess(def, 'act_bbbb01', 'member'), { referenced: true, allowed: true });
});

test('the AI builder: app_bind_action takes a list, app_update_screen writes events and timers', async () => {
    const wrap = { userId: 'u1', def: canon(app({ nodes: [button('act_aaaa01')] })).def, dataModel: { tables: [] }, datasetIds: [] };
    const bound = await applyBindActionTool(wrap, { nodeId: 'cmp_btn001', event: 'onClick', actionId: ['act_aaaa01', 'act_bbbb01'] });
    assert.ok(!bound.error, JSON.stringify(bound));
    assert.deepEqual(node0(wrap.def).onClick, ['act_aaaa01', 'act_bbbb01']);
    const refused = await applyBindActionTool(wrap, { nodeId: 'cmp_btn001', event: 'onClick', actionId: ['act_aaaa01', 'act_nope01'] });
    assert.match(refused.error, /Unknown actionId/);

    const screen = applyUpdateScreen(wrap, { screenId: 'scr_home01', events: { onOpen: 'act_cccc01' }, timers: [{ id: 'tick', everySeconds: 15, actionId: 'act_bbbb01' }] });
    assert.ok(!screen.error, JSON.stringify(screen));
    assert.deepEqual(wrap.def.screens[0].events, { onOpen: 'act_cccc01' });
    assert.deepEqual(wrap.def.screens[0].timers, [{ id: 'tick', everySeconds: 15, actionId: 'act_bbbb01' }]);
    applyUpdateScreen(wrap, { screenId: 'scr_home01', events: null, timers: null });
    assert.equal('events' in wrap.def.screens[0], false);
});

test('app_inspect_catalog explains the screen keys, the watchers key and the new events', () => {
    const r = applyInspectCatalog({ extensions: ['screen.events', 'screen.timers', 'watchers', 'card.onClick', 'input_datetime.onChange'] });
    assert.ok(!r.unknown, JSON.stringify(r.unknown));
    const text = JSON.stringify(r);
    for (const bit of ['app_update_screen', 'everySeconds', 'debounceMs', 'card also fires onClick', 'input_datetime also fires onChange']) assert.ok(text.includes(bit), bit);
});
