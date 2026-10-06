/**
 * F49: a flatten's run in one sentence, every form, with the nouns taken
 * from the data's own keys.
 */
import { describe, expect, it } from 'vitest';
import { FLATTEN_MAIL_STEP, flattenMailRoot, flattenOrdersRoot } from '@shared/expr/corpus.mjs';
import { flattenRows } from '@shared/expr/flatten.mjs';
import { flattenSentence } from './flattenNote';

const t = (_key: string, fallback?: unknown, vars?: Record<string, unknown>) =>
    String(fallback ?? '').replace(/\{(\w+)\}/g, (_, v) => String(vars?.[v] ?? ''));

const ORDERS = { id: 'o_flat', type: 'flatten', arrayRef: 'steps.http.output.body.orders[*].lines' };
const envelope = (out: Record<string, unknown> | null) => {
    const { dead: _d, over: _o, ...rest } = out || {};
    return rest;
};

describe('flattenSentence (F49)', () => {
    it('the mail table: "Made 64 rows from 4 messages."', () => {
        const out = envelope(flattenRows(flattenMailRoot(), FLATTEN_MAIL_STEP));
        expect(flattenSentence(out, FLATTEN_MAIL_STEP, t)).toBe('Made 64 rows from 4 messages.');
    });

    it('an order without lines is left out, and the sentence says so', () => {
        const out = envelope(flattenRows(flattenOrdersRoot(), ORDERS));
        expect(flattenSentence(out, ORDERS, t)).toBe('Made 8 rows from 5 orders. 1 of them had no lines and made no row.');
    });

    it('with keepEmpty it got one row without line details', () => {
        const step = { ...ORDERS, keepEmpty: true };
        const out = envelope(flattenRows(flattenOrdersRoot(), step));
        expect(flattenSentence(out, step, t)).toBe('Made 9 rows from 5 orders. 1 of them had no lines and got one row without line details.');
    });

    it('a skip where no item has the list says why', () => {
        const out = { items: [], count: 0, inputCount: 4, emptyCount: 4, skipped: 'None of the 4 messages…' };
        expect(flattenSentence(out, FLATTEN_MAIL_STEP, t))
            .toBe('None of the 4 messages has a list called attachments, so there was nothing to flatten.');
    });

    it('an empty input list', () => {
        expect(flattenSentence({ items: [], count: 0, inputCount: 0, emptyCount: 0 }, FLATTEN_MAIL_STEP, t))
            .toBe('The list was empty, so there are no rows.');
    });

    it('goes through t with the keys of section 6.2', () => {
        const keys: string[] = [];
        const spy = (key: string, fallback?: unknown, vars?: Record<string, unknown>) => { keys.push(key); return t(key, fallback, vars); };
        flattenSentence({ items: [], count: 8, inputCount: 5, emptyCount: 1 }, ORDERS, spy);
        expect(keys).toEqual(['flatten_node.run.made_plural', 'flatten_node.run.empty_dropped']);
    });

    it('one row is a row, and two empty parents are counted as many', () => {
        expect(flattenSentence({ items: [{}], count: 1, inputCount: 3, emptyCount: 2 }, ORDERS, t))
            .toBe('Made 1 row from 3 orders. 2 of them had no lines and made no rows.');
    });
});
