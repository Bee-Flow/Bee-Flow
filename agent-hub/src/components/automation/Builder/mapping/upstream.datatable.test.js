import { describe, it, expect } from 'vitest';
import { describeNode } from './upstream';

/**
 * `describeNode` is the design-time output-shape authority.
 *
 * A step type missing from its if-chain returns null, computeUpstreamGroups
 * does `if (!g) continue`, and the node then contributes NO group to the
 * variable picker: nothing downstream can bind to its output through any
 * picker, drag, auto-map or the Input panel — and NOTHING ERRORS. That silence
 * is what this file exists to prevent.
 */

const CATALOG = {
    datatables: [{
        id: 'tbl_aaaaaa',
        name: 'Customers',
        columns: [
            { key: 'email', name: 'Email', type: 'text' },
            { key: 'signups', name: 'Signups', type: 'number' },
            { key: 'active', name: 'Active', type: 'bool' },
            { key: 'joined', name: 'Joined', type: 'datetime' },
        ],
    }],
};

const node = (over = {}) => ({ id: 's1', type: 'datatable', datatableId: 'tbl_aaaaaa', op: 'find_rows', ...over });
const describe_ = (n) => describeNode(n, { steps: [n] }, {}, {}, null, CATALOG);

describe('a datatable step contributes a group to the picker', () => {
    it('returns a group rather than null', () => {
        const g = describe_(node());
        expect(g).toBeTruthy();
        expect(g.id).toBe('s1');
        expect(g.basePath).toBe('steps.s1.output');
        expect(g.kind).toBe('datatable');
    });

    it('names the group after the table when the step has no label', () => {
        expect(describe_(node()).label).toBe('Customers');
    });

    it('prefers the author\'s own label', () => {
        expect(describe_(node({ label: 'Look up the customer' })).label).toBe('Look up the customer');
    });
});

describe('find_rows exposes the row shape before the step has ever run', () => {
    const g = describe_(node());

    it('exposes rows, returned, found, hasMore and the cursor for the next page', () => {
        for (const k of ['rows', 'returned', 'found', 'hasMore', 'nextCursor']) {
            expect(Object.keys(g.sample)).toContain(k);
        }
    });

    it('no longer offers `count` — it never meant "how many rows match"', () => {
        // It was rows.length CLAMPED BY THE PAGE SIZE, so a condition on
        // `count > 100` after a default page of 50 could never fire. The
        // runtime still resolves it for one release; the picker must stop
        // teaching it, and count_rows answers the real question.
        expect(Object.keys(g.sample)).not.toContain('count');
        const counting = describe_(node({ op: 'count_rows' })).sample;
        expect(Object.keys(counting)).toEqual(['count', 'found']);
    });

    it('the row carries every declared column', () => {
        const row = g.sample.rows[0];
        for (const k of ['email', 'signups', 'active', 'joined']) {
            expect(Object.keys(row)).toContain(k);
        }
    });

    it('the row carries the system columns too', () => {
        const row = g.sample.rows[0];
        expect(row.id).toBeDefined();
        expect(row.created_at).toBeDefined();
    });

    it('samples come from column TYPES, never from real rows', () => {
        const row = g.sample.rows[0];
        expect(typeof row.email).toBe('string');
        expect(typeof row.signups).toBe('number');
        expect(typeof row.active).toBe('boolean');
        // A definition is a portable document; a sample drawn from live rows
        // would put customer data into it.
        expect(row.email).not.toMatch(/@/);
    });
});

describe('each write operation exposes what it actually returns', () => {
    it('add_row and save_row expose the row and the created flag', () => {
        for (const op of ['add_row', 'save_row']) {
            const s = describe_(node({ op })).sample;
            expect(Object.keys(s)).toContain('row');
            expect(Object.keys(s)).toContain('created');
        }
    });

    it('add_row and save_row expose the id of the row they wrote', () => {
        // The step returns it at the top level as well as inside `row`; the
        // next step almost always needs it, and reaching through `row` is one
        // indirection nobody guesses.
        for (const op of ['add_row', 'save_row']) {
            const s = describe_(node({ op })).sample;
            expect(s.id).toBeDefined();
            expect(s.row.id).toBeDefined();
        }
    });

    it('update_rows exposes a count and whether it ran out of room, not a row', () => {
        const s = describe_(node({ op: 'update_rows' })).sample;
        // `truncated` is bindable because a partial write that reports success
        // is exactly what an author needs to branch on.
        expect(Object.keys(s)).toEqual(['updated', 'truncated']);
    });

    it('delete_rows exposes a count', () => {
        const s = describe_(node({ op: 'delete_rows' })).sample;
        expect(Object.keys(s)).toEqual(['deleted', 'truncated']);
    });
});

describe('it degrades rather than breaking', () => {
    it('a table the catalog has not loaded still yields a bindable group', () => {
        const g = describeNode(node(), { steps: [] }, {}, {}, null, null);
        expect(g).toBeTruthy();
        expect(g.sample.rows[0].id).toBeDefined();
    });

    it('a step with no table picked still yields a group', () => {
        const g = describe_(node({ datatableId: '' }));
        expect(g).toBeTruthy();
    });
});
