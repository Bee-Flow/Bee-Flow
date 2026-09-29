/**
 * The citation mapper.
 *
 * ── THE BUG THIS CLOSES ─────────────────────────────────────────────
 * Two of the three streams wrote `data.sources as KbSource[]`. A cast is a
 * promise, not a check, and this one was false: the card reads `snippet` and
 * the server has never sent a `snippet` — it sends `content`. So every source
 * card in chat and agents showed a title with nothing under it, while the text
 * sat in the payload under a key nothing read. Only the notebook stream mapped
 * properly, and it looked better for no reason anyone could point at.
 *
 * ── AND WHAT IT MUST NOT BREAK ──────────────────────────────────────
 * A phone talks to whichever server it is pointed at, including one that
 * predates every field added since. So an old payload has to map to exactly
 * what it always mapped to, and a new one has to keep the parts this app does
 * not render yet rather than dropping them.
 */

import { toKbSource, toKbSources } from './kbSources';

/** A citation as `server/core/kb/citation.js` builds one today. */
const CITATION = {
    title: 'Personeelshandboek',
    kind: 'kb_chunk',
    sourceId: 'src-1',
    sourceName: 'Nextcloud · /HR',
    documentId: 'doc-1',
    chunkId: 3,
    page: 12,
    rowStart: null,
    rowEnd: null,
    occurredAt: null,
    section: '4.2 Bijzonder verlof',
    content: 'Bij een huwelijk krijg je twee dagen vrij.',
    score: 0.91,
    preview: 'Bij een huwelijk krijg je twee dagen vrij.',
};

describe('toKbSource', () => {
    it('finds the passage under the name the server actually uses', () => {
        expect(toKbSource(CITATION, 0).snippet).toBe('Bij een huwelijk krijg je twee dagen vrij.');
    });

    it('still reads the older `preview` alias when that is all there is', () => {
        const { content: _content, ...withoutContent } = CITATION;
        expect(toKbSource(withoutContent, 0).snippet).toBe('Bij een huwelijk krijg je twee dagen vrij.');
    });

    it('carries the position of the passage, not just its name', () => {
        const s = toKbSource(CITATION, 0);
        expect(s.page).toBe(12);
        expect(s.section).toBe('4.2 Bijzonder verlof');
        expect(s.kind).toBe('kb_chunk');
        expect(s.documentId).toBe('doc-1');
        expect(s.chunkId).toBe('3');
    });

    it('carries the fields this app does not render yet', () => {
        // Dropping them would mean a second round of this same bug the day a
        // card learns to show them.
        const s = toKbSource({ ...CITATION, rowStart: 1, rowEnd: 50, occurredAt: '2026-07-22T09:00:00.000Z' }, 0);
        expect(s.rowStart).toBe(1);
        expect(s.rowEnd).toBe(50);
        expect(s.occurredAt).toBe('2026-07-22T09:00:00.000Z');
    });

    it('maps an OLD payload to exactly what it always mapped to', () => {
        // A server from before any of the new fields existed. The card shows a
        // title and a passage, and nothing appears or disappears.
        const s = toKbSource({ title: 'Notes', content: 'text', score: 0.4 }, 0);
        expect(s).toEqual({
            id: '0',
            title: 'Notes',
            url: undefined,
            snippet: 'text',
            score: 0.4,
            kind: undefined,
            section: undefined,
            page: undefined,
            rowStart: undefined,
            rowEnd: undefined,
            occurredAt: undefined,
            documentId: undefined,
            chunkId: undefined,
        });
    });

    it('never invents a position out of a value that is not one', () => {
        // `page: 0` says the chunker guessed, and a chip that prints it is
        // worse than one that says less.
        for (const bad of [0, -1, 1.5, '12', null, undefined, NaN, {}]) {
            const s = toKbSource({ page: bad, rowStart: bad, rowEnd: bad }, 0);
            expect([s.page, s.rowStart, s.rowEnd]).toEqual([undefined, undefined, undefined]);
        }
    });

    it('treats a blank string as nothing at all', () => {
        const s = toKbSource({ title: '   ', content: '', occurredAt: '' }, 0);
        expect([s.title, s.snippet, s.occurredAt]).toEqual([undefined, undefined, undefined]);
    });

    it('always has an id, so two cards can never collide', () => {
        expect(toKbSource({ id: 'a' }, 4).id).toBe('a');
        expect(toKbSource({ chunkId: 7 }, 4).id).toBe('7');
        expect(toKbSource({}, 4).id).toBe('4');
    });

    it('survives a payload that is not an object at all', () => {
        for (const junk of [null, undefined, 'sources', 42, []]) {
            expect(() => toKbSource(junk, 0)).not.toThrow();
        }
    });
});

describe('toKbSources', () => {
    it('keeps the order the server ranked them in', () => {
        const out = toKbSources([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
        expect(out.map((s) => s.title)).toEqual(['a', 'b', 'c']);
        expect(out.map((s) => s.id)).toEqual(['0', '1', '2']);
    });

    it('anything that is not a list is no sources', () => {
        for (const junk of [null, undefined, {}, 'sources', 0]) {
            expect(toKbSources(junk)).toEqual([]);
        }
    });
});
