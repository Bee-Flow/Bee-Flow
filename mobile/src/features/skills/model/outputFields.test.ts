/**
 * "Delivers": read back in the automation's words, and edited without losing
 * what the phone did not touch — a table's columns, an enum, a description.
 */

import {
    addOutputField,
    expectedKindFor,
    outputFieldsOf,
    removeOutputField,
    setOutputFieldKind,
} from './outputFields';

const SCHEMA = {
    type: 'object',
    required: ['total', 'rows'],
    properties: {
        total: { type: 'number', description: 'Grand total', 'x-unit': 'EUR' },
        rows: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } },
        status: { type: 'string', enum: ['open', 'closed'] },
    },
};

describe('expectedKindFor — the web fieldKinds vocabulary', () => {
    it.each([
        [{ type: 'string' }, 'text'],
        [{ type: 'string', format: 'date-time' }, 'date'],
        [{ type: 'string', format: 'DATE', enum: ['x'] }, 'date'],
        [{ type: 'string', enum: ['a'] }, 'choice'],
        [{ enum: ['a'] }, 'choice'],
        [{ type: ['null', 'integer'] }, 'number'],
        [{ type: 'boolean' }, 'yesno'],
        [{ type: 'array', items: { type: 'string' } }, 'list'],
        [{ type: 'array', items: { type: 'object' } }, 'table'],
        [{ type: 'object' }, 'group'],
        [{ type: 'constructor' }, 'unknown'],
        [{}, 'unknown'],
        [null, 'unknown'],
    ])('%j is %s', (spec, kind) => {
        expect(expectedKindFor(spec)).toBe(kind);
    });
});

describe('outputFieldsOf', () => {
    it('reads each field with its kind, unit, description and whether it is required', () => {
        expect(outputFieldsOf(SCHEMA)).toEqual([
            { key: 'total', kind: 'number', unit: 'EUR', description: 'Grand total', required: true },
            { key: 'rows', kind: 'table', unit: '', description: '', required: true },
            { key: 'status', kind: 'choice', unit: '', description: '', required: false },
        ]);
    });

    it('has nothing to say about no schema', () => {
        expect(outputFieldsOf(null)).toEqual([]);
        expect(outputFieldsOf({ type: 'object' })).toEqual([]);
    });
});

describe('editing', () => {
    it('adds a field at the end and refuses a bad or taken key', () => {
        const next = addOutputField(SCHEMA, 'due_on', 'date');
        expect(Object.keys((next as { properties: object }).properties)).toEqual(['total', 'rows', 'status', 'due_on']);
        expect(next).toMatchObject({ properties: { due_on: { type: 'string', format: 'date-time' } } });
        expect(addOutputField(SCHEMA, 'total', 'text')).toBe(SCHEMA);
        expect(addOutputField(SCHEMA, '1 bad', 'text')).toBe(SCHEMA);
        expect(addOutputField(null, 'ok', 'yesno')).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    });

    it('switches one field’s kind, keeping its description and place, and nothing else', () => {
        const next = setOutputFieldKind(SCHEMA, 'total', 'text') as { properties: Record<string, unknown>; required: string[] };
        expect(next.properties.total).toEqual({ type: 'string', description: 'Grand total' });
        expect(next.properties.rows).toBe(SCHEMA.properties.rows);
        expect(next.required).toEqual(['total', 'rows']);
    });

    it('removes a field, drops it from required, and turns the last one into null', () => {
        const next = removeOutputField(SCHEMA, 'total') as { required: string[] };
        expect(next.required).toEqual(['rows']);
        expect(removeOutputField({ type: 'object', properties: { a: { type: 'string' } } }, 'a')).toBeNull();
        const noneRequired = removeOutputField({ type: 'object', required: ['a'], properties: { a: {}, b: {} } }, 'a');
        expect(noneRequired).not.toHaveProperty('required');
    });
});
