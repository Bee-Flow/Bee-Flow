/**
 * BeeEditor — React wrapper for the from-scratch editor. Drop-in replacement for
 * NotebookEditor: identical props + imperative ref API, so the call sites switch
 * with one import. React renders the chrome (toolbar, bubble menus, atom portals)
 * and a single contentEditable host; the EditorView owns the editable DOM.
 *
 * Co-editing: pass `collab` (a handle from editor/collab/useCollab). Once the
 * session has synced the editor edits the shared document: the `content` prop
 * and the onSave debounce are ignored (onChange still reports the HTML, with
 * `{ remote }` telling whose change it was), undo is per person, and the other
 * people's carets are drawn beside the text. Until then the last saved content
 * is shown read-only.
 *
 * Everything drawn over the text (carets, find results, comment highlights)
 * lives OUTSIDE the host, in the positioned wrapper around it.
 */
import { ChevronDown, ChevronRight, Loader2, BarChart3 } from 'lucide-react';
import React, {
  useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle,
} from 'react';
import { createPortal } from 'react-dom';
import AtomRenderer from './AtomRenderer';
import AskPortal from './bubbles/AskPortal';
import FormatBubble from './bubbles/FormatBubble';
import ImageBubble from './bubbles/ImageBubble';
import ChartConfigModal from './ChartConfigModal.jsx';
import ChromeBoundary from './ChromeBoundary.jsx';
import { contentToDoc, markdownToDoc } from './contentPipeline.js';
import { selectionText, selectionRect, blockRect } from './editorDom';
import { makeFacade } from './editorFacade.js';
import EditorToolbar from './EditorToolbar.jsx';
import FindBar from './FindBar';
import GeneratingOverlay from './GeneratingOverlay';
import { isSafeImageSrc, uploadNotebookImage } from './imageUpload';
import { buildInsertItems } from './insertItems';
import { LinkBubble, LinkEditor } from './LinkTools';
import { peerInBlocks } from './peerLocks';
import RangeOverlay from './RangeOverlay';
import RemoteCursorsLayer from './RemoteCursorsLayer';
import SectionDragLayer from './SectionDragLayer.jsx';
import { matchShortcut, SHORTCUT_COMMANDS } from './shortcuts';
import ShortcutsSheet from './ShortcutsSheet';
import SlashMenu from './SlashMenu.jsx';
import { TableControls } from './TableControls';
import { loadCollapsed, saveCollapsed, loadHiddenHeaders, saveHiddenHeaders } from './tableViewState';
import { Item, mkTt } from './toolbarPrimitives.jsx';
import useEditorAnchors from './useEditorAnchors';
import useEditorChrome from './useEditorChrome';
import useEditorCollab from './useEditorCollab';
import useTranslation from '../../hooks/useTranslation';
import { rebaseDoc } from '../collab/rebaseDoc';
import { tableToMatrix } from '../engine/formula.js';
import { applyLink, removeLink, linkRangeAt } from '../engine/links';
import { isText as isTextSel } from '../engine/selection.js';
import { createState } from '../engine/state.js';
import { EditorView } from '../engine/view.js';
import { htmlToAst } from '../serialization/htmlToAst.js';
import '../editor.css';
import 'katex/dist/katex.min.css';

/* ── main component ─────────────────────────────────────── */
const BeeEditor = forwardRef(function BeeEditor(props, ref) {
  const {
    content, placeholder, editable = true, onChange, onSave, onAIAction, onAIFill,
    saving, onImportClick, generating, aiFilling, onTocUpdate, onWordCountChange,
    notebookId, askAiEnabled = true, collab: collabHandle = null, onUploadImage,
  } = props;

  const { t } = useTranslation();
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // The view as state as well, so hooks that need it (co-editing, find, anchors) re-run once it exists.
  const [viewInst, setViewInst] = useState(null);
  // The positioned wrapper around the host: overlays are measured against it.
  const [wrapEl, setWrapEl] = useState(null);
  // Bumped after every flushed document change: overlays re-measure on it.
  const [tick, setTick] = useState(0);
  const [linkEdit, setLinkEdit] = useState(null); // { rect, href, canRemove, doc, selection } | null
  const linkEditRef = useRef(null);
  linkEditRef.current = linkEdit;
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const onUploadImageRef = useRef(onUploadImage);
  onUploadImageRef.current = onUploadImage;
  // Assigned every render below; the host's keydown listener calls through it.
  const runShortcutRef = useRef(() => false);
  const facadeRef = useRef(null);
  const notebookIdRef = useRef(notebookId);
  const lastHtmlRef = useRef(null);
  const saveTimer = useRef(null);
  const imageInputRef = useRef(null);
  // contentGen increments on every external content swap (notebook switch / restore /
  // AI update). A debounced save captures the gen + notebook id at schedule time and
  // only fires if both still match — so a pending save from notebook A can never write
  // A's content into notebook B after a switch.
  const contentGenRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const [atoms, setAtoms] = useState([]);
  const [wordCount, setWordCount] = useState(0);
  const [ask, setAsk] = useState(null); // {anchor:{top,left}, from, to, text}
  const [askQuery, setAskQuery] = useState('');
  const [chartConfig, setChartConfig] = useState(null); // { columns, rows } | null
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(notebookId)); // Set<ordinal>
  // Which tables have their column-name strip hidden. View-only, like collapse.
  const [hiddenHeaders, setHiddenHeaders] = useState(() => loadHiddenHeaders(notebookId)); // Set<ordinal>
  const tt = mkTt(t);

  useEffect(() => { onChangeRef.current = onChange; onSaveRef.current = onSave; });

  // Switching notebooks must cancel any save still pending for the previous one.
  useEffect(() => {
    if (notebookIdRef.current !== notebookId) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      contentGenRef.current += 1;
    }
    notebookIdRef.current = notebookId;
  }, [notebookId]);

  // Keep onTocUpdate fresh for the stable refreshChrome callback.
  const onTocRef = useRef(onTocUpdate);
  useEffect(() => { onTocRef.current = onTocUpdate; }, [onTocUpdate]);

  // Same ref pattern for the word count, so the parent (header meta) can track
  // it without the mount effect or refreshChrome depending on callback identity.
  const onWordCountRef = useRef(onWordCountChange);
  useEffect(() => { onWordCountRef.current = onWordCountChange; }, [onWordCountChange]);
  const applyWordCount = useCallback((n) => { setWordCount(n); onWordCountRef.current?.(n); }, []);

  // Word count, outline, onChange's HTML and the toolbar state: at most once
  // per animation frame (each is O(document)), and only sent when changed.
  const chrome = useEditorChrome({
    viewRef,
    lastHtmlRef,
    onChange: (html, meta) => onChangeRef.current?.(html, meta),
    onToc: (items) => onTocRef.current?.(items),
    onWordCount: applyWordCount,
    onRender: () => setTick((n) => n + 1),
  });
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  // Co-editing: bound once the session synced; read-only while it connects.
  const collab = useEditorCollab(viewInst, collabHandle);
  const collabRef = useRef(collab);
  collabRef.current = collab;
  const effectiveEditable = editable && (!collab.active || collab.canEdit);
  const editableRef = useRef(effectiveEditable);
  editableRef.current = effectiveEditable;
  const anchors = useEditorAnchors(viewRef, collab.binding);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  // Recompute toolbar chrome (word count, TOC) after an external content change
  // that doesn't emit an update (setContent / AI write / content prop) — without
  // triggering a save. Fixes the "0 words after AI write" stale-count bug.
  const refreshChrome = useCallback(() => {
    if (!viewRef.current) return;
    chromeRef.current.schedule({ doc: true });
    chromeRef.current.flush();
  }, []);

  // Collapse state is view-only (never serialized): reload on notebook switch,
  // persist on change, and re-apply the `bf-collapsed` class to each table el
  // after every render (the reconciler may recreate table elements).
  const prevNbRef = useRef(notebookId);
  useEffect(() => {
    if (prevNbRef.current !== notebookId) {
      prevNbRef.current = notebookId;
      setCollapsed(loadCollapsed(notebookId));
      setHiddenHeaders(loadHiddenHeaders(notebookId));
    }
  }, [notebookId]);
  useEffect(() => { saveCollapsed(notebookId, collapsed); }, [collapsed, notebookId]);
  useEffect(() => { saveHiddenHeaders(notebookId, hiddenHeaders); }, [hiddenHeaders, notebookId]);
  useEffect(() => {
    const v = viewRef.current;
    if (!v?.allTables) return;
    for (const { el, ordinal } of v.allTables()) { if (el) el.classList.toggle('bf-collapsed', collapsed.has(ordinal)); }
  });

  const toggleCollapseFocused = useCallback(() => {
    const info = viewRef.current?.tableInfo?.();
    if (!info) return;
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(info.ordinal)) n.delete(info.ordinal); else n.add(info.ordinal); return n; });
  }, []);

  // Open the chart config modal, seeded with the current table's columns/rows.
  const openChartModal = useCallback(() => {
    const info = viewRef.current?.tableInfo?.();
    if (!info) return;
    const matrix = tableToMatrix(info.node);
    if (!matrix.length || !matrix[0]?.length) return;
    setChartConfig({ columns: matrix[0], rows: matrix.slice(1) });
  }, []);
  const createChart = useCallback((spec) => {
    setChartConfig(null);
    viewRef.current?.chain().focus().insertAfterTable({ type: 'chart', attrs: { spec: JSON.stringify(spec) } }).run();
    refreshChrome();
  }, [refreshChrome]);

  /* mount the view once */
  useEffect(() => {
    const host = hostRef.current;
    let nextAtomId = 1;
    const view = new EditorView(host, {
      state: createState(contentToDoc(content)),
      editable,
      htmlToAst: (html) => htmlToAst(html),
      mountAtom: (node, hostEl) => {
        hostEl.__bfAtomNode = node;
        const id = nextAtomId++;
        hostEl.__bfAtomId = id;
        setAtoms((a) => [...a, { host: hostEl, node, id }]);
      },
      unmountAtom: (hostEl) => setAtoms((a) => a.filter((x) => x.host !== hostEl)),
      // Re-point an atom's portal at the new node (attr change) WITHOUT unmounting,
      // so the mermaid/math view keeps its DOM + internal state (no flicker/reset).
      remapAtom: (hostEl, n) => { hostEl.__bfAtomNode = n; setAtoms((a) => a.map((x) => (x.host === hostEl ? { ...x, node: n } : x))); },
      onUpdate: (meta) => {
        const remote = !!meta?.remote;
        // A co-edited document is saved by the server; only a single-writer
        // document schedules the debounced save.
        if (!collabRef.current.active && !remote) {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          const genAtSchedule = contentGenRef.current;
          const idAtSchedule = notebookIdRef.current;
          saveTimer.current = setTimeout(() => {
            saveTimer.current = null;
            // Only persist if we haven't switched notebooks since this edit.
            if (contentGenRef.current !== genAtSchedule || notebookIdRef.current !== idAtSchedule) return;
            let html;
            try { html = view.getHTML(); } catch (e) {
              console.error('[BeeEditor] could not serialise the document — it was not saved', e?.name || 'Error');
              return;
            }
            lastHtmlRef.current = html;
            onSaveRef.current?.(html);
          }, 2000);
        }
        chromeRef.current.schedule({ doc: true, emit: true, remote });
      },
      onSelectionChange: () => chromeRef.current.schedule(),
    });
    viewRef.current = view;
    facadeRef.current = makeFacade(view);
    setViewInst(view);
    lastHtmlRef.current = view.getHTML();
    chromeRef.current.schedule({ doc: true });
    chromeRef.current.flush();

    // Image paste/drop → upload (capture phase, before the view's text handler)
    // preventDefault is required on BOTH branches: stopImmediatePropagation
    // suppresses the view's own paste handler (which is where preventDefault
    // lived), so without it the browser also performed its native
    // contenteditable paste of the image on top of the model insert.
    const onPaste = (e) => { if (handleImageClipboard(e.clipboardData)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    const onDrop = (e) => { if (handleImageClipboard(e.dataTransfer)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('drop', onDrop, true);
    // Shortcuts beyond the engine's own (bold/italic/underline/undo/redo).
    const onKeyDown = (e) => {
      if (e.defaultPrevented || view.inAtom(e.target)) return;
      const action = matchShortcut(e);
      if (!action) return;
      if (runShortcutRef.current(action)) e.preventDefault();
    };
    host.addEventListener('keydown', onKeyDown);

    // Thorough teardown so a StrictMode/HMR re-mount starts from a clean host
    // (no duplicate listeners, no orphaned atom portals, no pending save).
    return () => {
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('drop', onDrop, true);
      host.removeEventListener('keydown', onKeyDown);
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      view.destroy();
      try { host.textContent = ''; } catch { /* noop */ }
      setAtoms([]);
      viewRef.current = null;
      facadeRef.current = null;
      setViewInst(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the ProseMirror view is created once per mount; later prop changes are applied by the effects below
  }, []);

  /* external content changes (e.g. switching notebooks) */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // While co-editing, the shared document is the content; the prop is only
    // the starting point shown until the session has synced.
    if (collab.bound) return;
    if (typeof content === 'string' && content !== lastHtmlRef.current) {
      // External content swap: cancel any save still pending for the old content.
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      view.setDoc(contentToDoc(content), { emitUpdate: false });
      refreshChrome();
      // Compare future props against the raw incoming string so an identical
      // content prop on a later render doesn't re-apply (refreshChrome set this
      // to the re-serialized HTML, which may differ from `content`).
      lastHtmlRef.current = content;
    }
  }, [content, refreshChrome, collab.bound]);

  useEffect(() => { viewRef.current?.setEditable(effectiveEditable); }, [effectiveEditable, viewInst]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // One call, one order of precedence: an explicit prop wins, otherwise the
    // dictionary, otherwise this English sentence. The two-step version used
    // the forbidden `t(key)`-and-judge-the-result form and, worse, its last
    // resort was Dutch — an English UI with an unloaded catalogue greeted the
    // user with "Begin met schrijven…".
    const fallback = placeholder || t('notebooks.placeholder', 'Start writing… Type $formula$ for math, :emoji: for emoji, or use the toolbar.');
    host.style.setProperty('--bf-placeholder', `"${fallback.replace(/"/g, '\\"')}"`);
  }, [placeholder, t]);

  /* image upload: the caller's uploader (onUploadImage), else the notebook's endpoint */
  const uploadImage = useCallback(async (file) => {
    if (!file || !/^image\//.test(file.type)) return;
    const nbId = notebookIdRef.current;
    const upload = onUploadImageRef.current || (nbId ? (f) => uploadNotebookImage(nbId, f) : null);
    if (!upload) return;
    try {
      const result = await upload(file);
      if (result === null) return;
      if (!isSafeImageSrc(result?.src)) { setUploadError(true); return; }
      setUploadError(false);
      viewRef.current?.chain().focus().setImage({ src: String(result.src), alt: result.alt || file.name }).run();
    } catch (err) {
      console.error('[BeeEditor] image upload failed', err?.name || 'Error');
      setUploadError(true);
    }
  }, []);
  useEffect(() => {
    if (!uploadError) return undefined;
    const timer = setTimeout(() => setUploadError(false), 6000);
    return () => clearTimeout(timer);
  }, [uploadError]);

  const handleImageClipboard = (dt) => {
    const items = Array.from(dt?.items || dt?.files || []);
    const img = items.find((i) => (i.type || '').startsWith('image/'));
    if (!img) return false;
    const file = img.getAsFile ? img.getAsFile() : img;
    if (file) uploadImage(file);
    return true;
  };

  /* imperative ref API (parity + setMarkdown fix) */
  useImperativeHandle(ref, () => ({
    insertContent: (c) => { viewRef.current?.chain().focus().insertContent(c).run(); refreshChrome(); },
    setContent: (html) => { viewRef.current?.setDoc(contentToDoc(html), { emitUpdate: false }); refreshChrome(); },
    insertMarkdown: (md) => { viewRef.current?.chain().focus().insertContent(md).run(); refreshChrome(); },
    setMarkdownContent: (md) => { viewRef.current?.setDoc(markdownToDoc(md), { emitUpdate: false }); refreshChrome(); },
    setMarkdown: (md) => { viewRef.current?.setDoc(markdownToDoc(md), { emitUpdate: false }); refreshChrome(); },
    /**
     * Show new content (an AI edit, a restored version) as ONE undoable step,
     * keeping the caret and the scroll position; setContent instead starts a
     * fresh history (a different document). `markdown: true` reads Markdown.
     * Nothing is saved: the caller already holds, or saves, this content; an
     * undo afterwards is an ordinary edit and is saved like typing.
     * `base`: the HTML the new content was made from. While co-editing, what
     * others changed since that snapshot is kept instead of overwritten.
     */
    replaceDocument: (value, { markdown = false, base = null } = {}) => {
      const view = viewRef.current;
      if (!view) return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      const baseDoc = typeof base === 'string' ? contentToDoc(base) : null;
      const rebase = baseDoc ? (current, next) => rebaseDoc(baseDoc, current, next) : null;
      view.replaceDoc(markdown ? markdownToDoc(value) : contentToDoc(value), { emitUpdate: false, rebase });
      refreshChrome();
      // A content prop equal to what is now shown must not replace it again (that drops the undo step).
      if (!markdown && typeof value === 'string') lastHtmlRef.current = value;
    },
    /** Open the keyboard shortcuts sheet (the command palette's entry). */
    openShortcuts: () => setShortcutsOpen(true),
    getEditor: () => facadeRef.current,
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
    flush: () => {
      const view = viewRef.current;
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
    highlightAnchors: (list, activeId) => anchorsRef.current.highlightAnchors(list, activeId),
    /** Paint the passages of pending AI suggestions; an empty list clears them. */
    highlightSuggestions: (list, activeId) => anchorsRef.current.highlightSuggestions(list, activeId),
    /** The id of the suggestion painted at a client point, or null. */
    suggestionAtPoint: (x, y) => anchorsRef.current.suggestionAtPoint(x, y),
    /** Scroll an anchor into view; false when its text is gone. */
    scrollToAnchor: (anchor) => anchorsRef.current.scrollToAnchor(anchor),
    /** Scroll to the index-th heading of the outline (onTocUpdate's itemIndex). */
    scrollToHeading: (index) => anchorsRef.current.scrollToHeading(index),
    /** Open the find bar (for pages that offer Find while the editor is read-only). */
    openFind: () => { setFindOpen(true); setFindFocus((n) => n + 1); },
  }), [refreshChrome]);

  const editor = facadeRef.current;
  const selectedAtomNode = viewRef.current?.getSelectedNode?.() || null;
  // Re-evaluated each render; BeeEditor re-renders on selection changes (chrome),
  // so the toolbar's AI items enable/disable as the selection changes.
  const hasSelection = !!(viewRef.current && selectionText(viewRef.current).trim());
  // The table the caret sits in (for the on-edit add-row/add-column controls).
  const tableInfo = editor && effectiveEditable ? (viewRef.current?.tableInfo?.() || null) : null;
  const tableCollapsed = tableInfo ? collapsed.has(tableInfo.ordinal) : false;
  const headersHidden = tableInfo ? hiddenHeaders.has(tableInfo.ordinal) : false;
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
  const withLinkSelection = useCallback((fn) => {
    const view = viewRef.current;
    if (!view) return;
    const captured = linkEditRef.current;
    view.focus();
    const same = captured && captured.doc === view.state.doc;
    view.dispatch((s) => fn(same ? { ...s, selection: captured.selection } : s), { kind: 'format' });
  }, []);
  const closeLinkEditor = useCallback(() => { setLinkEdit(null); viewRef.current?.focus(); }, []);
  const applyLinkHref = useCallback((href) => {
    withLinkSelection((s) => applyLink(s, href));
    setLinkEdit(null);
  }, [withLinkSelection]);
  const removeLinkHere = useCallback(() => {
    withLinkSelection((s) => removeLink(s));
    setLinkEdit(null);
  }, [withLinkSelection]);

  /* keyboard shortcuts (catalogue in shortcuts.ts; the sheet reads the same list) */
  runShortcutRef.current = (action) => {
    const view = viewRef.current;
    if (!view) return false;
    if (action === 'find') { setFindOpen(true); setFindFocus((n) => n + 1); return true; }
    if (action === 'shortcuts') { setShortcutsOpen(true); return true; }
    if (!editableRef.current) return false;
    if (action === 'link') { openLinkEditor(); return true; }
    const command = SHORTCUT_COMMANDS[action];
    if (!command) return false;
    command(view.chain().focus()).run();
    return true;
  };

  /* AI action helpers */
  const aiAction = (key, customQuery = null) => {
    const view = viewRef.current;
    if (!view || !onAIAction) return;
    const text = view.getText && selectionText(view);
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
    let anchor = { top: 120, left: 120 };
    try {
      const dsel = window.getSelection();
      if (dsel && dsel.rangeCount) { const r = dsel.getRangeAt(0).getBoundingClientRect(); anchor = { top: r.top, left: r.left }; }
    } catch { /* noop */ }
    setAsk({ anchor, from: flat.from, to: flat.to, text });
    setAskQuery('');
  };

  const insertMath = () => {
    const view = viewRef.current;
    const text = selectionText(view);
    // Insert the node directly. Round-tripping the literal '$formula$' through
    // the markdown parser produced a math atom whose latex was the word
    // "formula" — visible placeholder text the user then had to delete. An empty
    // latex makes MathView open its input straight away instead (BFSF-317).
    view.chain().focus().insertInlineNode({ type: 'mathInline', attrs: { latex: text?.trim() || '' } }).run();
  };

  /* ── block insertion (shared by the status-strip Insert menu + slash menu) ── */
  const insertItems = React.useMemo(() => buildInsertItems(t), [t]);
  const toolbarInsertItems = React.useMemo(() => insertItems.filter((it) => !it.slashOnly), [insertItems]);

  const runInsert = useCallback((item, deleteBack = 0) => {
    const view = viewRef.current;
    if (!view || !item) return;
    let c = view.chain().focus();
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
  const [slash, setSlash] = useState(null); // { query, rect:{top,left}, matchLen }

  const detectSlash = useCallback(() => {
    const view = viewRef.current;
    if (!view || view.composing) { setSlash(null); return; }
    const dsel = window.getSelection();
    if (!dsel || !dsel.isCollapsed || dsel.rangeCount === 0) { setSlash(null); return; }
    const node = dsel.anchorNode;
    if (!node || node.nodeType !== 3 || !hostRef.current?.contains(node)) { setSlash(null); return; }
    const before = node.textContent.slice(0, dsel.anchorOffset);
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

  const runSlash = useCallback((item) => {
    runInsert(item, slash?.matchLen || 0);
    setSlash(null);
  }, [slash, runInsert]);

  return (
    <div className="bf-editor flex flex-col h-full relative" style={{ background: 'var(--bg-primary)' }}>
      <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ''; }} />

      {editor && effectiveEditable && (
        <EditorToolbar
          editor={editor}
          t={t}
          onLink={openLinkEditor}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onFind={() => { setFindOpen(true); setFindFocus((n) => n + 1); }}
          insertItems={toolbarInsertItems}
          onInsert={runInsert}
          onToggleColumnNames={toggleHeadersFocused}
          columnNamesHidden={headersHidden}
          onImportClick={onImportClick}
          onAIFill={onAIFill}
          aiFilling={aiFilling}
          askAiEnabled={askAiEnabled}
          saving={saving}
          wordCount={wordCount}
          onAIAction={aiAction}
          onAsk={openAskFromSelection}
          hasSelection={hasSelection}
          tableMenuExtras={({ inTable, setOpen }) => (
            <>
              <Item icon={BarChart3} label={tt('notebooks.create_chart', 'Create chart')} disabled={!inTable} onClick={() => { openChartModal(); setOpen(false); }} />
              <Item icon={tableCollapsed ? ChevronDown : ChevronRight} label={tableCollapsed ? tt('notebooks.expand_table', 'Expand table') : tt('notebooks.collapse_table', 'Collapse table')} disabled={!inTable} onClick={() => { toggleCollapseFocused(); setOpen(false); }} />
            </>
          )}
        />
      )}

      {generating && <GeneratingOverlay label={generating} t={t} />}

      {collab.loading && (
        <div role="status" className="bf-collab-loading">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
          {t('editor.collab_loading', 'Opening the live document…')}
        </div>
      )}
      {uploadError && (
        <div role="status" className="bf-editor-notice">
          {t('editor.image_upload_failed', 'The image could not be uploaded. Try again, or use a smaller image.')}
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar" onScroll={chrome.onScroll}>
        {findOpen && viewInst && (
          <FindBar
            view={viewInst}
            editable={effectiveEditable}
            tick={tick}
            container={wrapEl}
            focusSignal={findFocus}
            onClose={() => setFindOpen(false)}
          />
        )}
        <div ref={setWrapEl} className="bf-editor-surface max-w-[820px] mx-auto px-8 py-6">
          {editor && effectiveEditable && (
            <SectionDragLayer hostRef={hostRef} viewRef={viewRef} isLocked={collab.bound ? (from, count) => peerInBlocks(collab.binding, collabHandle?.peers, from, count) : null} />
          )}
          <div ref={hostRef} className="notebook-editor bf-content" aria-busy={collab.loading || undefined} />
          <RangeOverlay layers={anchors.layers} container={wrapEl} tick={tick} />
          {collab.bound && (
            <RemoteCursorsLayer view={viewInst} binding={collab.binding} peers={collabHandle?.peers || []} container={wrapEl} tick={tick} />
          )}
        </div>
      </div>

      {/* contextual format bubble (inline marks + block + AI) */}
      {editor && effectiveEditable && (
        <FormatBubble
          onLink={openLinkEditor}
          view={viewRef.current}
          editor={editor}
          t={t}
          askAiEnabled={askAiEnabled}
          onAction={aiAction}
          onAsk={(anchor, from, to, text) => { setAsk({ anchor, from, to, text }); setAskQuery(''); }}
          askOpen={!!ask || !!linkEdit}
        />
      )}

      {/* slash command menu (/ for block insertion) */}
      {editor && effectiveEditable && slash && (
        <SlashMenu
          items={insertItems}
          query={slash.query}
          rect={slash.rect}
          onSelect={runSlash}
          onClose={() => setSlash(null)}
        />
      )}

      {/* table add-row / add-column + collapse controls (caret inside a table) */}
      {editor && effectiveEditable && tableInfo && (
        <ChromeBoundary label="table controls">
          <TableControls view={viewRef.current} info={tableInfo} t={t} collapsed={tableCollapsed} onToggleCollapse={toggleCollapseFocused} headersHidden={headersHidden} />
        </ChromeBoundary>
      )}

      {/* image bubble */}
      {editor && effectiveEditable && selectedAtomNode?.type === 'image' && (
        <ImageBubble view={viewRef.current} node={selectedAtomNode} />
      )}

      {/* link bubble (caret inside a link) and the inline link editor */}
      {editor && !linkEdit && editor.isActive('link') && (() => {
        const rect = selectionRect();
        if (!rect) return null;
        return <LinkBubble rect={rect} href={editor.getAttributes('link').href || ''} editable={effectiveEditable} onEdit={openLinkEditor} onRemove={removeLinkHere} />;
      })()}
      {linkEdit && linkEdit.rect && (
        <LinkEditor rect={linkEdit.rect} initialHref={linkEdit.href} canRemove={linkEdit.canRemove}
          onApply={applyLinkHref} onRemove={removeLinkHere} onClose={closeLinkEditor} />
      )}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* ask AI floating portal */}
      {ask && (
        <AskPortal
          ask={ask} query={askQuery} setQuery={setAskQuery} t={t}
          onSubmit={() => { if (askQuery.trim()) onAIAction?.('ask', ask.text, { from: ask.from, to: ask.to }, askQuery.trim()); setAsk(null); }}
          onClose={() => setAsk(null)}
        />
      )}

      {/* chart config modal */}
      {chartConfig && (
        <ChartConfigModal
          columns={chartConfig.columns}
          rows={chartConfig.rows}
          t={t}
          onCreate={createChart}
          onClose={() => setChartConfig(null)}
        />
      )}

      {/* atom portals */}
      {atoms.map((a) => createPortal(
        <AtomRenderer
          node={a.node}
          view={viewRef.current}
          selected={selectedAtomNode === a.node}
          editable={effectiveEditable}
          brokenLabel={t('notebooks.atom_render_failed', 'Could not display this block')}
        />,
        a.host, a.id,
      ))}
    </div>
  );
});

// TableControls lives in ./TableControls; still exported here for callers that imported it from this module.
export { TableControls };

export default BeeEditor;
