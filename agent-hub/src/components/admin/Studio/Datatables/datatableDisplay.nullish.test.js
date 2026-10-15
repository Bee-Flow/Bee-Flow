// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    MANAGED_COLUMNS, columnTypeKind, describeAccess, destructiveChanges, gradeAtLeast, isManagedColumn,
    managedColumnProblem, opsForColumn, rowExpiry, validateColumns,
} from './datatableDisplay';

/**
 * What the display helpers do with a missing kind, grade or table. Several
 * were plain lookups (`MAP[key]`) that answered "nothing" for undefined and
 * null; the typed version guards the key and must answer the same.
 */
describe('datatableDisplay: missing and odd arguments', () => {
    it('gradeAtLeast: an unknown or missing grade is below every minimum, a missing minimum is above every grade', () => {
        expect(gradeAtLeast('owner', 'editor')).toBe(true);
        expect(gradeAtLeast('viewer', 'editor')).toBe(false);
        expect(gradeAtLeast('editor', 'editor')).toBe(true);
        expect(gradeAtLeast(undefined, 'viewer')).toBe(false);
        expect(gradeAtLeast(null, 'viewer')).toBe(false);
        expect(gradeAtLeast('nope', 'viewer')).toBe(false);
        expect(gradeAtLeast('owner', undefined)).toBe(false);
        expect(gradeAtLeast('owner', null)).toBe(false);
        expect(gradeAtLeast('owner', 'nope')).toBe(false);
        expect(gradeAtLeast(undefined, undefined)).toBe(false);
    });

    it('columnTypeKind: no type and an unknown type are unknown', () => {
        expect(columnTypeKind(undefined)).toBe('unknown');
        expect(columnTypeKind(null)).toBe('unknown');
        expect(columnTypeKind('')).toBe('unknown');
        expect(columnTypeKind('mystery')).toBe('unknown');
        expect(columnTypeKind('bool')).toBe('yesno');
        expect(columnTypeKind('relation')).toBe('relation');
        expect(opsForColumn(undefined)).toEqual(opsForColumn({ type: 'mystery' }));
        expect(opsForColumn(null)).toEqual(['eq', 'neq', 'isNull', 'isNotNull']);
        expect(opsForColumn({})).toEqual(['eq', 'neq', 'isNull', 'isNotNull']);
    });

});

describe('datatableDisplay: managed tables and retention with missing arguments', () => {
    it('isManagedColumn: a missing kind has no managed columns', () => {
        expect(isManagedColumn(undefined, 'run_id')).toBe(false);
        expect(isManagedColumn(null, 'run_id')).toBe(false);
        expect(isManagedColumn('unheard_of', 'run_id')).toBe(false);
        expect(isManagedColumn('form_answers', 'anything')).toBe(true);
        expect(isManagedColumn('nextcloud_table', 'anything')).toBe(true);
        expect(isManagedColumn('http_cache', 'cache_key')).toBe(true);
        expect(isManagedColumn('http_cache', 'mine')).toBe(false);
        expect(isManagedColumn('document_sheet', 'row_no')).toBe(true);
    });

    it('managedColumnProblem: no kind and an unmanaged kind have no problem', () => {
        expect(managedColumnProblem(undefined, [])).toBeNull();
        expect(managedColumnProblem(null, [{ key: 'a', type: 'text' }])).toBeNull();
        expect(managedColumnProblem('unheard_of', [])).toBeNull();
        expect(managedColumnProblem('form_answers', [])).toEqual({ reason: 'definition_owned' });
        expect(managedColumnProblem('spreadsheet_file', [])).toEqual({ reason: 'source_owned' });
        expect(managedColumnProblem('http_cache', [])).toEqual({ reason: 'missing', key: 'cache_key' });
        const ok = MANAGED_COLUMNS.http_cache.map((c) => ({ ...c }));
        expect(managedColumnProblem('http_cache', ok)).toBeNull();
        expect(managedColumnProblem('http_cache', ok.map((c) => (c.key === 'fetched_at' ? { ...c, type: 'text' } : c))))
            .toEqual({ reason: 'retyped', key: 'fetched_at', type: 'datetime' });
        expect(managedColumnProblem('http_cache', ok.map((c) => (c.key === 'cache_key' ? { ...c, unique: false } : c))))
            .toEqual({ reason: 'unique', key: 'cache_key' });
    });

    it('validateColumns names a missing type and an over-long name', () => {
        expect(validateColumns([{ key: 'a_b', name: 'Fine', type: 'text' }])).toEqual([]);
        expect(validateColumns([{ key: 'a_b' }])).toEqual(['a_b needs a type.']);
        expect(validateColumns([{ key: 'a_b', type: 'mystery' }])).toEqual(['a_b needs a type.']);
        expect(validateColumns([{ key: 'a_b', name: 'x'.repeat(121), type: 'text' }]))
            .toEqual([`${'x'.repeat(121)}'s name is longer than 120 characters.`]);
        expect(validateColumns(null)).toEqual([]);
    });

    it('destructiveChanges lists removed and retyped columns', () => {
        const prev = [{ key: 'a', type: 'text' }, { key: 'b', type: 'number' }, { key: 'c', type: 'date' }];
        const next = [{ key: 'a', type: 'richtext' }, { key: 'c', type: 'date' }, { key: 'd', type: 'text' }];
        expect(destructiveChanges(prev, next)).toEqual({
            removed: ['b'],
            retyped: [{ key: 'a', from: 'text', to: 'richtext' }],
            any: true,
        });
        expect(destructiveChanges(prev, prev)).toEqual({ removed: [], retyped: [], any: false });
        expect(destructiveChanges(null, undefined)).toEqual({ removed: [], retyped: [], any: false });
    });

    it('describeAccess names the groups of a shared table and tolerates a missing table', () => {
        const names = new Map([['g1', 'Finance']]);
        const shared = { isPublished: true, sharedGroups: ['g1', 'g2'], writeMode: 'audience' };
        expect(describeAccess(shared, names)).toEqual({
            readers: 'Members of Finance and g2',
            writers: 'all of them',
            audience: 'groups',
            broad: false,
        });
        expect(describeAccess({ isPublished: true, sharedGroups: [] }).readers).toBe('Everyone in your organisation');
        expect(describeAccess({ isPublished: true, writeMode: 'audience' }).broad).toBe(true);
        expect(describeAccess(null)).toEqual({
            readers: 'Only you and the people you share it with',
            writers: 'only the people you invite',
            audience: 'private',
            broad: false,
        });
        expect(describeAccess(undefined, undefined, (key, en, params) => `${key}|${en}|${JSON.stringify(params ?? null)}`).writers)
            .toBe('studio_misc.access.writers_invited|only the people you invite|null');
    });

    it('rowExpiry builds the date from whatever the cell holds, exactly as new Date would', () => {
        const NOW = Date.UTC(2026, 0, 10);
        const retention = { retentionDays: 30, retentionField: 'created' };
        const days = (cell) => rowExpiry({ created: cell }, retention, NOW);
        expect(days('2026-01-01T00:00:00Z')).toEqual({ at: new Date(Date.UTC(2026, 0, 31)), days: 21, overdue: false });
        expect(days(Date.UTC(2025, 11, 1))?.overdue).toBe(true);
        expect(days(new Date(Date.UTC(2026, 0, 1)))?.days).toBe(21);
        // Odd cells go through the Date constructor like any other value.
        expect(days(true)?.at.getTime()).toBe(1 + 30 * 86400000);
        expect(days([2026])?.at.getTime()).toBe(new Date([2026]).getTime() + 30 * 86400000);
        for (const cell of ['not a date', {}, NaN, 'abc', Infinity]) expect(days(cell)).toBeNull();
        for (const cell of [null, undefined, '']) expect(days(cell)).toBeNull();
        expect(rowExpiry(null, retention, NOW)).toBeNull();
        expect(rowExpiry({ created: '2026-01-01' }, { retentionDays: 0, retentionField: 'created' }, NOW)).toBeNull();
        expect(rowExpiry({ created: '2026-01-01' }, { retentionDays: 30 }, NOW)).toBeNull();
        expect(rowExpiry({ created: '2026-01-01' }, undefined, NOW)).toBeNull();
    });
});
