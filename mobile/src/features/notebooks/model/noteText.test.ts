/**
 * The notes' storage rules, pinned to the server's and the web's own: the
 * HTML sniff is the same regex on all three sides, and what the phone saves
 * never trips it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { appendToNote, editableNote, HTML_LIKE, looksLikeHtml, readableMarkdown, storableMarkdown } from './noteText';

const REPO = path.resolve(__dirname, '../../../../..');

// server/core/markdown's HTML_LIKE is the same regex; that file is outside
// the mobile CI filter, so the store's use of it is what is pinned here.
describe('the HTML sniff is the web’s, where the store decides', () => {
    it('matches the web editor’s looksLikeHtml', () => {
        const web = fs.readFileSync(`${AGENT_HUB_SRC}/editor/serialization/util.js`, 'utf8');
        expect(web).toContain(`export const looksLikeHtml = (s) => ${HTML_LIKE.toString()}.test(s || '');`);
    });

    it('is where the store decides Markdown from HTML', () => {
        const store = fs.readFileSync(path.join(REPO, 'server/stores/notebookStore.js'), 'utf8');
        expect(store).toContain('} else if (!looksLikeHtml(body)) {');
        expect(store).toContain("derivedFormat = 'markdown';");
    });
});

describe('storableMarkdown', () => {
    it('leaves ordinary Markdown alone', () => {
        const md = '# Plan\n\n- a < b\n- **bold** > plain';
        expect(storableMarkdown(md)).toBe(md);
    });

    it('keeps a tag-shaped phrase from reading as HTML, and gives it back unchanged', () => {
        const md = 'Use the <br> tag, then </div> closes it.';
        const stored = storableMarkdown(md);
        expect(looksLikeHtml(md)).toBe(true);
        expect(looksLikeHtml(stored)).toBe(false);
        expect(readableMarkdown(stored)).toBe(md);
    });
});

describe('editableNote', () => {
    const nb = (over: Partial<{ documentContent: string; documentMd: string | null; documentFormat: string }>) => ({
        documentContent: '',
        documentMd: null,
        documentFormat: 'html',
        ...over,
    });

    it('starts empty and editable on a new notebook', () => {
        expect(editableNote(nb({}))).toEqual({ text: '', editable: true, fromRichEditor: false });
    });

    it('edits the Markdown mirror of a web document, and says it came from the rich editor', () => {
        const out = editableNote(nb({ documentContent: '<h1>Plan</h1>', documentMd: '# Plan' }));
        expect(out).toEqual({ text: '# Plan', editable: true, fromRichEditor: true });
    });

    it('edits a Markdown document as it is', () => {
        const out = editableNote(nb({ documentContent: '# Plan', documentMd: '# Plan', documentFormat: 'markdown' }));
        expect(out).toEqual({ text: '# Plan', editable: true, fromRichEditor: false });
    });

    it('will not guess at HTML the server could not mirror', () => {
        expect(editableNote(nb({ documentContent: '<p>x</p>' })).editable).toBe(false);
    });
});

describe('appendToNote', () => {
    it('adds an answer as its own paragraph', () => {
        expect(appendToNote('# Plan\n\n', 'Answer')).toBe('# Plan\n\nAnswer\n');
        expect(appendToNote('', ' Answer ')).toBe('Answer\n');
        expect(appendToNote('Kept', '   ')).toBe('Kept');
    });
});
