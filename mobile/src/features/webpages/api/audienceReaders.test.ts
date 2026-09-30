/**
 * The readers where a wrong default is a claim about exposure: an unreadable
 * public state, an uncountable set of links, a connection nobody checked.
 */

import { readAudience, readDataCards, readGrants, readPageCalls } from './audienceReaders';

describe('readAudience', () => {
    it('keeps "could not read" apart from "off" and "none"', () => {
        const audience = readAudience({ public: { on: false, known: false }, shareCountKnown: false, shareCount: 0 });
        expect(audience.public.known).toBe(false);
        expect(audience.shareCount).toBeNull();
        expect(audience.address).toBeNull();
    });

    it('defaults to private, read, and derives the gate counts itself', () => {
        const audience = readAudience({
            address: { slug: 'x' },
            columnGate: { tables: [{ datatableId: 't1', columns: ['a'], publicColumns: [] }, { columns: ['b'] }] },
        });
        expect(audience.internal.mode).toBe('personal');
        expect(audience.public).toMatchObject({ on: false, known: true, accessMode: 'unlisted' });
        expect(audience.address).toEqual({ slug: 'x', path: '/w/x', url: null });
        expect(audience.columnGate).toMatchObject({ anyBound: true, sharingCount: 0 });
        expect(audience.columnGate.tables).toHaveLength(1);
    });
});

describe('readGrants', () => {
    it('reads a connection status as true, false or unknown', () => {
        const grants = readGrants({
            integrations: [
                { tool: 'a', available: true },
                { tool: 'b', available: false },
                { tool: 'c' },
                { label: 'no tool' },
            ],
            automations: [{ automationId: 'x', label: 'Digest' }],
            discoveryFailed: true,
        });
        expect(grants.integrations.map((g) => g.available)).toEqual([true, false, null]);
        expect(grants.automations).toEqual([{ automationId: 'x', label: 'Digest' }]);
        expect(grants.discoveryFailed).toBe(true);
    });
});

describe('readDataCards and readPageCalls', () => {
    it('keeps "code unreadable" (null) apart from "not used" (false)', () => {
        const cards = readDataCards({
            tables: [
                { datatableId: 't1', usedInCode: null, mode: 'readwrite' },
                { datatableId: 't2', usedInCode: false },
            ],
            automations: [{ automationId: 'a1', writes: true }],
        });
        expect(cards.tables.map((t) => t.usedInCode)).toEqual([null, false]);
        expect(cards.tables[0]?.mode).toBe('readwrite');
        expect(cards.automations[0]?.writes).toBe(true);
    });

    it('reads an unscanned page as unscanned, not as "no calls"', () => {
        expect(readPageCalls({ code: { scanned: false, calls: [] } }).scanned).toBe(false);
        expect(readPageCalls(null)).toEqual({ scanned: false, calls: [] });
    });
});
