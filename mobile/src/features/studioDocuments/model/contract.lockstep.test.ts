/**
 * The contract port held to the server's own module
 * (server/core/documents/documentContract.js) — a differential test: that
 * file is plain CommonJS whose evaluate and normalise paths need nothing but
 * documentTemplate.js, so it runs here beside the port on the same fixtures.
 *
 * When this fails, the server changed: update model/contract.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { contractProblem, evaluateCondition, nestValues, safePath } from './contract';
import type { Condition } from './types';

const SERVER = path.resolve(__dirname, '../../../../../server/core/documents/documentContract.js');
const describeIfServer = fs.existsSync(SERVER) ? describe : describe.skip;

interface ServerContract {
    safePath: (p: unknown) => boolean;
    setPath: (target: object, key: string, value: unknown) => void;
    evaluateCondition: (rule: unknown, values: object) => { state: string; reason: string };
    normalizeContract: (raw: unknown) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server: ServerContract | null = fs.existsSync(SERVER) ? require(SERVER) : null;

const FLAT = {
    'customer.name': 'Acme',
    'customer.tier': 'gold',
    remoteAccess: true,
    cloudServices: false,
    seats: 12,
    note: '',
    tags: ['vip', 'eu'],
    missing: null,
};

const RULES: (Condition | null)[] = [
    null,
    { parameter: 'remoteAccess', operator: 'equals', value: true },
    { parameter: 'cloudServices', operator: 'equals', value: true },
    { parameter: 'customer.tier', operator: 'not_equals', value: 'silver' },
    { parameter: 'customer.name', operator: 'contains', value: 'cm' },
    { parameter: 'tags', operator: 'contains', value: 'eu' },
    { parameter: 'seats', operator: 'greater_than', value: 10 },
    { parameter: 'seats', operator: 'less_than', value: 10 },
    { parameter: 'customer.name', operator: 'greater_than', value: 1 },
    { parameter: 'note', operator: 'is_set' },
    { parameter: 'customer.name', operator: 'is_set' },
    { parameter: 'nowhere', operator: 'equals', value: 1 },
    { parameter: 'missing', operator: 'equals', value: 1 },
    { all: [{ parameter: 'remoteAccess', operator: 'equals', value: true }, { parameter: 'seats', operator: 'greater_than', value: 5 }] },
    { all: [{ parameter: 'remoteAccess', operator: 'equals', value: true }, { parameter: 'nowhere', operator: 'is_set' }] },
    { any: [{ parameter: 'cloudServices', operator: 'equals', value: true }, { parameter: 'nowhere', operator: 'is_set' }] },
    { any: [{ parameter: 'cloudServices', operator: 'equals', value: true }, { all: [{ parameter: 'seats', operator: 'less_than', value: 20 }] }] },
];

const p = (key: unknown, type: unknown, extra: object = {}) => ({ key, type, ...extra });
const CONTRACTS: unknown[] = [
    null,
    [],
    {},
    { parameters: 'x' },
    { parameters: [p('customer.name', 'text'), p('lines', 'list', { fields: [p('amount', 'number')] })] },
    { parameters: [p('a', 'text'), p('a', 'number')] },
    { parameters: [p('bad key', 'text')] },
    { parameters: [p('__proto__', 'text')] },
    { parameters: [p('a', 'money')] },
    { parameters: [p('c', 'choice')] },
    { parameters: [p('c', 'choice', { options: ['a', 2] })] },
    { parameters: [p('c', 'choice', { options: ['a', 'b'] })] },
    { parameters: [p('l', 'list', { fields: [p('x', 'list')] })] },
    { parameters: [p('l', 'list', { fields: [p('x', 'text'), p('x', 'number')] })] },
    { parameters: [p('l', 'list', { fields: 'no' })] },
    { parameters: [p('l', 'list', { fields: [p('', 'text')] })] },
    { sections: [{ id: 'a' }, { id: 'a' }] },
    { sections: [{ id: 'with space' }] },
    { sections: [{ id: 'ok', condition: { parameter: 'x', operator: 'nope' } }] },
    { sections: [{ id: 'ok', condition: { all: [] } }] },
    { sections: [{ id: 'ok', condition: { all: [1] } }] },
    { sections: [{ id: 'ok', condition: { all: [{ parameter: 'x', operator: 'equals' }], any: [] } }] },
    { sections: [{ id: 'ok', condition: { any: [{ all: [{ parameter: 'x', operator: 'is_set' }] }] } }] },
    { sections: [{ id: 'deep', condition: [0, 1, 2, 3, 4, 5, 6, 7].reduce<unknown>((acc) => ({ all: [acc] }), { parameter: 'x', operator: 'is_set' }) }] },
];

function serverProblem(raw: unknown): string | null {
    try {
        server?.normalizeContract(raw);
        return null;
    } catch (error) {
        return (error as Error).message;
    }
}

describeIfServer('the contract port matches documentContract.js', () => {
    it('agrees on which paths are safe', () => {
        for (const path of ['a', 'a.b', 'a-b_c.d', '_x', '.a', 'a..b', 'a b', '__proto__', 'x.constructor', 7, null]) {
            expect([path, safePath(path)]).toEqual([path, server?.safePath(path)]);
        }
    });

    it('nests stored values the way setPath does', () => {
        const expected = Object.create(null) as object;
        for (const [key, value] of Object.entries(FLAT)) server?.setPath(expected, key, value);
        expect(JSON.parse(JSON.stringify(nestValues(FLAT)))).toEqual(JSON.parse(JSON.stringify(expected)));
    });

    it('evaluates every rule to the same state and reason', () => {
        const values = nestValues(FLAT);
        for (const rule of RULES) {
            expect([rule, evaluateCondition(rule, values)]).toEqual([rule, server?.evaluateCondition(rule, values)]);
        }
    });

    it('refuses the same contracts with the same words', () => {
        for (const raw of CONTRACTS) {
            expect([raw, contractProblem(raw)]).toEqual([raw, serverProblem(raw)]);
        }
    });
});
