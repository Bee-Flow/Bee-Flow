/**
 * The editor's imperative API as the notebook page uses it (BeeEditor's ref).
 * Every method is optional: the page calls them with `?.` so an editor build
 * without one of them degrades to "nothing happens" instead of crashing.
 */
import type { CommentAnchor } from '../../../api/queries/comments';

export interface NotebookEditorFacade {
    getHTML?: () => string;
    getText?: () => string;
    getMarkdown?: () => string;
    chain?: () => unknown;
}

export interface NotebookEditorHandle {
    insertContent?: (content: string) => void;
    setContent?: (html: string) => void;
    setMarkdown?: (md: string) => void;
    /**
     * New content as ONE undoable step, keeping caret and scroll (an AI edit, a restore).
     * `base`: the HTML it was made from; while co-editing, what others changed since is kept.
     */
    replaceDocument?: (content: string, opts?: { markdown?: boolean; base?: string }) => void;
    openShortcuts?: () => void;
    getEditor?: () => NotebookEditorFacade | null;
    flush?: () => string | null;
    getSelectionAnchor?: () => CommentAnchor | null;
    highlightAnchors?: (list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null) => void;
    scrollToAnchor?: (anchor: CommentAnchor) => boolean;
    scrollToHeading?: (index: number) => void;
    openFind?: () => void;
    [key: string]: unknown;
}

/** The editor's current HTML, or null without an editor. */
export function editorHtml(handle: NotebookEditorHandle | null | undefined): string | null {
    const html = handle?.getEditor?.()?.getHTML?.();
    return typeof html === 'string' ? html : null;
}
