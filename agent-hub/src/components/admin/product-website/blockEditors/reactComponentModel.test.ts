// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { FIELD_TYPES } from '@shared/cmsReact/compile.mjs';
import {
    emptyValueFor, fieldNameProblem, fieldsOf, markersFromDiagnostics, nextFieldName, parseOptions,
    propsForFields, updateField, type ReactField,
} from './reactComponentModel';

describe('markersFromDiagnostics', () => {
    it('turns esbuild positions (1-based line, 0-based column) into Monaco ones', () => {
        expect(markersFromDiagnostics([{ line: 3, column: 7, text: 'Expected ";"' }])).toEqual([{
            startLineNumber: 3, startColumn: 8, endLineNumber: 3, endColumn: 9,
            message: 'Expected ";"', severity: 8, source: 'esbuild',
        }]);
    });
    it('puts a diagnostic without a place on the first line', () => {
        expect(markersFromDiagnostics([{ line: 0, column: 0, text: 'No default export' }])[0])
            .toMatchObject({ startLineNumber: 1, startColumn: 1 });
        expect(markersFromDiagnostics(null)).toEqual([]);
    });
});

describe('fields', () => {
    const fields: ReactField[] = [{ name: 'title', type: 'text' }, { name: 'n', type: 'number' }];

    it('renaming takes the value along; a new type starts from that type\'s empty value', () => {
        expect(updateField(fields, { title: 'Hi', n: 2 }, 0, { name: 'heading', type: 'text' }).props).toEqual({ heading: 'Hi', n: 2 });
        expect(updateField(fields, { title: 'Hi', n: 2 }, 1, { name: 'n', type: 'boolean' }).props).toEqual({ title: 'Hi', n: false });
    });

    it('a removed field loses its value, a new one gets an empty value, an undeclared prop stays', () => {
        const next: ReactField[] = [{ name: 'n', type: 'number' }, { name: 'pick', type: 'select', options: ['a', 'b'] }];
        expect(propsForFields(fields, next, { title: 'x', n: 5, extra: 1 })).toEqual({ n: 5, pick: 'a', extra: 1 });
    });

    it('names: free name, invalid and duplicate', () => {
        expect(nextFieldName([])).toBe('prop');
        expect(nextFieldName([{ name: 'prop', type: 'text' }, { name: 'prop2', type: 'text' }])).toBe('prop3');
        expect(fieldNameProblem('2x', 0, fields)).toBe('invalid');
        expect(fieldNameProblem('n', 0, fields)).toBe('duplicate');
        expect(fieldNameProblem('title', 0, fields)).toBe('');
    });

    it('every field type has an empty value; junk fields are dropped; options parse', () => {
        for (const type of FIELD_TYPES) expect(emptyValueFor(type)).not.toBeUndefined();
        expect(emptyValueFor('link')).toEqual({ kind: 'external', url: '' });
        expect(fieldsOf({ fields: [null, { name: 'a' }, { name: 'b', type: 'text' }] as never })).toEqual([{ name: 'b', type: 'text' }]);
        expect(parseOptions(' a, b ,,c')).toEqual(['a', 'b', 'c']);
    });
});
