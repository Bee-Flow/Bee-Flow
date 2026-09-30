/** The tally on "How I got this answer", its steps, and its sources grouped by document. */

import type { TranslateFn } from '@/core/i18n';

import { passagePlace, sourcesHeading, traceDocuments, traceSteps, traceSummary } from './answerTrace';
import type { ChatMessage, KbSource } from './types';

const t: TranslateFn = (_key, en, params) =>
    Object.entries(params ?? {}).reduce((out, [name, value]) => out.split(`{${name}}`).join(String(value)), en);

const answer = (extra: Partial<ChatMessage>): ChatMessage => ({ id: 'a', role: 'assistant', content: 'x', ...extra });

describe('traceSummary', () => {
    it('counts tools with their time, documents, the tier Auto picked and what the shield replaced', () => {
        const message = answer({
            tools: [
                { id: '1', name: 'web_search', status: 'done', startTime: 1000, endTime: 2500 },
                { id: '2', name: 'sequentialthinking', status: 'done' },
            ],
            sources: [{ title: 'Handbook' }, { title: 'Policy' }],
            autoSelectedTier: 'fast',
            tokenisation: { count: 2, categories: [], action: 'restore' },
        });
        expect(traceSummary(message, { showSources: true, t })).toEqual(['1 tool · 1.5s', '2 documents', 'Auto → Fast', '🔒 2 restored']);
    });

    it('counts documents, not passages: several passages of one document are one (BFSF-352)', () => {
        const notes = { title: 'Standup', documentId: 'd1' };
        const message = answer({ sources: [notes, { title: 'Handbook', documentId: 'd2' }, notes, notes] });
        expect(traceSummary(message, { showSources: true, t })).toEqual(['2 documents']);
        expect(traceSummary(answer({ sources: [notes, notes, notes] }), { showSources: true, t })).toEqual(['1 document']);
    });

    it('leaves the sources out where they may not be shown, and names a plain tier', () => {
        const message = answer({ sources: [{ title: 'Handbook' }], modelTier: 'writer' });
        expect(traceSummary(message, { showSources: false, t })).toEqual(['Write']);
    });

    it('says nothing it has no number for', () => {
        expect(traceSummary(answer({}), { showSources: true, t })).toEqual([]);
    });
});

describe('traceSteps', () => {
    it('names each step and its measured duration', () => {
        const steps = traceSteps(
            [
                { stage: 'kb_search', detail: null, startedAt: 0, endedAt: 840, durationMs: 840 },
                { stage: 'streaming_start', detail: null, startedAt: 840, endedAt: null, durationMs: null },
            ],
            t,
        );
        expect(steps.map(({ label, duration }) => [label, duration])).toEqual([
            ['Searching knowledge base…', '840ms'],
            ['Thinking…', null],
        ]);
    });
});

describe('the sources, grouped by document', () => {
    const SOURCES: KbSource[] = [
        { title: 'Standup', documentId: 'd1', section: 'Decisions', page: 2, snippet: 'We ship on Friday.' },
        { title: 'Handbook', documentId: 'd2', page: 12, snippet: 'One month notice.' },
        { title: 'Standup', documentId: 'd1', snippet: 'Tessa owns the release.' },
        { snippet: 'A passage without a title.' },
    ];

    it('heads them with the passages and the documents they came from', () => {
        expect(sourcesHeading(SOURCES, t)).toBe('4 sources from 3 documents');
        expect(sourcesHeading(SOURCES.slice(0, 1), t)).toBe('1 source from 1 document');
        expect(sourcesHeading([SOURCES[0] as KbSource, SOURCES[2] as KbSource], t)).toBe('2 sources from 1 document');
    });

    it('names each document after its first passage, and folds its passages under it', () => {
        const docs = traceDocuments(SOURCES, t);
        expect(docs.map((d) => [d.head.title, d.head.passageCount ?? null, d.passages.map((p) => p.snippet)])).toEqual([
            ['Standup', 2, ['We ship on Friday.', 'Tessa owns the release.']],
            ['Handbook', null, ['One month notice.']],
            ['Unknown Source', null, ['A passage without a title.']],
        ]);
        // The head is a copy: the passage itself keeps its own (missing) title.
        expect(SOURCES[3]?.title).toBeUndefined();
    });

    it('places a passage by its heading and page, or by its position without a heading', () => {
        expect(passagePlace(SOURCES[0] as KbSource, 0, t)).toBe('Decisions · p. 2');
        expect(passagePlace(SOURCES[2] as KbSource, 1, t)).toBe('Chunk 2');
        expect(passagePlace({ section: '  ', page: 0 }, 2, t)).toBe('Chunk 3');
    });
});
