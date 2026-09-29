// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    FILTER_KIND, describeFilter, facetValues, filterKindFor, isActiveFilter, makeFilterFn,
} from './gridColumnFilters';

const row = (value) => ({ getValue: () => value });
const matches = (kind, cell, filter) => makeFilterFn(kind)(row(cell), 'c', filter);

describe('filterKindFor — the column format decides the control', () => {
    it('maps every numeric-looking format to a range', () => {
        for (const f of ['number', 'currency', 'percent', 'progress']) expect(filterKindFor(f)).toBe(FILTER_KIND.number);
    });
    it('maps the date formats to a from–to range', () => {
        for (const f of ['date', 'datetime', 'relative']) expect(filterKindFor(f)).toBe(FILTER_KIND.date);
    });
    it('maps boolean and check to yes/no', () => {
        expect(filterKindFor('boolean')).toBe(FILTER_KIND.boolean);
        expect(filterKindFor('check')).toBe(FILTER_KIND.boolean);
    });
    it('offers a pick list only when the column has known values', () => {
        expect(filterKindFor('badge', { hasOptions: true })).toBe(FILTER_KIND.select);
        expect(filterKindFor('badge', { hasOptions: false })).toBe(FILTER_KIND.text);
        // A text column with few distinct values is still free text: names
        // are not a vocabulary.
        expect(filterKindFor('text', { hasOptions: true })).toBe(FILTER_KIND.text);
    });
});

describe('facetValues — the distinct values of a column', () => {
    it('collects, dedupes and sorts; tags count one by one', () => {
        const rows = [{ s: 'open' }, { s: 'done' }, { s: 'open' }, { s: ['b', 'a'] }, { s: null }, { s: '' }];
        expect(facetValues(rows, 's').map((o) => o.value)).toEqual(['a', 'b', 'done', 'open']);
    });
    it('gives up past the limit — a dropdown of 200 names is not a filter', () => {
        const rows = Array.from({ length: 50 }, (_, i) => ({ s: `v${i}` }));
        expect(facetValues(rows, 's', 40)).toBeNull();
        expect(facetValues([], 's')).toBeNull();
    });
});

describe('isActiveFilter', () => {
    it('treats an empty string and an all-blank range as no filter', () => {
        expect(isActiveFilter('')).toBe(false);
        expect(isActiveFilter(undefined)).toBe(false);
        expect(isActiveFilter({ min: '', max: '' })).toBe(false);
        expect(isActiveFilter({ min: '5', max: '' })).toBe(true);
        expect(isActiveFilter('x')).toBe(true);
    });
});

describe('makeFilterFn — matching by kind', () => {
    it('number: a range, with formatted strings read as numbers', () => {
        expect(matches('number', 120, { min: '100', max: '200' })).toBe(true);
        expect(matches('number', 20, { min: '100' })).toBe(false);
        expect(matches('number', '€1.234,50', { min: '1000', max: '2000' })).toBe(true);
        expect(matches('number', '1,234.50', { max: '1300' })).toBe(true);
        // A blank cell is not "inside" any range someone typed.
        expect(matches('number', null, { min: '0' })).toBe(false);
    });
    it('date: from–to, the end inclusive of its whole day', () => {
        expect(matches('date', '2026-09-19T15:00:00Z', { from: '2026-09-19', to: '2026-09-19' })).toBe(true);
        expect(matches('date', '2026-09-20T01:00:00', { to: '2026-09-19' })).toBe(false);
        expect(matches('date', '2026-09-01', { from: '2026-09-10' })).toBe(false);
        expect(matches('date', 'not a date', { from: '2026-09-10' })).toBe(false);
    });
    it('boolean: yes/no over the ways a table spells true', () => {
        expect(matches('boolean', true, 'true')).toBe(true);
        expect(matches('boolean', 'ja', 'true')).toBe(true);
        expect(matches('boolean', 0, 'false')).toBe(true);
        expect(matches('boolean', null, 'false')).toBe(true);
        expect(matches('boolean', 'yes', 'false')).toBe(false);
    });
    it('select: exact value; a tags cell matches on any tag', () => {
        expect(matches('select', 'open', 'open')).toBe(true);
        expect(matches('select', 'reopened', 'open')).toBe(false);
        expect(matches('select', ['a', 'open'], 'open')).toBe(true);
    });
    it('text: case-insensitive contains, over objects and arrays too', () => {
        expect(matches('text', 'Klimaattechniek B.V', 'klimaat')).toBe(true);
        expect(matches('text', { label: 'Eemshaven' }, 'haven')).toBe(true);
        expect(matches('text', ['x', 'yz'], 'z')).toBe(true);
        expect(matches('text', 12, '2')).toBe(true);
    });
    it('an inactive filter matches everything and is auto-removed', () => {
        const fn = makeFilterFn('number');
        expect(fn(row(5), 'c', { min: '', max: '' })).toBe(true);
        expect(fn.autoRemove({ min: '', max: '' })).toBe(true);
        expect(fn.autoRemove({ min: '1' })).toBe(false);
    });
});

describe('describeFilter — the chip text', () => {
    it('says a range in symbols a reader knows', () => {
        expect(describeFilter('number', { min: '500', max: '2000' }, { locale: 'en-US' })).toBe('500 – 2,000');
        expect(describeFilter('number', { min: '500' })).toMatch(/^≥ 500$/);
        expect(describeFilter('number', { max: '2000' }, { locale: 'en-US' })).toBe('≤ 2,000');
    });
    it('says a date range in words', () => {
        expect(describeFilter('date', { from: '2026-09-01' }, { locale: 'en-GB' })).toBe('from 1 Sept 2026');
        expect(describeFilter('date', { to: '2026-09-19' }, { locale: 'en-GB' })).toBe('until 19 Sept 2026');
    });
    it('names a picked option by its label', () => {
        expect(describeFilter('select', 'op', { options: [{ value: 'op', label: 'Open' }] })).toBe('Open');
        expect(describeFilter('boolean', 'false')).toBe('no');
        expect(describeFilter('text', 'zoe')).toBe('“zoe”');
        expect(describeFilter('text', '')).toBe('');
    });
});
