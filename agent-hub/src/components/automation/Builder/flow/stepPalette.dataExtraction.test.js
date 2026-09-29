import { describe, it, expect } from 'vitest';
import { AI_ITEMS, AI_STEP, DATA_EXTRACTION, buildStepGroups, buildSearchResults, itemForKey } from './stepPalette';
import { nodeDefaultLabel, nodeLabel, nodeDesc, stepFamily } from './nodeDefs';
import { sectionKeyForKind, originKeysFor } from './ribbonOrigin';

/**
 * The Extract data step's place in the palette: the AI family's second
 * member, right beside the AI step, in every surface the palette feeds — the
 * AI group (ribbon cluster + edge-drop popover), the search, the usage
 * resolver and the ribbon-flight origin. Not in any of the four Home content
 * sections, so stepPalette.oneHome.test.js stays true.
 */
const catalog = { apps: [], steps: [], flags: { code: true } };

describe('stepPalette — Extract data sits beside the AI step', () => {
    it('the AI group offers the AI step first, then Extract data, both named from nodeDefs', () => {
        expect(AI_ITEMS).toEqual([AI_STEP, DATA_EXTRACTION]);
        const ai = buildStepGroups({ catalog }).find(g => g.key === 'ai');
        expect(ai.items.map(it => it.payload.kind)).toEqual(['ai_step', 'data_extraction']);
        expect(DATA_EXTRACTION.label).toBe(nodeLabel('data_extraction'));
        expect(DATA_EXTRACTION.desc).toBe(nodeDesc('data_extraction'));
        expect(DATA_EXTRACTION.payload).toEqual({ kind: 'data_extraction', label: nodeDefaultLabel('data_extraction') });
        expect(DATA_EXTRACTION.payload.label).toBe('Extract data');
        expect(stepFamily('data_extraction')).toBe('ai');
    });

    it('is offered inside a loop body and a flowlet too (extraction per item is its main shape)', () => {
        for (const scope of [{ catalog, inLayer: true, canCreateLayer: false }, { catalog, isBlockRoot: true }]) {
            const ai = buildStepGroups(scope).find(g => g.key === 'ai');
            expect(ai.items.some(it => it.payload.kind === 'data_extraction')).toBe(true);
        }
    });

    it('is found by the words people actually type, not only by "extract"', () => {
        for (const q of ['extract', 'invoice', 'pdf', 'read', 'fields', 'e-mail']) {
            const hits = buildSearchResults(q, { catalog });
            expect(hits.some(r => r.payload?.kind === 'data_extraction'), `"${q}" should find Extract data`).toBe(true);
        }
        const exact = buildSearchResults('extract data', { catalog });
        expect(exact[0]?.payload?.kind).toBe('data_extraction');
    });

    it('recorded usage resolves back to an addable item', () => {
        const hit = itemForKey('step:data_extraction', { catalog });
        expect(hit?.payload?.kind).toBe('data_extraction');
        expect(hit.label).toBe('Extract data');
    });

    it('the ribbon flight departs from the AI command, like the AI step', () => {
        expect(sectionKeyForKind('data_extraction')).toBe('ai');
        expect(originKeysFor({ type: 'data_extraction' })).toEqual(['section:ai', 'tabs', 'ribbon']);
    });
});
