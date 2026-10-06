/**
 * F47: a step that runs once per row of a flatten (or of a filter after one)
 * calls its item `attachment`, not `item`: the rows are named by what they
 * are, through the shared listNounKey.
 */
import { describe, expect, it } from 'vitest';
import { FLATTEN_MAIL_STEP } from '@shared/expr/corpus.mjs';
import { suggestItemVar } from './loops';

const definition = {
    steps: [
        { ...FLATTEN_MAIL_STEP },
        { id: 'mf_filter', type: 'filter', arrayRef: 'steps.mf_flatten.output.items', expr: 'true' },
    ],
};

describe('suggestItemVar with a definition (F47)', () => {
    it('names the rows of a flatten after its inner list', () => {
        expect(suggestItemVar('items', definition, 'steps.mf_flatten.output.items')).toBe('attachment');
    });

    it('looks through a filter over a flatten', () => {
        expect(suggestItemVar('items', definition, 'steps.mf_filter.output.items')).toBe('attachment');
    });

    it('without a definition keeps naming by the key', () => {
        expect(suggestItemVar('items')).toBe('item');
        expect(suggestItemVar('lineItems', null, 'steps.x.output.lineItems')).toBe('lineItem');
    });
});

describe('picking a flatten\'s rows as the list a step repeats over', () => {
    it('names the item attachment when the definition is known, item without it', async () => {
        const { pickLoopList } = await import('../loopLists');
        const scope = { overRef: '', itemVar: 'item' };
        const choice = { path: 'steps.mf_filter.output.items' };
        expect(pickLoopList(scope, choice, { bindings: {}, definition }).patch.itemVar).toBe('attachment');
        expect(pickLoopList(scope, choice, { bindings: {} }).patch.itemVar).toBe('item');
    });
});
