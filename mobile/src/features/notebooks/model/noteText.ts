/**
 * A notebook's notes: the one document every notebook carries
 * (`documentContent`), which the web edits in its rich editor and the phone
 * edits as Markdown.
 *
 * The storage rules are the server's and the web's, not ours:
 *
 * - The web editor saves HTML. The store keeps a Markdown mirror of it in
 *   `documentMd` (stores/notebookStore.js `_updateNotebook`), so the phone
 *   edits that mirror.
 * - A body that does NOT look like HTML is stored as Markdown verbatim — the
 *   mirror is the body, `documentFormat` becomes 'markdown' — and the web's
 *   editor reads it with `markdownToAst` (editor/react/contentPipeline.js).
 *   That is the round trip: the phone saves Markdown, the web opens Markdown.
 * - "Looks like HTML" is one regex, the same on both sides
 *   (server/core/markdown `HTML_LIKE`, agent-hub editor/serialization/util.js
 *   `looksLikeHtml`). A note that happens to say `a <b> tag` would match it,
 *   be sanitised as HTML and open on the web as HTML. `storableMarkdown` puts
 *   an invisible WORD JOINER after such a `<`, which the regex does not
 *   accept, and `readableMarkdown` takes it out again on the way back.
 */

import type { Notebook } from './types';

/** server/core/markdown/index.js HTML_LIKE — pinned by noteText.test.ts. */
export const HTML_LIKE = /<\/?[a-z][\s\S]*>/i;

const WORD_JOINER = '⁠';
const TAG_START = /<(?=\/?[a-z])/gi;
const JOINED_TAG_START = new RegExp(`<${WORD_JOINER}(?=/?[a-z])`, 'gi');

export function looksLikeHtml(text: string): boolean {
    return HTML_LIKE.test(text);
}

/** What the phone sends as `documentContent`: Markdown the server will not take for HTML. */
export function storableMarkdown(markdown: string): string {
    return looksLikeHtml(markdown) ? markdown.replace(TAG_START, `<${WORD_JOINER}`) : markdown;
}

/** The inverse of `storableMarkdown`, for text read back from the server. */
export function readableMarkdown(stored: string): string {
    return stored.replace(JOINED_TAG_START, '<');
}

export interface EditableNote {
    /** The Markdown to show and edit. */
    text: string;
    /**
     * False only for a web document the server holds no Markdown mirror of
     * (its HTML could not be converted). Editing that here would replace the
     * document with whatever we guessed, so the phone shows it and waits.
     */
    editable: boolean;
    /**
     * Written in the web's rich editor. Saving from the phone stores Markdown,
     * which cannot hold colours, charts or column widths — worth one line of
     * warning before the first edit, not a refusal.
     */
    fromRichEditor: boolean;
}

export function editableNote(notebook: Pick<Notebook, 'documentContent' | 'documentMd' | 'documentFormat'>): EditableNote {
    const body = notebook.documentContent;
    const empty = body.trim() === '';
    const rich = !empty && notebook.documentFormat !== 'markdown' && looksLikeHtml(body);
    if (notebook.documentMd !== null) {
        return { text: readableMarkdown(notebook.documentMd), editable: true, fromRichEditor: rich };
    }
    if (!rich) return { text: readableMarkdown(body), editable: true, fromRichEditor: false };
    return { text: '', editable: false, fromRichEditor: true };
}

/**
 * A chat answer added to the notes, as the web's "Insert into document" adds
 * it: after what is there, as its own paragraph.
 */
export function appendToNote(current: string, addition: string): string {
    const extra = addition.trim();
    if (!extra) return current;
    const head = current.replace(/\s+$/, '');
    return head ? `${head}\n\n${extra}\n` : `${extra}\n`;
}
