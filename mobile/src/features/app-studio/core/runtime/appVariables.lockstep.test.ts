/**
 * Differential lockstep: core/runtime/appVariables against the web's
 * runtime/appVariables.js, and the vocabulary against the server's
 * componentSpecs/variables.js (the authority both mirror).
 */

import * as port from './appVariables';
import { loadWeb } from '../testing/loadWeb';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, unknown>>('runtime/appVariables.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../../../../../../server/appStudio/componentSpecs/variables.js') as Record<string, unknown>;

function both(name: string, ...args: unknown[]): unknown {
    const w = (web[name] as AnyFn)(...args);
    const p = ((port as unknown as Record<string, AnyFn>)[name] as AnyFn)(...args);
    expect({ name, args, out: p }).toEqual({ name, args, out: w });
    expect(p === args[0]).toBe(w === args[0]);
    return p;
}

const big = 'x'.repeat(6000);
const VALUES: unknown[] = [
    undefined, null, '', 'hi', big, '12', ' 3.5 ', 'abc', 0, 1, 2.5, NaN, Infinity, true, false, 'true', 'false',
    '2026-09-24', '2026-09-24T10:00:00Z', '24-09-2026', {}, { a: 1 }, [], [1, 'é'], { big: 'é'.repeat(1100) },
    Array.from({ length: 700 }, (_, i) => i),
];
const TYPES = [...port.VARIABLE_TYPES, 'weird'];

describe('appVariables agrees with the web and the server', () => {
    it('coerces every value for every type the same way', () => {
        for (const type of TYPES) {
            for (const value of VALUES) {
                both('coerceVariableDefault', type, value);
                expect(port.coerceVariableDefault(type, value)).toEqual((server.coerceVariableDefault as AnyFn)(type, value));
            }
        }
    });

    it('seeds, lists and reconciles the same way', () => {
        const decls = [
            { name: 'count', type: 'number', default: '4' },
            { name: 'filters', type: 'record' },
            { name: '1bad', type: 'text' },
            { name: 'mystery', type: 'nope', default: [1] },
            { name: 'label', type: 'text' },
            null,
            'x',
        ];
        for (const list of [undefined, null, [], decls]) {
            both('seedVariableDefaults', list);
            both('listVariableNames', list);
            expect(port.seedVariableDefaults(list)).toEqual((server.seedVariableDefaults as AnyFn)(list));
        }
        const next = [{ name: 'count', type: 'number', default: 9 }, { name: 'fresh', type: 'list' }];
        const prevs = [undefined, null, {}, { count: 4, label: '' }, { count: 5, label: 'typed', extra: 1 }];
        for (const prev of prevs) {
            both('reconcileVariableDefaults', prev, decls, next);
            both('reconcileVariableDefaults', prev, decls, decls);
            both('reconcileVariableDefaults', prev, next, decls);
        }
    });

    it('shares the vocabulary', () => {
        for (const name of Object.keys(web)) {
            const p = (port as unknown as Record<string, unknown>)[name];
            if (typeof web[name] === 'function') expect(typeof p).toBe('function');
            else expect({ name, value: String(p) === String(web[name]) ? 'same' : p }).toEqual({ name, value: 'same' });
        }
        expect([...port.VARIABLE_TYPES]).toEqual(server.VARIABLE_TYPES);
        expect(port.VARIABLE_TYPE_DEFAULTS).toEqual(server.VARIABLE_TYPE_DEFAULTS);
        expect(String(port.VARIABLE_NAME_RE)).toBe(String(server.VARIABLE_NAME_RE));
        expect(port.RESERVED_VARIABLE_NAMES).toEqual(server.RESERVED_VARIABLE_NAMES);
        expect(port.VARIABLE_TYPE_DEFAULTS).toEqual(web.VARIABLE_TYPE_DEFAULTS);
    });
});
