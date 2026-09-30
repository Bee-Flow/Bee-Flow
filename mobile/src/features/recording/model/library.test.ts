import {
    DEFAULT_FILTER,
    filterMeetings,
    isFiltering,
    REPORT_MAX_NOTES,
    toggleSelected,
    visibleTags,
} from './library';
import type { TranscriptionSummary } from './types';

const row = (patch: Partial<TranscriptionSummary>): TranscriptionSummary => ({
    id: 'x',
    title: '',
    fileName: null,
    language: null,
    durationSeconds: null,
    speakerCount: null,
    segmentCount: null,
    status: 'completed',
    provider: '',
    source: 'upload',
    isPublished: false,
    sharedGroups: [],
    organizationId: null,
    createdAt: null,
    updatedAt: null,
    isOwner: true,
    ownerId: 'me',
    ...patch,
});

const MEETINGS = [
    row({ id: 'a', title: 'Board', createdAt: '2026-09-01T10:00:00Z', durationSeconds: 60, tags: ['sales'] }),
    row({ id: 'b', title: 'Alpha', createdAt: '2026-09-03T10:00:00Z', durationSeconds: 600, transcriptSnippet: 'budget talk' }),
    row({ id: 'c', title: 'Zulu', createdAt: '2026-09-02T10:00:00Z', ownerId: 'colleague', isOwner: false }),
];

const ids = (rows: TranscriptionSummary[]) => rows.map((r) => r.id);

describe('filterMeetings', () => {
    it('sorts as the web does', () => {
        expect(ids(filterMeetings(MEETINGS, DEFAULT_FILTER, 'me'))).toEqual(['b', 'c', 'a']);
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, sort: 'oldest' }, 'me'))).toEqual(['a', 'c', 'b']);
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, sort: 'longest' }, 'me'))).toEqual(['b', 'a', 'c']);
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, sort: 'title' }, 'me'))).toEqual(['b', 'a', 'c']);
    });

    it('searches title, tags and the transcript snippet', () => {
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, query: 'SALES' }, 'me'))).toEqual(['a']);
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, query: ' budget ' }, 'me'))).toEqual(['b']);
    });

    it('splits mine from shared, and filters by tag', () => {
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, owner: 'mine' }, 'me'))).toEqual(['b', 'a']);
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, owner: 'shared' }, 'me'))).toEqual(['c']);
        expect(ids(filterMeetings(MEETINGS, { ...DEFAULT_FILTER, tag: 'sales' }, 'me'))).toEqual(['a']);
    });

    it('knows when a filter is narrowing', () => {
        expect(isFiltering(DEFAULT_FILTER)).toBe(false);
        expect(isFiltering({ ...DEFAULT_FILTER, sort: 'title' })).toBe(false);
        expect(isFiltering({ ...DEFAULT_FILTER, tag: 'x' })).toBe(true);
    });
});

describe('visibleTags', () => {
    const TAGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((tag, i) => ({ tag, count: 10 - i }));

    it('folds past five, by count', () => {
        const out = visibleTags(TAGS, null, false);
        expect(out.shown.map((r) => r.tag)).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(out.hidden).toBe(2);
        expect(visibleTags(TAGS, null, true).hidden).toBe(0);
    });

    it('pins the active tag so it can be switched off', () => {
        const out = visibleTags(TAGS, 'g', false);
        expect(out.shown.map((r) => r.tag)).toEqual(['a', 'b', 'c', 'd', 'g']);
    });
});

describe('the report selection', () => {
    it('toggles finished notes only, up to the server cap', () => {
        const done = row({ id: 'd' });
        expect(toggleSelected([], done)).toEqual(['d']);
        expect(toggleSelected(['d'], done)).toEqual([]);
        expect(toggleSelected([], row({ id: 'p', status: 'processing' }))).toEqual([]);
        const full = Array.from({ length: REPORT_MAX_NOTES }, (_, i) => `n${i}`);
        expect(toggleSelected(full, done)).toHaveLength(REPORT_MAX_NOTES);
    });
});
