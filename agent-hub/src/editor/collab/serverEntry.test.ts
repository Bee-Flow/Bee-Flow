/**
 * serverEntry — the API the server bundle (server/core/markdown/editorCollab.cjs)
 * exposes. The server's converter refuses a bundle that misses any of these,
 * so a rename here must be a deliberate change on both sides.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import * as entry from './serverEntry';

describe('server entry', () => {
    it('exports the co-editing, serialization and diff API', () => {
        const fns = [
            'markdownToAst', 'htmlToAst', 'astToMarkdown', 'astToHtml', 'normalizeLight', 'astToFragment', 'fragmentToAst',
            'createYCache', 'sameInY', 'syncDocToFragment', 'relativeFromPos', 'posFromRelative', 'encodeRelpos',
            'decodeRelpos', 'diffDocs', 'diffHtml', 'diffMarkdown', 'hunksFrom', 'anchorsForFragment', 'applyHunks', 'hunkWords',
        ];
        for (const name of fns) expect(typeof (entry as Record<string, unknown>)[name], name).toBe('function');
        expect(entry.FRAGMENT_NAME).toBe('content');
    });

    it('seeds, reads and diffs a document end to end', () => {
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment(entry.FRAGMENT_NAME);
        const ast = entry.markdownToAst('# Notes\n\nFirst draft.');
        entry.astToFragment(ast, fragment);
        const read = entry.fragmentToAst(fragment);
        expect(entry.astToMarkdown(read).trim()).toBe('# Notes\n\nFirst draft.');
        expect(entry.diffDocs(read, entry.markdownToAst('# Notes\n\nSecond draft.')).stats)
            .toEqual({ wordsAdded: 1, wordsRemoved: 1, blocksChanged: 1 });
    });
});
