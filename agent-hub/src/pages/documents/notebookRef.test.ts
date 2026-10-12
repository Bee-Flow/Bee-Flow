import { describe, expect, it } from 'vitest';
import { documentRefOf, notebookIdOf, notebookRef } from './notebookRef';

describe('notebookRef', () => {
    it('round-trips a notebook id through the open-item reference', () => {
        expect(notebookRef('nb1')).toBe('notebook/nb1');
        expect(notebookIdOf('notebook/nb1')).toBe('nb1');
    });

    it('a document id, an empty reference or a bare prefix names no notebook', () => {
        expect(notebookIdOf('d1')).toBeNull();
        expect(notebookIdOf(null)).toBeNull();
        expect(notebookIdOf('notebook/')).toBeNull();
    });

    it('turns a parsed Studio route into what Documents opens', () => {
        expect(documentRefOf({ id: 'notebook', sub: 'nb1' })).toBe('notebook/nb1');
        expect(documentRefOf({ id: 'notebook', sub: null })).toBeNull();
        expect(documentRefOf({ id: 'd1', sub: null })).toBe('d1');
        expect(documentRefOf({ id: null })).toBeNull();
    });
});
