import { describe, expect, it } from 'vitest';
import { kbDocumentCount, uploadDocCountOf, uploadKbIdOf } from './uploadKb';

describe('uploadKbIdOf', () => {
    it('prefers the base created with the agent over the first linked one', () => {
        expect(uploadKbIdOf({ config: { wizard: { primaryKbId: 'kb-primary' } } }, ['kb-a', 'kb-b'])).toBe('kb-primary');
    });

    it('falls back to the first linked base, and to null when there is none', () => {
        expect(uploadKbIdOf({ config: {} }, ['kb-a', 'kb-b'])).toBe('kb-a');
        expect(uploadKbIdOf(null, [])).toBeNull();
        expect(uploadKbIdOf(undefined, undefined)).toBeNull();
    });
});

describe('kbDocumentCount', () => {
    it('counts every row, like the dialog, not only the processed ones', () => {
        expect(kbDocumentCount({ id: 'kb', documentCount: 1, documentCountAll: 3 })).toBe(3);
    });

    it('falls back to the active count, and to undefined when neither is known', () => {
        expect(kbDocumentCount({ id: 'kb', documentCount: 2 })).toBe(2);
        expect(kbDocumentCount({ id: 'kb' })).toBeUndefined();
        expect(kbDocumentCount(undefined)).toBeUndefined();
    });
});

describe('uploadDocCountOf', () => {
    const kbs = [
        { id: 'kb-a', documentCount: 2, documentCountAll: 2 },
        { id: 'kb-b', documentCount: 7, documentCountAll: 7 },
    ];

    it('is the document count of the upload base, not the number of linked bases', () => {
        // One upload base holding two files: the pill used to read "1".
        expect(uploadDocCountOf({ uploadKbId: 'kb-a', kbs, kbsReadable: true })).toBe(2);
    });

    it('lets a total reported by the dialog win over the list', () => {
        const reported = { kbId: 'kb-a', total: 5 };
        expect(uploadDocCountOf({ uploadKbId: 'kb-a', kbs, kbsReadable: true, reported })).toBe(5);
        // …and over an unreadable list, since it comes from its own read.
        expect(uploadDocCountOf({ uploadKbId: 'kb-a', kbs: [], kbsReadable: false, reported })).toBe(5);
    });

    it('ignores a total reported for another base', () => {
        const reported = { kbId: 'kb-b', total: 9 };
        expect(uploadDocCountOf({ uploadKbId: 'kb-a', kbs, kbsReadable: true, reported })).toBe(2);
    });

    it('shows no number when it cannot know one', () => {
        // A linked base the picker list does not include.
        expect(uploadDocCountOf({ uploadKbId: 'kb-elsewhere', kbs, kbsReadable: true })).toBeUndefined();
        // A list that is still loading or failed to load.
        expect(uploadDocCountOf({ uploadKbId: 'kb-a', kbs, kbsReadable: false })).toBeUndefined();
        // No upload base at all.
        expect(uploadDocCountOf({ uploadKbId: null, kbs, kbsReadable: true })).toBeUndefined();
    });
});
