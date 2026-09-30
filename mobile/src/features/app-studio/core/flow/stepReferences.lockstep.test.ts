/**
 * Differential lockstep: core/flow/stepReferences against the web's
 * flow/stepReferences.js, with Msg data rendered to English.
 */

import * as port from './stepReferences';
import { english } from '../testing/english';
import { allFixtures } from '../testing/fixtures';
import { loadWeb } from '../testing/loadWeb';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, unknown>>('flow/stepReferences.js');

function both(name: string, ...args: unknown[]): unknown {
    const w = (web[name] as AnyFn)(...args);
    const p = ((port as unknown as Record<string, AnyFn>)[name] as AnyFn)(...args);
    expect(english(p)).toEqual(w);
    return p;
}

const ROWS = [
    null,
    'nope',
    [],
    [
        null,
        { id: 'a', name: 'Alpha', title: 'T', kind: 'k', label: 'L', key: 'ka', placeholders: ['x', 'y'] },
        { id: 'b', placeholders: [] },
        { id: 'c', title: 'Only title', kind: 'gmail' },
        { key: 'kd', label: 'Keyed' },
        { key: 'ke' },
        { id: '' , name: '' },
        { id: 3 },
        { key: 'kf', name: 'Field', type: 'number', required: 1 },
        { id: 'd', name: 'Doc', placeholders: 'abc' },
    ],
];

describe('stepReferences agrees with the web', () => {
    it('option builders', () => {
        for (const name of ['documentOptions', 'screenOptions', 'tableOptions', 'datasetOptions', 'automationOptions', 'connectorOptions', 'columnOptions']) {
            for (const list of ROWS) both(name, list);
        }
    });

    it('collectModals on every fixture', () => {
        for (const def of Object.values(allFixtures())) both('collectModals', def);
        both('collectModals', null);
        both('collectModals', { screens: [{ sections: [{ children: [{ id: 'cmp_m1', type: 'modal', props: { heading: '  Hi ' } }, { id: 'cmp_m2', type: 'modal', props: { title: '   ' } }] }] }] });
    });

    it('labels and dangling checks', () => {
        const options = [{ id: 'a', label: 'Alpha' }];
        for (const opts of [options, [], null]) {
            for (const id of ['a', 'b', '', null, undefined, 0]) {
                both('labelForRef', opts, id);
                both('isDanglingRef', opts, id);
            }
        }
    });

    it('constants', () => {
        for (const name of ['REFERENCE_FIELDS', 'REFERENCE_PLACEHOLDERS', 'REFERENCE_EMPTY_HINTS']) {
            expect(english((port as unknown as Record<string, unknown>)[name])).toEqual(web[name]);
        }
        expect(Object.keys(web).filter((k) => !(k in port))).toEqual([]);
    });
});
