/** A meeting row's words: the state first, then what the meeting was about. */

import { rowFacts, rowSubtitle, statusLabel } from './row';
import type { TranscriptionSummary } from './types';

const ROW: TranscriptionSummary = {
    id: 't1',
    title: 'Standup',
    fileName: null,
    language: 'nl',
    durationSeconds: 125,
    speakerCount: 1,
    segmentCount: 10,
    status: 'completed',
    provider: 'voxtral',
    source: 'recording',
    isPublished: false,
    sharedGroups: [],
    organizationId: null,
    createdAt: null,
    updatedAt: null,
    summarySnippet: '  Agreed   on\nthe plan ',
    isOwner: true,
    ownerId: 'u1',
};

describe('statusLabel', () => {
    it('names each state', () => {
        expect(statusLabel('processing')).toBe('Transcribing');
        expect(statusLabel('failed')).toBe('Failed');
        expect(statusLabel('completed')).toBe('Ready');
    });
});

describe('rowSubtitle', () => {
    it('explains a failure and reassures while processing', () => {
        expect(rowSubtitle({ ...ROW, status: 'failed' })).toMatch(/Open it to retry/);
        expect(rowSubtitle({ ...ROW, status: 'processing' })).toMatch(/few minutes/);
    });

    it('describes a finished note by its summary, then its transcript, flattened', () => {
        expect(rowSubtitle(ROW)).toBe('Agreed on the plan');
        expect(rowSubtitle({ ...ROW, summarySnippet: '', transcriptSnippet: 'Hello  all' })).toBe('Hello all');
        expect(rowSubtitle({ ...ROW, summarySnippet: undefined })).toBeUndefined();
    });
});

describe('rowFacts', () => {
    it('gives the length and the speakers, skipping what is unknown', () => {
        expect(rowFacts(ROW)).toEqual(['2:05', '1 speaker']);
        expect(rowFacts({ ...ROW, speakerCount: 3 })[1]).toBe('3 speakers');
        expect(rowFacts({ ...ROW, durationSeconds: null, speakerCount: null })).toEqual([]);
    });
});
