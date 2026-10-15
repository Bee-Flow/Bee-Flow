import type { InsertableContent } from '../commands/index';
import { rebaseDoc } from '../collab/rebaseDoc';
import type { EditorView } from '../engine/view.js';
import type { AstNode } from '../collab/ySchema';
import type { BeeEditorProps, EditorShared } from './beeEditorTypes';
import { canRebase, chainOf } from './beeEditorHelpers';
import { contentToDoc, markdownToDoc } from './contentPipeline';
import type { EditorFacade } from './editorFacade';
import type { EditorSync } from './useEditorSync';

export interface BeeEditorHandleDeps {
  s: EditorShared;
  sync: EditorSync;
}

/**
 * The imperative API BeeEditor exposes through its ref (parity + setMarkdown
 * fix). Built by `useImperativeHandle(ref, () => buildEditorHandle(…), [refreshChrome])`.
 */
export function buildEditorHandle({ s, sync }: BeeEditorHandleDeps) {
  const { viewRef, saveTimer, lastHtmlRef, onSaveRef, facadeRef, setShortcutsOpen, setFindOpen, setFindFocus } = s;
  const { refreshChrome, collabRef, anchorsRef } = sync;
  return {
    insertContent: (c: InsertableContent) => {
      const v = viewRef.current;
      if (v) chainOf(v).focus().insertContent(c).run();
      refreshChrome();
    },
    setContent: (html: BeeEditorProps['content']) => { viewRef.current?.setDoc(contentToDoc(html), { emitUpdate: false }); refreshChrome(); },
    insertMarkdown: (md: string) => {
      const v = viewRef.current;
      if (v) chainOf(v).focus().insertContent(md).run();
      refreshChrome();
    },
    setMarkdownContent: (md: string) => { viewRef.current?.setDoc(markdownToDoc(md), { emitUpdate: false }); refreshChrome(); },
    setMarkdown: (md: string) => { viewRef.current?.setDoc(markdownToDoc(md), { emitUpdate: false }); refreshChrome(); },
    /**
     * Show new content (an AI edit, a restored version) as ONE undoable step,
     * keeping the caret and the scroll position; setContent instead starts a
     * fresh history (a different document). `markdown: true` reads Markdown.
     * Nothing is saved: the caller already holds, or saves, this content; an
     * undo afterwards is an ordinary edit and is saved like typing.
     * `base`: the HTML the new content was made from. While co-editing, what
     * others changed since that snapshot is kept instead of overwritten.
     */
    replaceDocument: (value: string, { markdown = false, base = null }: { markdown?: boolean; base?: string | null } = {}) => {
      const view = viewRef.current;
      if (!view) return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      const baseDoc = typeof base === 'string' ? contentToDoc(base) : null;
      const rebase = baseDoc ? (current: AstNode, next: AstNode) => rebaseDoc(baseDoc, current, next) : null;
      if (canRebase(view)) view.replaceDoc(markdown ? markdownToDoc(value) : contentToDoc(value), { emitUpdate: false, rebase });
      refreshChrome();
      // A content prop equal to what is now shown must not replace it again (that drops the undo step).
      if (!markdown && typeof value === 'string') lastHtmlRef.current = value;
    },
    /** Open the keyboard shortcuts sheet (the command palette's entry). */
    openShortcuts: () => setShortcutsOpen(true),
    getEditor: (): EditorFacade | null => facadeRef.current,
    /**
     * Persist right now, cancelling the pending debounce.
     *
     * Needed because the save debounce lives HERE, not in the autosave hook:
     * on unmount the timer is simply cleared, so up to 2 seconds of typing
     * disappeared whenever the user switched notebooks, hit Back, or closed the
     * tab within the debounce window. The hook's flush could not help — it
     * replays its own `pendingContentRef`, which is only populated once a save
     * has already begun.
     *
     * Returns the HTML it saved, or null when there was nothing pending.
     */
    flush: (): string | null => {
      const view: EditorView | null = viewRef.current;
      if (!view) return null;
      // A co-edited document has no pending local save: every change is already on its way.
      if (collabRef.current.active) return null;
      const hadPending = saveTimer.current != null;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      if (!hadPending) return null;
      const html = view.getHTML();
      lastHtmlRef.current = html;
      onSaveRef.current?.(html);
      return html;
    },
    /** The comment anchor for the current selection, or null without one. */
    getSelectionAnchor: () => anchorsRef.current.getSelectionAnchor(),
    /** Highlight these anchors (and one more strongly); an empty list clears them. */
    highlightAnchors: (...args: Parameters<EditorSync['anchors']['highlightAnchors']>) => anchorsRef.current.highlightAnchors(...args),
    /** Paint the passages of pending AI suggestions; an empty list clears them. */
    highlightSuggestions: (...args: Parameters<EditorSync['anchors']['highlightSuggestions']>) => anchorsRef.current.highlightSuggestions(...args),
    /** The id of the suggestion painted at a client point, or null. */
    suggestionAtPoint: (x: number, y: number) => anchorsRef.current.suggestionAtPoint(x, y),
    /** Scroll an anchor into view; false when its text is gone. */
    scrollToAnchor: (...args: Parameters<EditorSync['anchors']['scrollToAnchor']>) => anchorsRef.current.scrollToAnchor(...args),
    /** Scroll to the index-th heading of the outline (onTocUpdate's itemIndex). */
    scrollToHeading: (index: number) => anchorsRef.current.scrollToHeading(index),
    /** Open the find bar (for pages that offer Find while the editor is read-only). */
    openFind: () => { setFindOpen(true); setFindFocus((n) => n + 1); },
  };
}

