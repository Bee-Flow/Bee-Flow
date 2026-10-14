/**
 * Lockstep proof for the App Studio definition model: one sample definition and
 * one scenario of op calls, run against the server facade
 * (server/appStudio/definitionOps.js) and the agent-hub one
 * (agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js).
 *
 * lockstep.golden.json holds what both copies returned BEFORE the shared logic
 * moved to server/shared/appDefinition/ (recorded from the two hand-kept copies),
 * so the move is proven result-identical: every op, the same-reference return on
 * a no-op, which screens keep their identity, and the generated ids (Math.random
 * is replaced by a seeded generator for the length of each case).
 *
 * Test-only: excluded from the agent-hub mirror (scripts/shared-mirror.manifest.json).
 * Read by definitionOps.lockstep.test.mjs (server) and
 * agent-hub/.../state/definitionOps.lockstep.test.ts (editor). Change the golden
 * only for a DELIBERATE behaviour change, and say so in the commit.
 */

import { createHash } from 'node:crypto';

/** A small app that touches every reference kind the ops rewrite or strip. */
export const SAMPLE_DEFINITION = Object.freeze({
    schemaVersion: 2,
    meta: { name: 'Orders', description: 'Sample' },
    theme: { primary: '#0ea5e9', appearance: 'light' },
    design: { preset: 'classic', corners: 'soft' },
    nav: { style: 'sidebar' },
    homeScreenId: 'scr_home01',
    screens: [
        {
            id: 'scr_home01',
            name: 'Home',
            icon: null,
            showInNav: true,
            maxWidth: 'medium',
            sections: [
                {
                    id: 'sec_top001',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        { id: 'cmp_title1', type: 'heading', props: { text: 'Orders' }, style: { align: 'left' } },
                        {
                            id: 'cmp_table1',
                            type: 'table',
                            props: {
                                rowActions: [{ label: 'Open', actionId: 'act_open01' }, { label: 'Del', actionId: 'act_del001' }],
                                addRowActionId: 'act_del001',
                                columns: [{ field: 'name', actionId: 'act_del001' }, { field: 'total' }],
                                result: { kind: 'actionResult', actionId: 'act_save01' },
                            },
                            onRowClick: 'act_open01',
                        },
                        {
                            id: 'cmp_box001',
                            type: 'container',
                            props: {},
                            children: [
                                { id: 'cmp_btn001', type: 'button', props: { label: 'Save' }, onClick: 'act_save01' },
                                { id: 'cmp_btn002', type: 'button', props: { label: 'Go' }, onClick: 'act_nav001', onSubmit: 'act_del001' },
                                { id: 'cmp_inner1', type: 'container', props: {}, children: [] },
                            ],
                        },
                    ],
                },
                {
                    id: 'sec_bot001',
                    style: { padding: 2 },
                    children: [
                        {
                            id: 'cmp_modal1',
                            type: 'modal',
                            props: { title: 'Edit' },
                            children: [{ id: 'cmp_mtext1', type: 'text', props: { text: 'Hi' } }],
                        },
                        { id: 'cmp_btn003', type: 'button', props: { label: 'Edit' }, onClick: 'act_omod01' },
                    ],
                },
            ],
        },
        {
            id: 'scr_detl01',
            name: 'Detail',
            icon: 'file',
            showInNav: false,
            maxWidth: 'wide',
            visibleToRoles: ['manager'],
            sections: [
                { id: 'sec_det001', style: { padding: 4, gap: 3, background: 'none' }, children: [{ id: 'cmp_dtext1', type: 'text', props: { text: 'Detail' } }] },
            ],
        },
    ],
    actions: {
        act_save01: { kind: 'save_record', table: 'orders', onSuccess: { navigateTo: 'scr_detl01', toast: 'ok' } },
        act_open01: { kind: 'navigate', screenId: 'scr_detl01' },
        act_nav001: { kind: 'navigate', screenId: 'scr_home01' },
        act_del001: { kind: 'delete_record', table: 'orders' },
        act_omod01: { kind: 'open_modal', modalId: 'cmp_modal1' },
        act_seq001: {
            kind: 'sequence',
            steps: [
                { kind: 'navigate', screenId: 'scr_detl01' },
                { kind: 'condition', when: 'true', then: [{ kind: 'close_modal', modalId: 'cmp_modal1' }], else: [] },
                { kind: 'switch', cases: [{ when: '1', steps: [{ kind: 'navigate', screenId: 'scr_detl01' }] }], default: [{ kind: 'open_modal', modalId: 'cmp_modal1' }] },
            ],
        },
    },
    roles: [{ id: 'manager', name: 'Manager' }],
    variables: [{ name: 'status', type: 'text', default: 'new' }],
});

/**
 * The scenario: [case name, op name, call]. A case runs only when the facade
 * exports that op (the two sides do not export the same set).
 */
export const CASES = [
    ['findNode.top', 'findNode', (o, d) => o.findNode(d, 'cmp_title1')],
    ['findNode.nested', 'findNode', (o, d) => o.findNode(d, 'cmp_inner1')],
    ['findNode.missing', 'findNode', (o, d) => o.findNode(d, 'cmp_nope00')],
    ['findNode.nullDef', 'findNode', (o) => o.findNode(null, 'cmp_title1')],
    ['findScreen.hit', 'findScreen', (o, d) => o.findScreen(d, 'scr_detl01')],
    ['findScreen.miss', 'findScreen', (o, d) => o.findScreen(d, 'scr_none00')],
    ['findSection.hit', 'findSection', (o, d) => o.findSection(d, 'sec_bot001')],
    ['findSection.miss', 'findSection', (o, d) => o.findSection(d, 'sec_none00')],
    ['findAction.hit', 'findAction', (o, d) => o.findAction(d, 'act_save01')],
    ['findAction.null', 'findAction', (o, d) => o.findAction(d, null)],
    ['collectIds', 'collectIds', (o, d) => o.collectIds(d)],
    ['uniqueId', 'uniqueId', (o, d) => { const taken = o.collectIds(d); return [o.uniqueId('component', taken), o.uniqueId('screen', taken), taken.size]; }],

    ['updateNodeProps.change', 'updateNodeProps', (o, d) => o.updateNodeProps(d, 'cmp_btn001', { label: 'Store', size: 'lg' })],
    ['updateNodeProps.noop', 'updateNodeProps', (o, d) => o.updateNodeProps(d, 'cmp_btn001', { label: 'Save' })],
    ['updateNodeProps.missing', 'updateNodeProps', (o, d) => o.updateNodeProps(d, 'cmp_nope00', { label: 'x' })],
    ['updateNodeProps.badPatch', 'updateNodeProps', (o, d) => o.updateNodeProps(d, 'cmp_btn001', null)],
    ['updateNodeStyle.new', 'updateNodeStyle', (o, d) => o.updateNodeStyle(d, 'cmp_mtext1', { color: 'red' })],
    ['updateNodeStyle.noop', 'updateNodeStyle', (o, d) => o.updateNodeStyle(d, 'cmp_title1', { align: 'left' })],
    ['setNodeVisible.change', 'setNodeVisible', (o, d) => o.setNodeVisible(d, 'cmp_title1', false)],
    ['setNodeVisible.nonBool', 'setNodeVisible', (o, d) => o.setNodeVisible(d, 'cmp_title1', 'no')],
    ['setNodeEvent.onClick', 'setNodeEvent', (o, d) => o.setNodeEvent(d, 'cmp_title1', 'onClick', 'act_save01')],
    ['setNodeEvent.clear', 'setNodeEvent', (o, d) => o.setNodeEvent(d, 'cmp_btn001', 'onClick', null)],
    ['setNodeEvent.noop', 'setNodeEvent', (o, d) => o.setNodeEvent(d, 'cmp_btn001', 'onClick', 'act_save01')],
    ['setNodeEvent.onRowClick', 'setNodeEvent', (o, d) => o.setNodeEvent(d, 'cmp_table1', 'onRowClick', 'act_save01')],
    ['setNodeEvent.unknown', 'setNodeEvent', (o, d) => o.setNodeEvent(d, 'cmp_title1', 'onHover', 'act_save01')],

    ['insertNode.section', 'insertNode', (o, d) => o.insertNode(d, { parentId: 'sec_top001', index: 1, node: { id: 'cmp_new001', type: 'text', props: {} } })],
    ['insertNode.sectionAppend', 'insertNode', (o, d) => o.insertNode(d, { parentId: 'sec_det001', node: { id: 'cmp_new001', type: 'text' } })],
    ['insertNode.container', 'insertNode', (o, d) => o.insertNode(d, { parentId: 'cmp_box001', index: 0, node: { type: 'text', props: {} } })],
    ['insertNode.takenId', 'insertNode', (o, d) => o.insertNode(d, { parentId: 'cmp_inner1', node: { id: 'cmp_title1', type: 'text' } })],
    ['insertNode.nonContainer', 'insertNode', (o, d) => o.insertNode(d, { parentId: 'cmp_title1', node: { id: 'cmp_new001', type: 'text' } })],
    ['insertNode.wrongScreen', 'insertNode', (o, d) => o.insertNode(d, { screenId: 'scr_detl01', parentId: 'cmp_box001', node: { id: 'cmp_new001', type: 'text' } })],
    ['insertNode.screenScoped', 'insertNode', (o, d) => o.insertNode(d, { screenId: 'scr_detl01', parentId: 'sec_det001', index: -4, node: { id: 'cmp_new001', type: 'text' } })],
    ['insertNode.noNode', 'insertNode', (o, d) => o.insertNode(d, { parentId: 'sec_top001' })],

    ['moveNode.reorder', 'moveNode', (o, d) => o.moveNode(d, 'cmp_title1', { index: 2 })],
    ['moveNode.samePlace', 'moveNode', (o, d) => o.moveNode(d, 'cmp_title1', { index: 0 })],
    ['moveNode.crossSection', 'moveNode', (o, d) => o.moveNode(d, 'cmp_btn001', { toParentId: 'sec_det001', index: 0 })],
    ['moveNode.intoSelf', 'moveNode', (o, d) => o.moveNode(d, 'cmp_box001', { toParentId: 'cmp_inner1' })],
    ['moveNode.modal', 'moveNode', (o, d) => o.moveNode(d, 'cmp_modal1', { toParentId: 'sec_det001' })],
    ['moveNode.badTarget', 'moveNode', (o, d) => o.moveNode(d, 'cmp_btn001', { toParentId: 'cmp_title1' })],
    ['moveNode.missing', 'moveNode', (o, d) => o.moveNode(d, 'cmp_nope00', { toParentId: 'sec_det001' })],

    ['removeNode.leaf', 'removeNode', (o, d) => o.removeNode(d, 'cmp_btn002')],
    ['removeNode.modal', 'removeNode', (o, d) => o.removeNode(d, 'cmp_modal1')],
    ['removeNode.missing', 'removeNode', (o, d) => o.removeNode(d, 'cmp_nope00')],

    ['updateTheme.change', 'updateTheme', (o, d) => o.updateTheme(d, { primary: '#16a34a' })],
    ['updateTheme.noop', 'updateTheme', (o, d) => o.updateTheme(d, { appearance: 'light' })],
    ['updateMeta.change', 'updateMeta', (o, d) => o.updateMeta(d, { name: 'Sales' })],
    ['updateMeta.bad', 'updateMeta', (o, d) => o.updateMeta(d, 'x')],
    ['updateDesign.change', 'updateDesign', (o, d) => o.updateDesign(d, { corners: 'sharp' })],
    ['updateDesign.remove', 'updateDesign', (o, d) => o.updateDesign(d, null)],
    ['updateDesign.removeAbsent', 'updateDesign', (o, d) => o.updateDesign(o.updateDesign(d, null), null)],
    ['updateNav.change', 'updateNav', (o, d) => o.updateNav(d, { style: 'top' })],
    ['updateNav.remove', 'updateNav', (o, d) => o.updateNav(d, null)],
    ['updateAiBrowsing.set', 'updateAiBrowsing', (o, d) => o.updateAiBrowsing(d, { enabled: true })],

    ['addScreen.named', 'addScreen', (o, d) => o.addScreen(d, { name: '  Reports ' })],
    ['addScreen.unnamed', 'addScreen', (o, d) => o.addScreen(d)],
    ['removeScreen.detail', 'removeScreen', (o, d) => o.removeScreen(d, 'scr_detl01')],
    ['removeScreen.home', 'removeScreen', (o, d) => o.removeScreen(d, 'scr_home01')],
    ['removeScreen.missing', 'removeScreen', (o, d) => o.removeScreen(d, 'scr_none00')],
    ['removeScreen.last', 'removeScreen', (o, d) => o.removeScreen(o.removeScreen(d, 'scr_detl01'), 'scr_home01')],
    ['updateScreen.change', 'updateScreen', (o, d) => o.updateScreen(d, 'scr_home01', { name: 'Start', id: 'scr_x00000', sections: [] })],
    ['updateScreen.noop', 'updateScreen', (o, d) => o.updateScreen(d, 'scr_home01', { name: 'Home' })],
    ['updateScreen.missing', 'updateScreen', (o, d) => o.updateScreen(d, 'scr_none00', { name: 'x' })],
    ['addSection.mid', 'addSection', (o, d) => o.addSection(d, 'scr_home01', 1)],
    ['addSection.missing', 'addSection', (o, d) => o.addSection(d, 'scr_none00', 0)],
    ['updateSectionStyle.change', 'updateSectionStyle', (o, d) => o.updateSectionStyle(d, 'sec_bot001', { gap: 5 })],
    ['updateSectionStyle.noop', 'updateSectionStyle', (o, d) => o.updateSectionStyle(d, 'sec_bot001', { padding: 2 })],

    ['setAction.new', 'setAction', (o, d) => o.setAction(d, null, { kind: 'refresh' })],
    ['setAction.replace', 'setAction', (o, d) => o.setAction(d, 'act_save01', { kind: 'refresh' })],
    ['setAction.bad', 'setAction', (o, d) => o.setAction(d, null, null)],
    ['removeAction.del', 'removeAction', (o, d) => o.removeAction(d, 'act_del001')],
    ['removeAction.open', 'removeAction', (o, d) => o.removeAction(d, 'act_open01')],
    ['removeAction.missing', 'removeAction', (o, d) => o.removeAction(d, 'act_none00')],

    ['setVariables.set', 'setVariables', (o, d) => o.setVariables(d, [{ name: 'x', type: 'number', default: 1 }])],
    ['setVariables.clear', 'setVariables', (o, d) => o.setVariables(d, [])],
    ['setPublicAccess.open', 'setPublicAccess', (o, d) => o.setPublicAccess(d, { screens: ['scr_home01'] })],
    ['setPublicAccess.close', 'setPublicAccess', (o, d) => o.setPublicAccess(d, null)],
];

/** The ops both copies implemented identically before the move: their results must agree. */
export const SHARED_OPS = [
    'findNode', 'findScreen', 'findSection', 'findAction', 'collectIds', 'uniqueId',
    'updateNodeProps', 'updateNodeStyle', 'insertNode', 'moveNode',
    'updateTheme', 'updateMeta', 'updateDesign', 'updateNav',
    'addScreen', 'updateScreen', 'addSection', 'setAction',
];

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
}

/** A definition result in a comparable form: same reference?, kept screens, content hash. */
function describeDef(out, input) {
    return {
        same: out === input,
        keptScreens: (out?.screens || []).map((s) => (input?.screens || []).includes(s)),
        hash: hash(out),
    };
}

function describe(result, input) {
    if (result instanceof Set) return { set: [...result] };
    if (result && typeof result === 'object' && Array.isArray(result.screens)) return describeDef(result, input);
    if (result && typeof result === 'object' && 'def' in result && Object.keys(result).length === 2) {
        const [extraKey] = Object.keys(result).filter((k) => k !== 'def');
        return { ...describeDef(result.def, input), [extraKey]: result[extraKey] };
    }
    if (result && typeof result === 'object' && 'node' in result && 'parent' in result) {
        return { node: result.node.id, parent: result.parent.id, screen: result.screen.id, section: result.section.id, index: result.index };
    }
    if (result && typeof result === 'object' && 'section' in result && 'screen' in result) {
        return { section: result.section.id, screen: result.screen.id, index: result.index };
    }
    return { value: result === undefined ? '__undefined__' : result };
}

/** Run every applicable case against `ops`; returns { [case]: description }. */
export function runScenario(ops) {
    const out = {};
    const realRandom = Math.random;
    try {
        CASES.forEach(([name, op, call], i) => {
            if (typeof ops[op] !== 'function') return;
            Math.random = mulberry32(1000 + i);
            const input = deepFreeze(structuredClone(SAMPLE_DEFINITION));
            out[name] = describe(call(ops, input), input);
        });
    } finally {
        Math.random = realRandom;
    }
    return out;
}
