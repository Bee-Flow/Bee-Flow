/**
 * DIFFERENTIAL lockstep: the chip row against the web's answerChips.js, on the
 * same persisted messages read through the phone's own reader.
 */

import { AGENT_HUB_SRC, loadWebModule } from '@/shared/testing/webModule';

import { answerChipsFor, citationIsOpenable, MAX_JUDGED_CHIPS, MAX_RECORDED_CHIPS } from './answerChips';
import { readMessage } from '../api/messageReader';

interface WebChips {
    answerChipsFor: (msg: unknown, opts?: unknown) => {
        citations: { title?: string; content?: string; passageCount?: number }[];
        citationsHidden: number;
        rules: { rule: string }[];
        hasRecorded: boolean;
        hasJudged: boolean;
        isEmpty: boolean;
    };
    citationIsOpenable: (s: unknown) => boolean;
    MAX_JUDGED_CHIPS: number;
    MAX_RECORDED_CHIPS: number;
}

// The grouping by document (BFSF-352) is the web's own, handed in: it is
// TypeScript, which loadWebModule cannot evaluate, so it goes through Jest's
// Babel like any other differential require.
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const { groupByDocument } = require(`${AGENT_HUB_SRC}/components/chat/MessageItem/citationGroups.ts`) as { groupByDocument: unknown };
const web = loadWebModule<WebChips>('components/chat/MessageItem/answerChips.js', { groupByDocument });

const source = (i: number, extra: Record<string, unknown> = {}) => ({ title: `Doc ${i}`, content: `passage ${i}`, ...extra });

const MESSAGES: Record<string, Record<string, unknown>> = {
    empty: { role: 'assistant', content: 'x' },
    'a few sources': { role: 'assistant', kbSources: [source(1), source(2, { page: 3 })] },
    'more than fit': { role: 'assistant', kbSources: Array.from({ length: 9 }, (_, i) => source(i)) },
    'a titleless preview-only source': { role: 'assistant', kbSources: [{ preview: 'x…' }, { title: '  ', content: '' }, source(4)] },
    'passages of one document fold into one chip': {
        role: 'assistant',
        kbSources: [
            source(1, { documentId: 'd1', score: 0.2 }),
            source(2, { documentId: 'd1', score: 0.9 }),
            { title: 'Doc 3', preview: 'only a preview', documentId: 'd1', score: 1 },
            source(4, { document_id: 7 }),
            source(5, { document_id: 7 }),
            source(6, { title: 'Standup', occurredAt: '2026-07-22T09:00:00.000Z' }),
            source(7, { title: 'Standup', occurredAt: '2026-07-23T09:00:00.000Z' }),
            source(8, { title: 'Standup', occurredAt: '2026-07-22T09:00:00.000Z' }),
            source(9, { title: 'Widget A', datatableId: 'dt', rowId: 1 }),
            source(10, { title: 'Widget A', datatableId: 'dt', rowId: 2 }),
        ],
    },
    'judged rules, with repeats and junk': {
        role: 'assistant',
        ruleAttribution: { rules: ['Cite', 'Cite', { rule: 'Be brief' }, '', null, ...Array.from({ length: 8 }, (_, i) => `R${i}`)] },
    },
};

/** The phone reads `ruleAttribution` as the list itself; the web holds `{ rules }`. */
function phoneMessage(raw: Record<string, unknown>) {
    const attribution = raw.ruleAttribution as { rules?: unknown[] } | undefined;
    const rules = attribution?.rules?.map((r) => (typeof r === 'string' ? r : (r as { rule?: string } | null)?.rule ?? ''));
    return readMessage({ ...raw, ruleAttribution: rules });
}

describe('answerChipsFor matches the web', () => {
    it('shares the bounds', () => {
        expect([MAX_JUDGED_CHIPS, MAX_RECORDED_CHIPS]).toEqual([web.MAX_JUDGED_CHIPS, web.MAX_RECORDED_CHIPS]);
    });

    const OPTIONS = [{}, { showSources: true }, { showSources: true, showProcess: false }, { showSources: 'yes' }];

    it.each(Object.entries(MESSAGES))('%s', (_name, raw) => {
        for (const opts of OPTIONS) {
            const mine = answerChipsFor(phoneMessage(raw), opts as never);
            const theirs = web.answerChipsFor(raw, opts);
            expect({ opts, titles: mine.citations.map((c) => c.title ?? null) }).toEqual({ opts, titles: theirs.citations.map((c) => c.title ?? null) });
            expect({ opts, folded: mine.citations.map((c) => c.passageCount ?? null) }).toEqual({
                opts,
                folded: theirs.citations.map((c) => c.passageCount ?? null),
            });
            expect({ ...mine, citations: undefined }).toEqual({ ...theirs, citations: undefined, skills: undefined });
        }
    });

    it('has a case that folds at all', () => {
        // Without this the grouping could agree with the web by never grouping.
        const chips = answerChipsFor(phoneMessage(MESSAGES['passages of one document fold into one chip'] ?? {}), { showSources: true });
        expect(chips.citations.map((c) => [c.title, c.passageCount ?? null])).toEqual([
            ['Doc 2', 3],
            ['Doc 4', 2],
            ['Standup', 2],
            ['Standup', null],
            ['Widget A', null],
            ['Widget A', null],
        ]);
    });

    it('opens only a chip whose passage came as `content`', () => {
        for (const raw of [source(1), { title: 'A', preview: 'x' }, { title: 'A', content: '   ' }, {}]) {
            const [mine] = readMessage({ kbSources: [raw] }).sources ?? [];
            expect(citationIsOpenable(mine)).toBe(web.citationIsOpenable(raw));
        }
    });
});
