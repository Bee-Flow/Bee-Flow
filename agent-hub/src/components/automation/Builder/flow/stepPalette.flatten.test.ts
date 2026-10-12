import { describe, expect, it } from 'vitest';
import { buildStepFromPayload } from '../applyAddNode';
import { stepFamily } from './nodeDefs';
import { stepOutputIsArray } from './ribbon/fitsAfter';
import { TAB_ROWS } from './ribbon/ribbonRows';
import { expandQuery } from './ribbon/ribbonSearch';
import { buildSearchResults as buildSearchResultsJs, buildStepGroups as buildStepGroupsJs, COLLECTION_ITEMS, FILTER_LIST_ITEM } from './stepPalette';

/**
 * "Flatten a list" sits right after "Filter a list" in the Lists group, is
 * found by the words other tools use for it (split out, unnest, explode),
 * and drops a blank `flatten` step for auto-map to fill.
 */
const catalog = { apps: [], steps: [], flags: { code: true } };
type Group = { key: string; sections: Array<{ key: string; items: Array<{ id: string }> }> };
// Untyped JS helpers; their options are checked there.
const buildStepGroups = buildStepGroupsJs as unknown as (opts: Record<string, unknown>) => Group[];
const buildSearchResults = buildSearchResultsJs as unknown as (q: string, opts: Record<string, unknown>) => Array<{ key: string }>;

describe('stepPalette: Flatten a list', () => {
    it('comes directly after Filter a list', () => {
        expect(COLLECTION_ITEMS[0]).toBe(FILTER_LIST_ITEM);
        expect(COLLECTION_ITEMS[1].id).toBe('flatten');
        const data = buildStepGroups({ catalog }).find(g => g.key === 'flow')
            ?.sections.find(s => s.key === 'data');
        const ids = (data?.items || []).map(i => i.id);
        expect(ids.indexOf('flatten')).toBe(ids.indexOf('filter_list') + 1);
    });

    it('is found first for "flatten", and aggregate no longer is', () => {
        const hits = buildSearchResults('flatten', { catalog });
        expect(hits[0].key).toBe('flatten');
        expect(hits.some((h: { key: string }) => h.key === 'aggregate')).toBe(false);
    });

    it('is found by the words other tools use', () => {
        for (const word of ['split out', 'unnest', 'one row per', 'attachments']) {
            expect(buildSearchResults(word, { catalog }).some((h: { key: string }) => h.key === 'flatten'), word).toBe(true);
        }
        expect(expandQuery('split out')).toContain('flatten');
    });

    it('drops a blank flatten step in the data family', () => {
        const step = buildStepFromPayload(COLLECTION_ITEMS[1].payload, { x: 0, y: 0 });
        expect(step).toMatchObject({ type: 'flatten', arrayRef: '', keepEmpty: false, label: 'Flatten a list' });
        expect(stepFamily('flatten')).toBe('data');
    });

    it('is in the ribbon\'s Lists menu, and its output fits list steps', () => {
        const lists = TAB_ROWS.data.flat().find(s => typeof s === 'object' && s.menu === 'lists') as { ids: string[] };
        expect(lists.ids.slice(0, 2)).toEqual(['filter_list', 'flatten']);
        expect(stepOutputIsArray({ type: 'flatten' }, null)).toBe(true);
    });
});
