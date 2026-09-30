/**
 * DIFFERENTIAL lockstep: the grouping by document (BFSF-352) against the
 * web's citationGroups.ts, on the same stored passages read through the
 * phone's own reader.
 *
 * The chip row is pinned through answerChips.lockstep.test.ts, but it groups
 * only what it shows as a chip. The sources in "How I got this answer" and the
 * document count on that line group every passage, as the web's
 * KbSourcesPanel and HowIGotThisAnswer do, so the grouping is pinned here on
 * its own.
 */

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { documentCountOf, groupByDocument, type CitationGroup } from './citationGroups';
import type { KbSource } from './types';
import { readMessage } from '../api/messageReader';

interface WebGroup {
    key: string;
    best: unknown;
    passages: unknown[];
}

// TypeScript without imports: required through Jest's Babel, as
// answerChips.lockstep.test.ts does.
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const web = require(`${AGENT_HUB_SRC}/components/chat/MessageItem/citationGroups.ts`) as {
    groupByDocument: (sources: unknown[]) => WebGroup[];
    documentCountOf: (sources: unknown[]) => number;
};

const passage = (i: number, extra: Record<string, unknown> = {}) => ({ title: `Doc ${i}`, content: `passage ${i}`, ...extra });

const CASES: Record<string, Record<string, unknown>[]> = {
    'one passage per document': [passage(1), passage(2, { page: 3 })],
    'passages of one document, by documentId or by document_id': [
        passage(1, { documentId: 'd1', score: 0.2 }),
        passage(2, { documentId: 'd1', score: 0.9 }),
        { title: 'Doc 3', preview: 'only a preview', documentId: 'd1', score: 1 },
        passage(4, { document_id: 7 }),
        passage(5, { documentId: '7' }),
        passage(6, { document_id: 7, score: 0.4 }),
    ],
    'meetings that share a title, told apart by their day': [
        passage(1, { title: 'Standup', occurredAt: '2026-07-22T09:00:00.000Z' }),
        passage(2, { title: 'Standup', occurredAt: '2026-07-23T09:00:00.000Z' }),
        passage(3, { title: 'Standup', occurredAt: '2026-07-22T09:00:00.000Z' }),
        passage(4, { title: 'Standup' }),
        passage(5, { title: ' Standup ' }),
    ],
    'table rows are their own sources': [
        passage(1, { title: 'Widget A', datatableId: 'dt', rowId: 1 }),
        passage(2, { title: 'Widget A', datatableId: 'dt', rowId: 2 }),
        passage(3, { title: 'Widget A', datatableId: 'dt', rowId: '1' }),
        passage(4, { title: 'Widget A', datatableId: 5, rowId: 1 }),
        passage(5, { title: 'Widget A', rowId: 1 }),
    ],
    'untitled passages share one unknown group': [{ content: 'a' }, { preview: 'b' }, { title: '   ', content: 'c', score: 0.5 }, passage(4)],
    'a passage that can be opened beats a better-scored one that cannot, and a tie keeps the first': [
        { title: 'Notes', documentId: 'n', preview: 'p', score: 0.9 },
        { title: 'Notes', documentId: 'n', content: 'first', score: 0.3 },
        { title: 'Notes', documentId: 'n', content: 'second', score: 0.3 },
        { title: 'Notes', documentId: 'n', content: '  ', score: 1 },
    ],
};

/** Each group by its key and the positions of its passages and of its best one, so both sides compare by what they picked. */
function shape<T>(list: readonly T[], groups: readonly { key: string; best: T; passages: readonly T[] }[]) {
    return groups.map((g) => ({ key: g.key, best: list.indexOf(g.best), passages: g.passages.map((p) => list.indexOf(p)) }));
}

function phoneSources(raw: Record<string, unknown>[]): KbSource[] {
    return readMessage({ role: 'assistant', content: 'x', kbSources: raw }).sources ?? [];
}

describe('groupByDocument matches the web', () => {
    it.each(Object.entries(CASES))('%s', (_name, raw) => {
        const mine = phoneSources(raw);
        expect(mine).toHaveLength(raw.length);
        const groups: CitationGroup<KbSource>[] = groupByDocument(mine);
        expect(shape(mine, groups)).toEqual(shape(raw, web.groupByDocument(raw)));
        expect(documentCountOf(mine)).toBe(web.documentCountOf(raw));
    });

    it('has cases that group at all, and pick a best other than the first', () => {
        // Without this the two could agree by never grouping.
        const counts = Object.values(CASES).map((raw) => [raw.length, documentCountOf(phoneSources(raw))]);
        expect(counts).toEqual([
            [2, 2],
            [6, 2],
            [5, 3],
            [5, 4],
            [4, 2],
            [4, 1],
        ]);
        const [notes] = groupByDocument(phoneSources(CASES['a passage that can be opened beats a better-scored one that cannot, and a tie keeps the first'] ?? []));
        expect(notes?.best.snippet).toBe('first');
    });
});
