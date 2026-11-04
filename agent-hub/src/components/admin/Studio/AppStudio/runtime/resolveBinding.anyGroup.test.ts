import { describe, it, expect } from 'vitest';
import { resolveBindingFilters, dataCacheKey } from './resolveBinding';
import type { Binding, DataBinding } from './resolveBinding.types';

/**
 * `{ any: [...] }` OR groups in a record/records/aggregate filter: formula
 * clauses resolve against the live scope, an unresolved clause drops out of
 * its group, an emptied group drops (or, when required, means no query), and
 * an untouched binding comes back as the same object (cache keys, memo).
 */

const SCOPE = { vars: { status: 'open', none: null }, currentUser: { id: 'u-1' } };
const formula = (expr: string) => ({ kind: 'formula', expr });
const OPEN = { field: 'status', op: 'eq', value: formula('vars.status') };
const NONE = { field: 'owner', op: 'eq', value: formula('vars.none') };
const HIGH = { field: 'priority', op: 'eq', value: 'high' };
const records = (filter: unknown[]): Binding => ({ kind: 'records', tableId: 't1', filter } as Binding);

describe('resolveBindingFilters with any groups', () => {
    it('keeps a literal-only group binding AS-IS', () => {
        const b = records([{ any: [HIGH, { field: 'x', op: 'isNull' }] }]);
        expect(resolveBindingFilters(b, SCOPE)).toBe(b);
    });

    it('resolves formula clauses inside a group and drops the unresolved ones', () => {
        const out = resolveBindingFilters(records([{ any: [OPEN, NONE, HIGH] }]), SCOPE) as DataBinding;
        expect(out.filter).toEqual([{ any: [{ field: 'status', op: 'eq', value: 'open' }, HIGH] }]);
    });

    it('drops a group left empty, and the filter with it', () => {
        expect(resolveBindingFilters(records([{ any: [NONE] }]), SCOPE)).toEqual({ kind: 'records', tableId: 't1' });
        expect((resolveBindingFilters(records([HIGH, { any: [NONE] }]), SCOPE) as DataBinding).filter).toEqual([HIGH]);
    });

    it('a required group with nothing resolved means no query at all', () => {
        expect(resolveBindingFilters(records([HIGH, { any: [NONE], required: true }]), SCOPE)).toBeNull();
    });

    it('the cache key follows the resolved group', () => {
        const a = resolveBindingFilters(records([{ any: [OPEN, HIGH] }]), SCOPE);
        const b = resolveBindingFilters(records([{ any: [OPEN, HIGH] }]), { ...SCOPE, vars: { status: 'done', none: null } });
        expect(dataCacheKey(a)).not.toEqual(dataCacheKey(b));
    });

    it('aggregate bindings resolve groups too', () => {
        const agg = { kind: 'aggregate', tableId: 't1', filter: [{ any: [OPEN] }], aggregates: [{ fn: 'count' }] } as Binding;
        expect((resolveBindingFilters(agg, SCOPE) as DataBinding).filter).toEqual([{ any: [{ field: 'status', op: 'eq', value: 'open' }] }]);
    });
});
