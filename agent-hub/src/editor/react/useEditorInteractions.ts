import React, { useCallback, useEffect, useState } from 'react';
import { applyLink, linkRangeAt, removeLink } from '../engine/links';
import { isText as isTextSel } from '../engine/selection.js';
import type { EditorState } from '../engine/state.js';
import type { BeeEditorProps, EditorShared, SlashState } from './beeEditorTypes';
import { chainOf } from './beeEditorHelpers';
import { blockRect, selectionRect, selectionText } from './editorDom';
import { buildInsertItems, type InsertItem } from './insertItems';
import { SHORTCUT_COMMANDS, type ShortcutAction } from './shortcuts';
import type { EditorSync } from './useEditorSync';

/** Where the Ask-AI portal opens: the selection, or a fixed spot without one. */
function askAnchor(): { top: number; left: number } {
  let anchor = { top: 120, left: 120 };
  try {
    const dsel = window.getSelection();
    if (dsel && dsel.rangeCount) { const r = dsel.getRangeAt(0).getBoundingClientRect(); anchor = { top: r.top, left: r.left }; }
  } catch { /* noop */ }
  return anchor;
}

/**
 * Link editing, shortcuts, AI helpers, block insertion and the slash menu of
 * BeeEditor: the last block of hooks of the component, in the order the body
 * always declared them.
 */
export default function useEditorInteractions(s: EditorShared, props: BeeEditorProps, sync: EditorSync, refreshChrome: () => void) {
  const { onAIAction } = props;
  const { t, hostRef, viewRef, linkEditRef, setLinkEdit, setHiddenHeaders, setShortcutsOpen, setFindOpen, setFindFocus, runShortcutRef, setAsk, setAskQuery, imageInputRef } = s;
  const { editableRef } = sync;

  const toggleHeadersFocused = useCallback(() => {
    const info = viewRef.current?.tableInfo?.();
    if (!info) return;
    setHiddenHeaders((prev) => {
      const n = new Set(prev);
      if (n.has(info.ordinal)) n.delete(info.ordinal); else n.add(info.ordinal);
      return n;
    });
  }, []);

  /* link editing: an inline popover instead of the browser's prompt dialog */
  const openLinkEditor = useCallback(() => {
    const view = viewRef.current;
    if (!view || !editableRef.current) return;
    const sel = view.state.selection;
    if (!isTextSel(sel)) return;
    const existing = linkRangeAt(view.state);
    // The selection is captured now: focusing the address field can move the
    // browser selection, and the link belongs on what was selected here.
    setLinkEdit({
      rect: selectionRect() || blockRect(view),
      href: existing?.href || '',
      canRemove: !!existing || !!view.isActive('link'),
      doc: view.state.doc,
      selection: sel,
    });
  }, []);
  /** Run a link transform on the selection captured when the editor opened (while it still applies). */
  const withLinkSelection = useCallback((fn: (state: EditorState) => EditorState) => {
    const view = viewRef.current;
    if (!view) return;
    const captured = linkEditRef.current;
    view.focus();
    const same = captured && captured.doc === view.state.doc;
    view.dispatch((st: EditorState) => fn(same ? { ...st, selection: captured.selection } : st), { kind: 'format' });
  }, []);
  const closeLinkEditor = useCallback(() => { setLinkEdit(null); viewRef.current?.focus(); }, []);
  const applyLinkHref = useCallback((href: string) => {
    withLinkSelection((st) => applyLink(st, href));
    setLinkEdit(null);
  }, [withLinkSelection]);
  const removeLinkHere = useCallback(() => {
    withLinkSelection((st) => removeLink(st));
    setLinkEdit(null);
  }, [withLinkSelection]);

  /* keyboard shortcuts (catalogue in shortcuts.ts; the sheet reads the same list) */
  runShortcutRef.current = (action: string) => {
    const view = viewRef.current;
    if (!view) return false;
    if (action === 'find') { setFindOpen(true); setFindFocus((n) => n + 1); return true; }
    if (action === 'shortcuts') { setShortcutsOpen(true); return true; }
    if (!editableRef.current) return false;
    if (action === 'link') { openLinkEditor(); return true; }
    const command = SHORTCUT_COMMANDS[action as ShortcutAction];
    if (!command) return false;
    command(chainOf(view).focus()).run();
    return true;
  };

  /* AI action helpers */
  const aiAction = (key: string, customQuery: string | null = null) => {
    const view = viewRef.current;
    if (!view || !onAIAction) return;
    const text = selectionText(view);
    const flat = view.selectionFlat?.();
    if (!text || !text.trim()) return;
    onAIAction(key, text, flat || { from: 0, to: 0 }, customQuery);
  };

  // Open the Ask-AI portal anchored on the current selection (used by the
  // toolbar's AI ▾ → Ask AI, mirroring the FormatBubble's Ask button).
  const openAskFromSelection = () => {
    const view = viewRef.current;
    if (!view) return;
    const text = selectionText(view);
    if (!text || !text.trim()) return;
    const flat = view.selectionFlat?.() || { from: 0, to: 0 };
    setAsk({ anchor: askAnchor(), from: flat.from, to: flat.to, text });
    setAskQuery('');
  };

  const insertMath = () => {
    const view = viewRef.current;
    const text = selectionText(view);
    // Insert the node directly. Round-tripping the literal '$formula$' through
    // the markdown parser produced a math atom whose latex was the word
    // "formula" — visible placeholder text the user then had to delete. An empty
    // latex makes MathView open its input straight away instead (BFSF-317).
    if (view) chainOf(view).focus().insertInlineNode({ type: 'mathInline', attrs: { latex: text?.trim() || '' } }).run();
  };

  /* ── block insertion (shared by the status-strip Insert menu + slash menu) ── */
  const insertItems = React.useMemo(() => buildInsertItems(t), [t]);
  const toolbarInsertItems = React.useMemo(() => insertItems.filter((it) => !it.slashOnly), [insertItems]);

  const runInsert = useCallback((item: InsertItem | null | undefined, deleteBack = 0) => {
    const view = viewRef.current;
    if (!view || !item) return;
    let c = chainOf(view).focus();
    for (let i = 0; i < deleteBack; i++) c = c.deleteBackward();
    if (item.apply) {
      item.apply(c).run();
    } else {
      c.run();
      if (item.action === 'image') imageInputRef.current?.click();
      else if (item.action === 'math') insertMath();
    }
    refreshChrome();
  }, [refreshChrome]);

  /* ── slash menu (/ at the start of a text run) ── */
  const [slash, setSlash] = useState<SlashState | null>(null); // { query, rect:{top,left}, matchLen }

  const detectSlash = useCallback(() => {
    const view = viewRef.current;
    if (!view || view.composing) { setSlash(null); return; }
    const dsel = window.getSelection();
    if (!dsel || !dsel.isCollapsed || dsel.rangeCount === 0) { setSlash(null); return; }
    const node = dsel.anchorNode;
    if (!node || node.nodeType !== 3 || !hostRef.current?.contains(node)) { setSlash(null); return; }
    const before = (node.textContent ?? '').slice(0, dsel.anchorOffset);
    const m = before.match(/^\/(\w*)$/);
    if (!m) { setSlash(null); return; }
    const r = dsel.getRangeAt(0).getBoundingClientRect();
    setSlash({ query: m[1], rect: { top: r.bottom, left: r.left }, matchLen: m[1].length + 1 });
  }, []);

  useEffect(() => {
    const onSel = () => detectSlash();
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [detectSlash]);

  const runSlash = useCallback((item: InsertItem) => {
    runInsert(item, slash?.matchLen || 0);
    setSlash(null);
  }, [slash, runInsert]);

  return {
    toggleHeadersFocused, openLinkEditor, closeLinkEditor, applyLinkHref, removeLinkHere,
    aiAction, openAskFromSelection, insertItems, toolbarInsertItems, runInsert, slash, setSlash, runSlash,
  };
}
