/**
 * The meeting-notes readers are new, so these pin what a slightly wrong
 * payload becomes — and the one deliberate exception: action items pass
 * through whole, because the phone PATCHes them back.
 */

import {
    readAccepted,
    readExportBody,
    readRegenerateResult,
    readReport,
    readTagCounts,
    readTranscription,
    readTranscriptionList,
} from './readers';

describe('readTranscriptionList', () => {
    it('reads the rows under `transcriptions`, with the server’s own defaults', () => {
        const [row] = readTranscriptionList({
            transcriptions: [{ id: 't1', title: 'Standup', durationSeconds: '120', transcriptSnippet: 'Hi' }],
        });
        expect(row).toMatchObject({
            id: 't1',
            title: 'Standup',
            durationSeconds: 120,
            status: 'completed',
            source: 'upload',
            isOwner: false,
            sharedGroups: [],
            transcriptSnippet: 'Hi',
        });
        expect(row?.summarySnippet).toBeUndefined();
    });

    it('answers an empty list for anything that is not one', () => {
        expect(readTranscriptionList(null)).toEqual([]);
        expect(readTranscriptionList({ transcriptions: 'nope' })).toEqual([]);
    });
});

describe('readTranscription', () => {
    it('gives a note written before the late fields existed empty lists, not undefined', () => {
        const note = readTranscription({ id: 't1', status: 'processing' });
        expect(note).toMatchObject({
            status: 'processing',
            summary: '',
            segments: [],
            speakers: [],
            actionItems: [],
            decisions: [],
            questions: [],
            chapters: [],
            tags: [],
            attendees: [],
            numSpeakers: null,
            perPersonInsights: false,
        });
        expect(note?.audio).toEqual({
            available: false,
            durable: false,
            localOnly: false,
            storageConfigured: false,
            recoverable: false,
            capture: null,
        });
    });

    it('keeps every field of an action item, including ones it has no name for', () => {
        const item = {
            id: 'ai-1',
            text: 'Send the offer',
            source: 'user',
            destination: { kind: 'kb', ref: 'kb1' },
            futureField: 42,
        };
        expect(readTranscription({ id: 't1', actionItems: [item, 'junk'] })?.actionItems).toEqual([
            item,
            { text: '' },
        ]);
    });

    it('reads segments, speakers and chapters through their own shapes', () => {
        const note = readTranscription({
            id: 't1',
            segments: [{ speaker: 'Tom', start: 1.5, end: 3, text: 'Hello', gap: true }],
            speakers: [{ id: 'Tom', speakingTime: '01:05', source: 'manual' }],
            chapters: [{ title: 'Intro', start: '00:00' }],
            questions: [{ text: 'Budget?', open: false }],
        });
        expect(note?.segments[0]).toMatchObject({ speaker: 'Tom', start: 1.5, text: 'Hello', gap: true });
        expect(note?.speakers[0]).toMatchObject({ id: 'Tom', speakingTime: '01:05', source: 'manual' });
        expect(note?.chapters[0]).toMatchObject({ title: 'Intro', start: '00:00' });
        expect(note?.questions[0]?.open).toBe(false);
    });

    it('answers null when there is no note at all', () => {
        expect(readTranscription(null)).toBeNull();
        expect(readTranscription('Not found')).toBeNull();
    });
});

describe('the smaller answers', () => {
    it('keeps artifactsRegenerated absent unless the server said it', () => {
        expect(readRegenerateResult({ summary: 'New' })?.artifactsRegenerated).toBeUndefined();
        expect(readRegenerateResult({ summary: 'New', artifactsRegenerated: false })?.artifactsRegenerated).toBe(false);
        expect(readRegenerateResult(null)).toBeNull();
    });

    it('reads the 202 and leaves an id-less one for the caller to refuse', () => {
        expect(readAccepted({ id: 'n1', status: 'processing', title: 'Standup' })).toMatchObject({ id: 'n1' });
        expect(readAccepted({ ok: true })?.id).toBe('');
        expect(readAccepted(null)).toBeNull();
    });

    it('treats a non-text export as nothing to share', () => {
        expect(readExportBody('# Notes')).toBe('# Notes');
        expect(readExportBody({ error: 'x' })).toBe('');
    });
});

describe('the library answers', () => {
    it('reads the tag counts and drops blank tags', () => {
        expect(readTagCounts([{ tag: 'sales', count: '4' }, { tag: '', count: 1 }, 'junk'])).toEqual([
            { tag: 'sales', count: 4 },
        ]);
        expect(readTagCounts({ error: 'x' })).toEqual([]);
    });

    it('reads a report, and says "summaries" only when the server did', () => {
        expect(readReport({ report: '# R', truncatedNotes: 2 })).toEqual({
            report: '# R',
            usedTranscripts: true,
            truncatedNotes: 2,
        });
        expect(readReport({ report: '# R', usedTranscripts: false })?.usedTranscripts).toBe(false);
        expect(readReport(null)).toBeNull();
    });
});
