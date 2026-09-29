import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    COLUMN_TYPES, FILTER_OPS, columnTypeKind, expiringSoonCutoffIso, filterDescriptor,
    filterEntry, opTakesList, opTakesNoValue, opsForColumn, retentionCutoffIso, rowExpiry,
    tableKindOf,
} from './datatableDisplay';
import { KINDS, KIND_WORD } from '../../../automation/Builder/mapping/fieldKinds';

/**
 * The bridge between the STORAGE vocabulary (text/richtext/datetime/select…)
 * and the one a person has already been taught in the builder's mapping
 * panel (text · number · yes/no · date · one of a list · list · file).
 *
 * Two directions are worth pinning, and for opposite reasons:
 *   - every datatable type must reach a kind that EXISTS, or the column
 *     designer renders a question-mark icon over a type the product fully
 *     supports;
 *   - an unknown type must NOT quietly become "text", because a type this
 *     build has not heard of is not evidence of a string — it is evidence
 *     that the two files have drifted.
 *
 * The retention and filter helpers live here too: both derive something the
 * server never sends (when a row expires; a closed filter descriptor), and
 * both are the kind of arithmetic that is wrong at a boundary rather than
 * wrong everywhere.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../../../../server');
const vocabulary = require(path.join(SERVER, 'core/dataEngine/dataModel/vocabulary.js'));

describe('columnTypeKind', () => {
    it('gives every offered column type a kind the builder knows', () => {
        for (const { type } of COLUMN_TYPES) {
            const kind = columnTypeKind(type);
            expect(KINDS, `${type} → ${kind}`).toContain(kind);
            expect(kind, `${type} must not fall through to unknown`).not.toBe('unknown');
            expect(KIND_WORD[kind]?.en, `${type} has no word`).toBeTruthy();
        }
    });

    it('folds the storage distinctions a person does not care about', () => {
        // Two Postgres columns, one idea.
        expect(columnTypeKind('text')).toBe('text');
        expect(columnTypeKind('richtext')).toBe('text');
        expect(columnTypeKind('date')).toBe('date');
        expect(columnTypeKind('datetime')).toBe('date');
    });

    it('keeps the distinctions a person DOES care about', () => {
        // One of a list is not a list: `select` holds one value, `multiselect`
        // holds several. Calling both "list" is what made a filter on a
        // dropdown offer "contains" instead of "is".
        expect(columnTypeKind('select')).toBe('choice');
        expect(columnTypeKind('multiselect')).toBe('list');
        expect(columnTypeKind('bool')).toBe('yesno');
        expect(columnTypeKind('number')).toBe('number');
        expect(columnTypeKind('file')).toBe('file');
    });

    it('answers unknown for a type it has never heard of, and for nothing at all', () => {
        // `computed` is a real server type the datatable surface deliberately
        // does not offer — it must not be dressed up as text on the way
        // through. `relation` is not OFFERED either (COLUMN_TYPES has no entry)
        // but it is MET, on a table that mirrors a Nextcloud table, so it has
        // a kind of its own rather than the "never heard of it" glyph.
        expect(vocabulary.FIELD_TYPES).toContain('relation');
        expect(columnTypeKind('relation')).toBe('relation');
        expect(COLUMN_TYPES.some(c => c.type === 'relation')).toBe(false);
        expect(columnTypeKind('computed')).toBe('unknown');
        expect(columnTypeKind(undefined)).toBe('unknown');
        expect(columnTypeKind(null)).toBe('unknown');
        expect(columnTypeKind('')).toBe('unknown');
    });
});

describe('tableKindOf', () => {
    it('paints a web-service cache as an app, and everything else as a table', () => {
        expect(tableKindOf({ managedKind: 'http_cache' })).toBe('app');
        expect(tableKindOf({ managedKind: null })).toBe('datatable');
        expect(tableKindOf(null)).toBe('datatable');
    });
});

describe('rowExpiry', () => {
    const NOW = Date.parse('2026-09-04T12:00:00.000Z');
    const RULE = { retentionDays: 30, retentionField: 'fetched_at' };

    it('counts from the table\'s OWN date column, the one the sweep uses', () => {
        const e = rowExpiry({ fetched_at: '2026-09-01T12:00:00.000Z' }, RULE, NOW);
        expect(e.days).toBe(27);
        expect(e.overdue).toBe(false);
        expect(e.at.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    });

    it('says overdue rather than showing a negative countdown as a future date', () => {
        // The sweep runs on a schedule, so "expired" and "gone" are not the
        // same moment — a row can sit here past its date.
        const e = rowExpiry({ fetched_at: '2026-07-01T12:00:00.000Z' }, RULE, NOW);
        expect(e.overdue).toBe(true);
        expect(e.days).toBeLessThan(0);
    });

    it('answers null rather than guessing when anything is missing', () => {
        expect(rowExpiry({ fetched_at: '2026-09-01' }, { retentionDays: null, retentionField: 'fetched_at' }, NOW)).toBeNull();
        expect(rowExpiry({ fetched_at: '2026-09-01' }, { retentionDays: 30, retentionField: null }, NOW)).toBeNull();
        expect(rowExpiry({}, RULE, NOW)).toBeNull();
        expect(rowExpiry({ fetched_at: null }, RULE, NOW)).toBeNull();
        expect(rowExpiry({ fetched_at: 'not a date' }, RULE, NOW)).toBeNull();
        expect(rowExpiry(null, RULE, NOW)).toBeNull();
    });
});

describe('the retention cut-offs', () => {
    const NOW = Date.parse('2026-09-04T12:00:00.000Z');

    it('a row is due when its date is older than the window', () => {
        expect(retentionCutoffIso(30, NOW)).toBe('2026-08-05T12:00:00.000Z');
        expect(retentionCutoffIso(null, NOW)).toBeNull();
    });

    it('"expiring in the next 7 days" is the window minus those 7 days', () => {
        // 30-day window, asked on the 4th: a row fetched on or before 12 Aug
        // reaches 30 days within the coming week.
        expect(expiringSoonCutoffIso(30, 7, NOW)).toBe('2026-08-12T12:00:00.000Z');
        expect(expiringSoonCutoffIso(null, 7, NOW)).toBeNull();
        expect(expiringSoonCutoffIso(30, 0, NOW)).toBeNull();
    });
});

describe('the filter descriptor stays closed', () => {
    it('offers only operators the server compiles', () => {
        expect(FILTER_OPS).toEqual([...vocabulary.FILTER_OPS]);
        for (const { type } of COLUMN_TYPES) {
            for (const op of opsForColumn({ type })) {
                expect(vocabulary.FILTER_OPS, `${type}: ${op}`).toContain(op);
            }
        }
        // An unknown column still gets a usable, valid set.
        for (const op of opsForColumn({ type: 'relation' })) {
            expect(vocabulary.FILTER_OPS).toContain(op);
        }
    });

    it('picks operators that suit the kind', () => {
        expect(opsForColumn({ type: 'number' })).toContain('gte');
        expect(opsForColumn({ type: 'number' })).not.toContain('contains');
        expect(opsForColumn({ type: 'select' })).toContain('in');
        expect(opsForColumn({ type: 'multiselect' })).toContain('contains');
        expect(opsForColumn({ type: 'bool' })).toEqual(['eq', 'neq', 'isNull', 'isNotNull']);
    });

    it('knows which operators take no value and which take a list', () => {
        expect(opTakesNoValue('isNull')).toBe(true);
        expect(opTakesNoValue('isNotNull')).toBe(true);
        expect(opTakesNoValue('eq')).toBe(false);
        expect(opTakesList('in')).toBe(true);
        expect(opTakesList('between')).toBe(true);
        expect(opTakesList('eq')).toBe(false);
    });

    it('never sends a half-typed condition', () => {
        // `field = ''` returns nothing and reads as "no rows match" rather
        // than "you have not finished".
        expect(filterEntry({ field: 'stage', op: 'eq', value: '' })).toBeNull();
        expect(filterEntry({ field: 'stage', op: 'eq' })).toBeNull();
        expect(filterEntry({ field: '', op: 'eq', value: 'x' })).toBeNull();
        expect(filterEntry({ field: 'stage', op: 'nope', value: 'x' })).toBeNull();
        expect(filterEntry({ field: 'stage', op: 'between', value: '1' })).toBeNull();
    });

    it('sends a real zero and a real false', () => {
        expect(filterEntry({ field: 'total', op: 'eq', value: 0 })).toEqual({ field: 'total', op: 'eq', value: 0 });
        expect(filterEntry({ field: 'active', op: 'eq', value: false })).toEqual({ field: 'active', op: 'eq', value: false });
    });

    it('splits a list operator on commas and drops the blanks', () => {
        expect(filterEntry({ field: 'stage', op: 'in', value: 'new, won ,' }))
            .toEqual({ field: 'stage', op: 'in', value: ['new', 'won'] });
        expect(filterEntry({ field: 'total', op: 'between', value: '10, 20' }))
            .toEqual({ field: 'total', op: 'between', value: ['10', '20'] });
    });

    it('a no-value operator needs nothing typed', () => {
        expect(filterEntry({ field: 'stage', op: 'isNull' }))
            .toEqual({ field: 'stage', op: 'isNull', value: null });
    });

    it('the descriptor is the answerable rows only', () => {
        expect(filterDescriptor([
            { field: 'stage', op: 'eq', value: 'new' },
            { field: 'total', op: 'gt', value: '' },
            null,
        ])).toEqual([{ field: 'stage', op: 'eq', value: 'new' }]);
        expect(filterDescriptor(null)).toEqual([]);
    });
});
