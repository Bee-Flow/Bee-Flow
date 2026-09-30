/**
 * Differential lockstep: core/ops against the web's state/definitionOps.js.
 *
 * Both run on the same frozen fixtures (the web's sample definitions plus
 * WIRED and BROKEN) with the same seeded Math.random, and must return deeply
 * equal results AND agree on "same reference back" (the dirtiness contract).
 * Every function the web module exports is exercised; the first test fails
 * when the web gains an export the port does not have.
 */

import { allFixtures, withSeed } from '../testing/fixtures';
import { loadWeb } from '../testing/loadWeb';
import type { AppDefinition } from '../types';
import * as port from './index';
import { collectIds } from './tree';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, unknown>>('state/definitionOps.js');
const fixtures = allFixtures();

/** Functions this file exercises; checked against the web's export list below. */
const COVERED = new Set<string>();

function both(name: string, ...args: unknown[]): void {
    bothWith(name, () => args);
}

/** `makeArgs` builds each side its own arguments (for ops that mutate one, like a taken-id set). */
function bothWith(name: string, makeArgs: () => unknown[]): void {
    COVERED.add(name);
    const args = makeArgs();
    const w = withSeed(7, () => (web[name] as AnyFn)(...args));
    const p = withSeed(7, () => ((port as unknown as Record<string, AnyFn>)[name] as AnyFn)(...makeArgs()));
    expect(p).toEqual(w);
    // The same-reference contract: a no-op hands back the input on both sides.
    const first = args[0];
    expect({ name, sameRef: p === first }).toEqual({ name, sameRef: w === first });
    if (w && typeof w === 'object' && 'def' in w) {
        const wd = (w as { def: unknown }).def;
        const pd = (p as { def: unknown }).def;
        expect({ name, sameDef: pd === first }).toEqual({ name, sameDef: wd === first });
    }
}

function nodeIds(def: AppDefinition): string[] {
    const out: string[] = [];
    port.walkNodes(def, ({ node }) => out.push(node.id));
    return out;
}

const screenIds = (def: AppDefinition) => (def.screens || []).map((s) => s.id);
const sectionIds = (def: AppDefinition) => (def.screens || []).flatMap((s) => (s.sections || []).map((x) => x.id));
const actionIds = (def: AppDefinition) => Object.keys(def.actions || {});
const MISSING = 'cmp_nope00';

describe.each(Object.entries(fixtures))('definition ops on %s', (_name, def) => {
    it('lookups', () => {
        both('collectIds', def);
        for (const id of [...collectIds(def), MISSING, undefined]) {
            both('findScreen', def, id);
            both('findSection', def, id);
            both('findAction', def, id);
            both('getVisibleToRoles', def, id);
            COVERED.add('findNode');
            const w = web.findNode && (web.findNode as AnyFn)(def, id);
            const p = port.findNode(def, id);
            if (!w) expect(p).toBeNull();
            else expect(p && { node: p.node, parent: p.parent, screen: p.screen, section: p.section, index: p.index }).toEqual(w);
        }
        both('listDefinitionRoles', def);
        both('listVariables', def);
    });

    it('node ops', () => {
        for (const id of [...nodeIds(def), MISSING]) {
            both('updateNodeProps', def, id, { label: 'Changed' });
            both('updateNodeProps', def, id, {});
            both('updateNodeStyle', def, id, { span: 4 });
            both('updateNodeStyle', def, id, null);
            for (const ev of [...port.NODE_EVENTS, 'onHover']) {
                both('setNodeEvent', def, id, ev, 'act_x00001');
                both('setNodeEvent', def, id, ev, null);
            }
            both('updateNodeLogic', def, id, { visibleWhen: 'vars.count > 1', readOnly: '', validations: [], bogus: 1 });
            both('updateNodeLogic', def, id, { visibleToRoles: null, computed: {} });
            both('setNodeComputed', def, id, { label: 'vars.count' });
            both('setNodeComputed', def, id, null);
            both('removeNode', def, id);
            both('duplicateNode', def, id);
            both('setVisibleToRoles', def, id, ['manager', 'manager', '', 3]);
            both('setVisibleToRoles', def, id, []);
            both('subtreeIds', port.findNode(def, id)?.node ?? { id: 'cmp_solo01' });
            bothWith('reIdSubtree', () => [port.findNode(def, id)?.node ?? { id: 'cmp_solo01', children: [] }, new Set()]);
        }
    });

    it('insert and move', () => {
        const node = { id: 'cmp_new001', type: 'text', props: { text: 'New' }, style: {} };
        const parents = [...sectionIds(def), ...nodeIds(def), MISSING];
        for (const parentId of parents) {
            for (const index of [undefined, 0, 1, 99, -3, 1.5]) {
                both('insertNode', def, { parentId, index, node });
                both('insertNode', def, { parentId, index, node: { type: 'text' } });
            }
            both('insertNode', def, { screenId: screenIds(def)[0], parentId, node });
            both('insertNode', def, { screenId: 'scr_other1', parentId, node });
        }
        both('insertNode', def, {});
        for (const id of nodeIds(def)) {
            for (const toParentId of [undefined, ...parents.slice(0, 6)]) {
                for (const index of [undefined, 0, 1, 5]) both('moveNode', def, id, { toParentId, index });
            }
        }
    });

    it('screen, section and action ops', () => {
        both('addScreen', def, {});
        both('addScreen', def, { name: '  Named  ' });
        for (const id of [...screenIds(def), 'scr_nope01']) {
            both('removeScreen', def, id);
            both('updateScreen', def, id, { name: 'Renamed', id: 'scr_hack01', sections: [] });
            both('updateScreen', def, id, { name: port.findScreen(def, id)?.name });
            for (const index of [undefined, 0, 1, 50]) both('addSection', def, id, index);
        }
        for (const id of [...sectionIds(def), 'sec_nope01']) both('removeSection', def, id);
        for (const id of [...actionIds(def), 'act_nope01']) {
            both('removeAction', def, id);
            both('setAction', def, id, { kind: 'toast', message: 'Hi' });
        }
        both('setAction', def, null, { kind: 'toast', message: 'New' });
        both('setAction', def, null, null);
    });

    it('theme, meta, design, nav, ai browsing, roles, variables', () => {
        for (const op of ['updateTheme', 'updateMeta', 'updateDesign', 'updateNav', 'updateAiBrowsing']) {
            both(op, def, { primary: '#000000' });
            both(op, def, {});
            both(op, def, 'nope');
        }
        for (const op of ['updateDesign', 'updateNav', 'updateAiBrowsing']) both(op, def, null);
        both('setDefinitionRoles', def, [{ key: 'manager', label: 'Manager' }, { key: 'x' }, null, { key: '' }]);
        both('setDefinitionRoles', def, []);
        both('setVariable', def, { name: 'count', type: 'number', default: 2 });
        both('setVariable', def, { name: 'count', default: 3 });
        both('setVariable', def, { name: 'fresh', type: 'text', default: '' });
        both('setVariable', def, { name: '' });
        both('renameVariable', def, 'count', 'total');
        both('renameVariable', def, 'count', 'tags');
        both('renameVariable', def, 'nope', 'x');
        both('removeVariable', def, 'count');
        both('removeVariable', def, 'nope');
        both('ensureIds', def);
    });
});

describe('the pure helpers', () => {
    it('agree on ids, clones and the role gate', () => {
        for (const kind of ['screen', 'section', 'component', 'action', 'weird']) both('newId', kind);
        both('deepClone', { a: [1, { b: null }], c: 'x' });
        for (const gate of [undefined, [], ['a'], ['b']]) {
            for (const role of [null, '', 'owner', 'a']) both('isVisibleToRole', { visibleToRoles: gate }, role);
        }
        both('isVisibleToRole', null, 'a');
    });

    it('ensureIds repairs BROKEN and keeps the rest', () => {
        const res = withSeed(3, () => port.ensureIds(fixtures.BROKEN as AppDefinition));
        expect(res.changed).toBe(true);
        for (const id of collectIds(res.def)) expect(id).toMatch(port.ID_RE);
    });

    it('the constants are the same', () => {
        for (const name of ['ID_PREFIXES', 'NODE_EVENTS']) {
            expect((port as unknown as Record<string, unknown>)[name]).toEqual(web[name]);
        }
        expect(String(port.ID_RE)).toBe(String(web.ID_RE));
    });
});

describe('the export surface', () => {
    it('exports every name the web module exports', () => {
        const missing = Object.keys(web).filter((k) => k !== 'default' && !(k in port));
        expect(missing).toEqual([]);
    });

    it('exercises every web function in this file', () => {
        const fns = Object.keys(web).filter((k) => typeof web[k] === 'function');
        expect(fns.filter((k) => !COVERED.has(k))).toEqual([]);
    });
});
