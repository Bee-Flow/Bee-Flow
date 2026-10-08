/**
 * DIFFERENTIAL lockstep: a citation's label and title against the web's own
 * functions in CitationChips.jsx (loaded out of the JSX file one by one), on
 * the same citations read through the phone's mapper.
 */

import { toKbSource } from '@/shared/stream';
import { AGENT_HUB_SRC, loadWebFunctions } from '@/shared/testing/webModule';

import { chipLabel, chipTitle } from './citationLabel';

// `whenLabel` and `passageCountOf` moved to citationText.ts, which is
// TypeScript: required through Jest's Babel and handed in.
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const text = require(`${AGENT_HUB_SRC}/pages/documents/notebook/citationText.ts`) as { whenLabel: unknown; passageCountOf: unknown };
const web = loadWebFunctions<{
    chipLabel: (s: unknown, i: number, t: unknown) => string;
    chipTitle: (s: unknown, label: string) => string;
}>('pages/documents/notebook/CitationChips.jsx', ['ordinal', 'rowsLabel', 'tableLabel', 'chipParts', 'chipLabel', 'chipTitle'], {
    whenLabel: text.whenLabel,
    passageCountOf: text.passageCountOf,
});

/** Both sides get the same interpolating fallback translator. */
const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));

const CITATIONS: Record<string, unknown>[] = [
    { title: 'Handbook', content: 'x', page: 12 },
    { title: 'Handbook', content: 'x', page: 0 },
    { content: 'x' },
    { title: 'Prices', rowStart: 1, rowEnd: 50, page: 3 },
    { title: 'Prices', rowStart: 7, rowEnd: 7 },
    { title: 'Prices', rowStart: 9, rowEnd: 2 },
    { title: 'Widget A', datatableId: 'dt', rowId: 'r1', sourceName: 'Products', section: 'Products' },
    { title: 'Widget A', sourceName: 'Products' },
    { title: 'Standup', occurredAt: '2026-07-22T09:00:00.000Z', section: 'Decisions' },
    { title: 'Standup', occurredAt: 'not a date' },
    // A chip that folds several passages of one document (BFSF-352).
    { title: 'Handbook', content: 'x', page: 12, passageCount: 3 },
    { title: 'Prices', rowStart: 1, rowEnd: 50, passageCount: 2 },
    { title: 'Widget A', datatableId: 'dt', rowId: 'r1', sourceName: 'Products', passageCount: 2 },
    { title: 'Standup', occurredAt: '2026-07-22T09:00:00.000Z', page: 4, passageCount: 1 },
];

describe('citation labels match the web', () => {
    it.each(CITATIONS.map((c, i) => [i, c] as const))('#%s', (i, raw) => {
        // The grouping sets `passageCount` on the chip, after the mapper.
        const mine = { ...toKbSource(raw, i), passageCount: raw.passageCount as number | undefined };
        const label = chipLabel(mine, i, t as never);
        expect(label).toBe(web.chipLabel(raw, i, t));
        expect(chipTitle(mine, label)).toBe(web.chipTitle(raw, label));
    });
});
