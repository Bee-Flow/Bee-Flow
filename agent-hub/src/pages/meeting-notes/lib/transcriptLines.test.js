// @vitest-environment node
/**
 * What a transcript line produces (plan M4, artboard 1b).
 *
 * TWO THINGS ARE LOAD-BEARING HERE and everything else is shape:
 *
 *  1. `source: 'user'` on every artifact a person makes from a line. Leaving
 *     it off breaks nothing visible — until the next "Opnieuw", which rewrites
 *     the artifact lists from the extractor and would take the sentence with
 *     it. There is no undo behind that button.
 *  2. The allow-list. A segment carries whatever the transcription pipeline
 *     put on it, and a spread would ship all of it into a knowledge base, a
 *     table row and a note other people in the org can read.
 */
import { describe, expect, it } from 'vitest';

import {
    anchorOf,
    appendArtifact,
    buildLineActionItem,
    buildLineDecision,
    buildLineKbSource,
    buildLineMarks,
    lineAsActionRecord,
    lineQuote,
} from './transcriptLines';

const segment = {
    start: 754.2,
    end: 761.0,
    speaker: 'Sandra',
    text: 'We gaan met leverancier B verder.',
    // What the pipeline puts on a segment that has no business travelling.
    confidence: 0.82,
    words: [{ w: 'We', s: 754.2 }],
    raw_speaker_id: 'SPEAKER_01',
};

const meeting = { id: 't-1', title: 'Leveranciersoverleg', createdAt: '2026-09-07T09:00:00.000Z' };

describe('transcriptLines — what a person makes from a line', () => {
    it('marks an action from a line as the person\'s, anchored to that line', () => {
        const item = buildLineActionItem(segment, 12);
        // THE BITE. Without `source: 'user'` this item is indistinguishable
        // from something the extractor produced, and the next regenerate
        // deletes it (server/core/meetingNotes/actionItems.js).
        expect(item.source).toBe('user');
        expect(item.segmentIndex).toBe(12);
        expect(item.text).toBe('We gaan met leverancier B verder.');
        expect(item.timestamp).toBe('12:34');
        expect(item.done).toBe(false);
    });

    it('marks a decision from a line the same way', () => {
        const decision = buildLineDecision(segment, 12);
        expect(decision.source).toBe('user');
        expect(decision.segmentIndex).toBe(12);
        expect(decision.timestamp).toBe('12:34');
    });

    it('carries NOTHING off the segment but the named fields', () => {
        // A spread would put confidence, word timings and the diarizer's raw
        // speaker id into a column other people in the org read.
        expect(Object.keys(buildLineActionItem(segment, 3)).sort())
            .toEqual(['done', 'segmentIndex', 'source', 'text', 'timestamp']);
        expect(Object.keys(buildLineDecision(segment, 3)).sort())
            .toEqual(['segmentIndex', 'source', 'text', 'timestamp']);
    });

    it('leaves the assignee empty — the speaker is not automatically the owner', () => {
        expect('assignee' in buildLineActionItem(segment, 0)).toBe(false);
    });

    it('makes nothing at all out of a line with no text, or no line number', () => {
        expect(buildLineActionItem({ start: 1, text: '   ' }, 3)).toBeNull();
        expect(buildLineDecision({ start: 1, text: '' }, 3)).toBeNull();
        expect(buildLineActionItem(segment, -1)).toBeNull();
        expect(buildLineActionItem(segment, 1.5)).toBeNull();
        expect(buildLineActionItem(segment, null)).toBeNull();
    });
});

describe('transcriptLines — which line an artifact points at', () => {
    it('accepts the first line, and only real line numbers', () => {
        expect(anchorOf({ segmentIndex: 0 })).toBe(0);
        expect(anchorOf({ segmentIndex: '12' })).toBe(12);
        for (const bad of [undefined, null, true, false, -1, 1.5, 'twaalf', {}, []]) {
            expect(anchorOf({ segmentIndex: bad })).toBeNull();
        }
    });

    it('indexes actions, decisions and questions onto their lines', () => {
        const marks = buildLineMarks({
            actionItems: [
                { id: 'u-1', text: 'Bel de klant', segmentIndex: 12 },
                { id: 'ai-0', text: 'Zonder anker' },
            ],
            decisions: [{ id: 'ud-1', text: 'Leverancier B', segmentIndex: 12 }],
            questions: [{ id: 'uq-1', text: 'Wie betaalt?', segmentIndex: 40, open: false }],
        });
        expect(marks.get(12).map((m) => m.kind)).toEqual(['action', 'decision']);
        expect(marks.get(40)[0]).toEqual({ kind: 'question', id: 'uq-1', text: 'Wie betaalt?', open: false });
        expect(marks.has(0)).toBe(false);
    });

    it('never chips line 0 for the items that predate anchors', () => {
        // Every artifact written before M4 has no segmentIndex at all. Reading
        // that as line 0 would decorate the first sentence of every older
        // meeting with marks nobody put there.
        const marks = buildLineMarks({
            actionItems: [{ id: 'ai-0', text: 'Oud punt' }, { id: 'ai-1', text: 'Ook oud', segmentIndex: null }],
            decisions: [{ id: 'd-0', text: 'Oud besluit', segmentIndex: false }],
        });
        expect(marks.size).toBe(0);
    });

    it('survives a meeting whose lists are missing or junk', () => {
        expect(buildLineMarks(null).size).toBe(0);
        expect(buildLineMarks({ actionItems: 'nope', decisions: null }).size).toBe(0);
    });
});

describe('transcriptLines — the quote and the knowledge source', () => {
    it('quotes the line with who said it and when', () => {
        expect(lineQuote(segment, { speakerLabel: 'Sandra' }))
            .toBe('[12:34] Sandra: We gaan met leverancier B verder.');
    });

    it('falls back to the segment\'s own speaker, and answers \'\' for an empty line', () => {
        expect(lineQuote({ start: 0, speaker: 'speaker_2', text: 'Ja.' })).toBe('[0:00] Speaker 2: Ja.');
        expect(lineQuote({ start: 5, text: '  ' })).toBe('');
    });

    it('files a knowledge source that says which transcript line it is', () => {
        const source = buildLineKbSource(segment, 12, meeting, {
            speakerLabel: 'Sandra',
            labels: { speaker: 'Speaker', timestamp: 'Timestamp', meeting_title: 'Meeting' },
        });
        expect(source.kind).toBe('text');
        expect(source.config.metadata).toEqual({ transcriptionId: 't-1', segmentIndex: 12 });
        expect(source.config.text).toBe([
            'We gaan met leverancier B verder.',
            'Speaker: Sandra',
            'Timestamp: 12:34',
            'Meeting: Leveranciersoverleg',
        ].join('\n'));
    });

    it('files no origin at all when there is no usable pair', () => {
        // Half an origin would make "this line is already filed" true for
        // every line of the meeting.
        expect(buildLineKbSource(segment, 12, { title: 'Geen id' }).config.metadata).toBeUndefined();
        expect(buildLineKbSource(segment, null, meeting).config.metadata).toBeUndefined();
    });

    it('refuses a line the server would 400 on', () => {
        expect(buildLineKbSource({ start: 1, text: 'ok' }, 0, meeting)).toBeNull();
    });
});

describe('transcriptLines — the table row and the append', () => {
    it('hands the row builder an action-shaped record, nothing more', () => {
        expect(lineAsActionRecord(segment, { speakerLabel: 'Sandra' }))
            .toEqual({ text: 'We gaan met leverancier B verder.', assignee: 'Sandra', timestamp: '12:34' });
    });

    it('appends onto the FULL list, because the PATCH replaces the column', () => {
        const existing = [{ id: 'ai-0', text: 'Van het model' }];
        const next = appendArtifact(existing, { text: 'Van mij', source: 'user' });
        expect(next).toHaveLength(2);
        expect(next[0]).toBe(existing[0]);
        expect(existing).toHaveLength(1);
    });

    it('answers the list unchanged for a line that produced nothing', () => {
        expect(appendArtifact([{ id: 'a' }], null)).toEqual([{ id: 'a' }]);
        expect(appendArtifact(undefined, null)).toEqual([]);
        expect(appendArtifact('nope', { text: 'x' })).toEqual([{ text: 'x' }]);
    });
});
