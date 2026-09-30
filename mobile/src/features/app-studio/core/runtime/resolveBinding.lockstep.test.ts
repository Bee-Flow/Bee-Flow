/**
 * Differential lockstep: core/runtime/resolveBinding (+ paths, dataKeys)
 * against the web's runtime/resolveBinding.js, on a matrix of bindings, bags
 * and scopes. Both evaluate formulas with the same shared engine.
 */

import * as port from './resolveBinding';
import { loadWeb } from '../testing/loadWeb';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, unknown>>('runtime/resolveBinding.js');

function both(name: string, ...args: unknown[]): unknown {
    const w = (web[name] as AnyFn)(...args);
    const p = ((port as unknown as Record<string, AnyFn>)[name] as AnyFn)(...args);
    expect({ name, args, out: p }).toEqual({ name, args, out: w });
    // Identity (the memo-friendly fast path) must agree too.
    expect(p === args[0]).toBe(w === args[0]);
    return p;
}

const scope = { vars: { q: 'abc', n: 0, none: null, dim: 'status' }, currentUser: { id: 'u1' } };
const f = (expr: string) => ({ kind: 'formula', expr });

const BINDINGS: unknown[] = [
    null, undefined, 7, 'text', true, {}, [], { kind: 'nope' },
    { kind: 'static', value: [1, 2] },
    { kind: 'actionResult', actionId: 'a1', path: 'rows[0].title' },
    { kind: 'actionResult', actionId: 'a2' },
    { kind: 'actionResult', actionId: 'a3' },
    { kind: 'actionResult', actionId: 'missing' },
    f('vars.q'), f('  '), f('(('), { kind: 'formula', value: 'currentUser.id' }, { kind: 'formula', expr: 3 },
    { kind: 'records', tableId: 't1' },
    { kind: 'records', tableId: 't1', filter: [{ field: 'owner', op: 'eq', value: f('currentUser.id') }] },
    { kind: 'records', tableId: 't1', filter: [{ field: 'x', op: 'eq', value: f('vars.none') }] },
    { kind: 'records', tableId: 't1', filter: [{ field: 'x', op: 'eq', value: f('vars.none'), required: true }] },
    { kind: 'records', tableId: 't1', filter: [{ field: 'x', op: 'eq', value: 'lit', required: true }, null, [1], { field: 'y', op: 'isNull' }] },
    { kind: 'records', tableId: 't1', filter: [{ field: 'x', op: 'eq', value: 'same' }], sort: [{ field: 'x' }], limit: 5 },
    { kind: 'record', tableId: 't1', path: 'title' },
    { kind: 'record', tableId: 't1', pick: { column: 'title' } },
    { kind: 'records', tableId: 't1', pick: { row: 'last', column: 'title' } },
    { kind: 'records', tableId: 't1', pick: { row: 'first' } },
    { kind: 'records', tableId: 't1', pick: [] },
    { kind: 'records', tableId: 't2', pick: { column: 'x' } },
    { kind: 'aggregate', tableId: 't1', groupBy: f('vars.dim'), aggregates: f('vars.none'), limit: 3 },
    { kind: 'aggregate', tableId: 't1', groupBy: ['status'] },
    { kind: 'dataset', datasetId: 'd1', pick: { column: 'v' } },
    { kind: 'dataset' },
    { kind: 'connector', connectorId: 'c1', params: { q: f('vars.q'), gone: f('vars.missing'), n: f('vars.n'), lit: 'x' } },
    { kind: 'connector', connectorId: 'c1', params: { lit: 'x' } },
    { kind: 'connector', connectorId: 'c1', params: [1] },
    { kind: 'connector' },
];

const actionState = {
    a1: { status: 'success', result: { rows: [{ title: 'First' }] } },
    a2: { status: 'running' },
    a3: { status: 'error', error: 'boom' },
};

/** A dataState holding every key the bindings above resolve to (so both sides read real entries). */
function dataStateFor(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    let n = 0;
    for (const b of BINDINGS) {
        const resolved = port.resolveBindingFilters(port.resolveBindingShape(port.resolveBindingParams(b, scope), scope), scope);
        const key = port.dataCacheKey(resolved);
        if (!key || key.includes('t2')) continue;
        n += 1;
        const statuses = ['success', 'loading', 'error', 'running'];
        data[key] = {
            status: statuses[n % 4],
            result: [{ title: 'A', v: 1 }, { title: 'B', v: 2 }],
            error: n % 4 === 2 ? 'bad' : undefined,
            errorCode: n % 4 === 2 ? 'connection_required' : undefined,
        };
    }
    return data;
}

describe('resolveBinding agrees with the web', () => {
    const dataState = dataStateFor();
    const bags = [undefined, null, 'x', actionState, { actionState, dataState, scope }, { scope }, { dataState: null, actionState: null }];

    it.each(BINDINGS.map((b, i) => [i, b]))('binding %i', (_i, binding) => {
        for (const bag of bags) both('resolveBinding', binding, bag);
        both('dataCacheKey', binding);
        for (const s of [scope, undefined]) {
            both('resolveBindingFilters', binding, s);
            both('resolveBindingShape', binding, s);
            both('resolveBindingParams', binding, s);
        }
    });

    it('walks paths the same way', () => {
        const value = { rows: [{ title: 'T', 'a-b': 1 }], stats: { open: 3 }, n: null };
        const paths = ['', null, undefined, 3, 'rows.0.title', 'rows[0].title', 'rows[0]["a-b"]', "rows[0]['a-b']", 'rows[', 'rows[0', 'stats.open', 'n.x', 'rows[].title', 'rows..0', 'toString'];
        for (const path of paths) both('walkPath', value, path);
    });

    it('exports every name the web module exports', () => {
        expect(Object.keys(web).filter((k) => k !== 'default' && !(k in port))).toEqual([]);
    });
});
