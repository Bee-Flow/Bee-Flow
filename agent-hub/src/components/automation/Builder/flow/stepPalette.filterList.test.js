import { describe, expect, it } from 'vitest';
import { buildSearchResults, buildStepGroups, COLLECTION_ITEMS, FILTER_LIST_ITEM, itemForKey, LOGIC_ITEMS } from './stepPalette';
import { buildStepFromPayload } from '../applyAddNode';
import { nodeDefaultLabel, nodeLabel } from './nodeDefs';

/**
 * BFSF-485 F1: keeping the matching items of a list is findable as "Filter a
 * list", the first entry of the Lists part of the palette. It drops the ONE
 * Condition node, already working through a list, under the Condition name.
 */
const catalog = { apps: [], steps: [], flags: { code: true } };
const dataSection = (opts = {}) => buildStepGroups({ catalog, ...opts })
    .find(g => g.key === 'flow').sections.find(s => s.key === 'data');

describe('stepPalette — Filter a list', () => {
    it('is the first of the list operations', () => {
        expect(COLLECTION_ITEMS[0]).toBe(FILTER_LIST_ITEM);
        const ids = dataSection().items.map(i => i.id);
        expect(ids.indexOf('filter_list')).toBe(ids.indexOf('flatten') - 1);
    });

    it('says what it does in its own words', () => {
        expect(FILTER_LIST_ITEM.label).toBe('Filter a list');
        expect(FILTER_LIST_ITEM.desc).toBe('Keep only the items of a list that match; the rest stop here.');
    });

    it('reads its words from the condition_node keys, with the English as fallback', () => {
        const seen = [];
        const t = (key, fallback) => { seen.push([key, fallback]); return `nl:${fallback}`; };
        const item = dataSection({ t }).items.find(i => i.id === 'filter_list');
        expect(item.label).toBe('nl:Filter a list');
        expect(item.desc).toBe('nl:Keep only the items of a list that match; the rest stop here.');
        expect(seen).toContainEqual(['condition_node.palette.filter_label', 'Filter a list']);
        expect(seen).toContainEqual(['condition_node.palette.filter_desc', 'Keep only the items of a list that match; the rest stop here.']);
    });

    it('drops the Condition node in list mode, with an empty list for auto-map to fill', () => {
        expect(FILTER_LIST_ITEM.payload).toEqual({ kind: 'filter', label: 'Condition' });
        const step = buildStepFromPayload(FILTER_LIST_ITEM.payload, { x: 0, y: 0 });
        expect(step).toMatchObject({ type: 'filter', arrayRef: '', label: 'Condition' });
    });

    it('keeps the Condition entry, with its own description, in Flow control', () => {
        const route = LOGIC_ITEMS.find(i => i.id === 'route');
        expect(route.payload.kind).toBe('condition');
        expect(route.desc).toBe('Keep, split or branch — one rule or many');
        expect(route.icon).not.toBe(FILTER_LIST_ITEM.icon);
    });

    it('is found by the words people use for it', () => {
        for (const word of ['filter', 'keep only', 'exclude', 'subset', 'matching']) {
            const hits = buildSearchResults(word, { catalog });
            expect(hits.some(h => h.key === 'filter_list'), `"${word}" finds Filter a list`).toBe(true);
        }
        // A search result names the browse group it lives in: "Lists", not an internal "Collection".
        expect(buildSearchResults('filter', { catalog }).find(h => h.key === 'filter_list').context).toBe('Lists');
    });

    it('brings recorded filter usage back as this entry, and the other deciding steps as the Condition', () => {
        expect(itemForKey('step:filter', { catalog })?.key).toBe('filter_list');
        expect(itemForKey('step:switch', { catalog })?.key).toBe('route');
        expect(itemForKey('step:condition', { catalog })?.key).toBe('route');
    });
});

describe('nodeDefs — a filter keeps the one node name', () => {
    it('names a filter card "Condition" and gives the type no palette words of its own', () => {
        expect(nodeDefaultLabel('filter')).toBe('Condition');
        expect(nodeLabel('filter')).toBe('');
    });
});
