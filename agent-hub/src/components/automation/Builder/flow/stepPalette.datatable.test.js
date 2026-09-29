import { describe, it, expect } from 'vitest';
import { buildSearchResults } from './stepPalette';

/**
 * The palette is where "can this product remember anything?" gets answered.
 *
 * Before the datatable node, the words people actually search for — store,
 * save, remember, database, spreadsheet — appeared NOWHERE in stepPalette.js or
 * stepDisplayName.js, so the answer was an empty result list, which reads as
 * "you spelled it wrong" rather than "we cannot do that". And "table" ranked
 * "Edit data" first: an in-memory node that claims the word in its keywords.
 */

const CTX = { catalog: { flags: { code: true } } };
const kinds = (q) => buildSearchResults(q, CTX).map(r => r.payload?.kind);

describe('the palette answers a search for persistence', () => {
    for (const q of ['datatable', 'store', 'save', 'remember', 'database', 'persist', 'rows', 'spreadsheet', 'log']) {
        it(`"${q}" finds the datatable node`, () => {
            expect(kinds(q)).toContain('datatable');
        });
    }

    it('"between runs" finds it — the phrase for what it is actually for', () => {
        expect(kinds('between runs')).toContain('datatable');
    });
});

describe('the "table" query no longer lands on an in-memory node', () => {
    it('Datatable outranks Edit data', () => {
        const order = kinds('table');
        const dt = order.indexOf('datatable');
        const set = order.indexOf('set');
        expect(dt, 'the datatable node must be a result for "table"').toBeGreaterThanOrEqual(0);
        if (set >= 0) {
            // Relative order, not an absolute bucket: "Datatable".includes("table")
            // puts it in the includes bucket, while `set` matches only through
            // its keyword bag, one bucket lower.
            expect(dt).toBeLessThan(set);
        }
    });
});

describe('it does not steal queries that belong elsewhere', () => {
    it('"parse json" still lands on Edit data', () => {
        expect(kinds('parse json')[0]).toBe('set');
    });

    it('"email" does not surface a datatable', () => {
        expect(kinds('email')).not.toContain('datatable');
    });
});
