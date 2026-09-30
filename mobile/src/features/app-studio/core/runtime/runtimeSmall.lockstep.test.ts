/**
 * Differential lockstep for the small runtime ports: formValues.ts against
 * runtime/formValues.js, navModel.ts against runtime/shell/navModel.js and
 * scope.ts (buildScope) against runtime/RuntimeContext.jsx.
 */

import { mergeFormValues } from './formValues';
import { navModel } from './navModel';
import { buildScope, type ScopeInput } from './scope';
import { allFixtures } from '../testing/fixtures';
import { loadWeb } from '../testing/loadWeb';

type AnyFn = (...args: unknown[]) => unknown;
const webForms = loadWeb<{ mergeFormValues: AnyFn }>('runtime/formValues.js');
const webNav = loadWeb<{ navModel: AnyFn }>('runtime/shell/navModel.js');
const webScope = loadWeb<{ buildScope: AnyFn }>('runtime/RuntimeContext.jsx');

describe('mergeFormValues', () => {
    it('agrees, identity included', () => {
        const prevs = [undefined, null, {}, { f: { a: 1 } }, { f: { a: 1, b: 2 } }, { g: { a: 1 } }];
        const values = [undefined, null, {}, { a: 1 }, { a: 2 }, { a: 1, b: 2 }];
        for (const prev of prevs) {
            for (const name of ['f', '', null]) {
                for (const v of values) {
                    const w = webForms.mergeFormValues(prev, name, v);
                    const p = mergeFormValues(prev as never, name, v as never);
                    expect(p).toEqual(w);
                    expect(p === prev).toBe(w === prev);
                }
            }
        }
    });
});

describe('navModel', () => {
    it.each(Object.entries(allFixtures()))('agrees on %s', (_name, def) => {
        expect(navModel(def)).toEqual(webNav.navModel(def));
    });

    it('agrees on groups that overlap, repeat and point nowhere', () => {
        const screens = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, sections: [], showInNav: id !== 'd' }));
        const nav = { groups: [null, { id: 'g1', label: 'One', screens: ['b', 'zz', 'b', 'd'] }, { id: 'g2', screens: ['b', 'a'], icon: 'Star' }, { id: 'g3', screens: 'x' }] };
        for (const def of [null, {}, { screens }, { screens, nav }, { screens, nav: { groups: 'x' } }]) {
            expect(navModel(def as never)).toEqual(webNav.navModel(def));
        }
    });
});

describe('buildScope', () => {
    const connectorKey = 'connector:c1:null';
    const dataState = {
        'records:t1:{"filter":null,"limit":null,"sort":null}': { status: 'success', result: ['plain'], tableId: 't1' },
        'records:t1:{"filter":[1],"limit":null,"sort":null}': { status: 'success', result: ['filtered'], tableId: 't1' },
        'record:t1:{"filter":null,"limit":null,"sort":null}': { status: 'success', result: 'one', tableId: 't1' },
        'aggregate:t1:x': { status: 'success', result: [{ count: 3 }], tableId: 't1' },
        'record:t2:x': { result: 'lookup', tableId: 't2' },
        'records:t2:x': { result: 'list', tableId: 't2' },
        'dataset:d1': { result: 'ds', datasetId: 'd1' },
        'connector:c1:{"q":"a"}': { result: 'filtered', connectorId: 'c1' },
        [connectorKey]: { result: 'plain', connectorId: 'c1' },
        junk: null,
        other: { result: 'nothing' },
    };

    it('agrees on every root, with the stamps fixed', () => {
        const inputs: ScopeInput[] = [
            {},
            { now: '2026-09-24T10:00:00.000Z' },
            {
                actionState: { a: { status: 'success', result: 1 } }, dataState: dataState as never,
                form: { x: 1 }, forms: { f: {} }, screen: { params: { id: 1 } }, vars: { v: 1 },
                currentUser: { id: 'u' }, item: { id: 'i' }, index: 2, value: 'v', now: '2026-09-24T10:00:00.000Z', today: '2026-01-01',
            },
            { actionState: null, dataState: null, form: null, forms: null, screen: null, vars: null, currentUser: null } as never,
        ];
        for (const input of inputs) {
            const stamped = { now: '2026-09-24T10:00:00.000Z', ...input };
            expect(buildScope(stamped)).toEqual(webScope.buildScope(stamped));
        }
        expect(buildScope().today).toBe(buildScope().now.slice(0, 10));
    });
});
