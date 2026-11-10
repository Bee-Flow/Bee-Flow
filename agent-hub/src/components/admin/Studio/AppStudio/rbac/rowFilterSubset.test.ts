// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { validateRowFilterExpr } from './rowFilterSubset';

const table = {
    id: 't1',
    key: 'tasks',
    fields: [
        { key: 'owner_id', type: 'text' },
        { key: 'status', type: 'select' },
        { key: 'total', type: 'computed', computed: { stored: false } }, // read-time
        { key: 'score', type: 'computed', computed: { stored: true } },   // physical
    ],
};

describe('validateRowFilterExpr — accepts the supported subset', () => {
    it('treats an empty/blank rule as valid (no rule)', () => {
        expect(validateRowFilterExpr('', table).ok).toBe(true);
        expect(validateRowFilterExpr('   ', table).ok).toBe(true);
        expect(validateRowFilterExpr(null, table).ok).toBe(true);
    });

    it('accepts record/viewer comparisons, logic and negation', () => {
        expect(validateRowFilterExpr('record.owner_id == viewer.id', table).ok).toBe(true);
        expect(validateRowFilterExpr('record.status == "open" && record.owner_id == viewer.id', table).ok).toBe(true);
        expect(validateRowFilterExpr('record.status != "archived" || record.owner_id == viewer.id', table).ok).toBe(true);
        expect(validateRowFilterExpr('!(record.status == "archived")', table).ok).toBe(true);
    });

    it('accepts the system columns and stored computed columns', () => {
        expect(validateRowFilterExpr('record.created_by == viewer.id', table).ok).toBe(true);
        expect(validateRowFilterExpr('record.score > 3', table).ok).toBe(true);
    });
});

describe('validateRowFilterExpr — flags out-of-subset rules', () => {
    it('rejects function calls', () => {
        const r = validateRowFilterExpr('lower(record.status) == "x"', table);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/function/i);
    });

    it('rejects arithmetic', () => {
        expect(validateRowFilterExpr('record.score + 1 > 2', table).ok).toBe(false);
    });

    it('rejects unknown roots like currentUser/item', () => {
        const r = validateRowFilterExpr('item.owner_id == currentUser.id', table);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/record|viewer|Unknown/i);
    });

    it('rejects unknown fields', () => {
        expect(validateRowFilterExpr('record.nope == viewer.id', table).ok).toBe(false);
    });

    it('rejects read-time computed fields (no physical column)', () => {
        expect(validateRowFilterExpr('record.total == 1', table).ok).toBe(false);
    });

    it('rejects a ternary', () => {
        expect(validateRowFilterExpr('record.owner_id == viewer.id ? 1 : 0', table).ok).toBe(false);
    });

    it('flags a grammar error', () => {
        expect(validateRowFilterExpr('record.owner_id ==', table).ok).toBe(false);
    });
});

describe('validateRowFilterExpr — the message says what is wrong', () => {
    it('names the column instead of the grammar rule that failed', () => {
        expect(validateRowFilterExpr('record.nope == viewer.id', table).error)
            .toBe('This table has no column called "nope".');
        expect(validateRowFilterExpr('item.owner_id == 1', table).error)
            .toMatch(/record\.<column> and viewer\.<attribute>/);
        expect(validateRowFilterExpr('record.owner_id ==', table).error)
            .toMatch(/^This rule could not be read — /);
    });
});

describe('validateRowFilterExpr — a list of the person', () => {
    const teams = { fields: [{ key: 'team', type: 'text' }, { key: 'status', type: 'select' }, { key: 'amount', type: 'number' }, { key: 'tags', type: 'multiselect' }] };

    it('accepts record.<text column> in viewer.groups, alone and combined', () => {
        expect(validateRowFilterExpr('record.team in viewer.groups', teams)).toEqual({ ok: true, error: null });
        expect(validateRowFilterExpr('record.status in viewer.groups || record.team == viewer.email', teams).ok).toBe(true);
        expect(validateRowFilterExpr('!(record.created_by in viewer.groups) && record.org_id == viewer.orgId', teams).ok).toBe(true);
    });

    it('says what is wrong with any other shape', () => {
        expect(validateRowFilterExpr('record.amount in viewer.groups', teams).error)
            .toBe('The column "amount" cannot be tested with "in". Only a text or choice column can.');
        expect(validateRowFilterExpr('record.tags in viewer.groups', teams).ok).toBe(false);
        expect(validateRowFilterExpr('record.created_at in viewer.groups', teams).ok).toBe(false);
        expect(validateRowFilterExpr('record.team in viewer.email', teams).error)
            .toBe('Only a list of the person can stand on the right of "in": viewer.groups.');
        expect(validateRowFilterExpr('"x" in viewer.groups', teams).error).toBe('Put record.<column> on the left of "in".');
        expect(validateRowFilterExpr('record.nope in viewer.groups', teams).error).toBe('This table has no column called "nope".');
        expect(validateRowFilterExpr('record.team == viewer.groups', teams).error)
            .toBe('viewer.groups is a list. Write record.<column> in viewer.groups.');
    });

    it('advises viewer.orgId over viewer.organizationId without refusing the rule', () => {
        const check = validateRowFilterExpr('record.org_id == viewer.organizationId', teams);
        expect(check.ok).toBe(true);
        expect(check.warning).toMatch(/Use viewer\.orgId in a new rule/);
        expect(validateRowFilterExpr('record.org_id == viewer.orgId', teams).warning).toBeUndefined();
    });
});
