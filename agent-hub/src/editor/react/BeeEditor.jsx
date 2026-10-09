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
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, List, ListOrdered, Quote,
  Heading1, Heading2, Heading3, AlignLeft, AlignCenter, AlignRight,
  Highlighter, Wand2, RefreshCw, Scissors, Expand, Code, Link as LinkIcon,
  Table2, Trash2, ChevronDown, ChevronRight, Sigma, CheckSquare, ImageIcon, Palette, WrapText,
  Loader2, Minus, Pilcrow, Plus, BarChart3, X,
} from 'lucide-react';
import React, {
  useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle,
} from 'react';
import { createPortal } from 'react-dom';
import ChartConfigModal from './ChartConfigModal.jsx';
import ChromeBoundary from './ChromeBoundary.jsx';
import { contentToDoc, markdownToDoc } from './contentPipeline.js';
import { makeFacade } from './editorFacade.js';
import EditorToolbar from './EditorToolbar.jsx';
import FindBar from './FindBar';
import { LinkBubble, LinkEditor } from './LinkTools';
import RangeOverlay from './RangeOverlay';
import RemoteCursorsLayer from './RemoteCursorsLayer';
import SectionDragLayer from './SectionDragLayer.jsx';
import { matchShortcut, SHORTCUT_COMMANDS } from './shortcuts';
import ShortcutsSheet from './ShortcutsSheet';
import SlashMenu from './SlashMenu.jsx';
import {
  Btn, Dropdown, Item, MenuDivider, MenuLabel, BubbleDivider, mkTt,
  FONT_FAMILIES, PALETTE, HIGHLIGHTS,
} from './toolbarPrimitives.jsx';
import useEditorAnchors from './useEditorAnchors';
import useEditorChrome from './useEditorChrome';
import useEditorCollab from './useEditorCollab';
import useFloatingRect from './useFloatingRect.js';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import { rebaseDoc } from '../collab/rebaseDoc';
import { tableToMatrix } from '../engine/formula.js';
import { colLabel } from '../engine/formulaRefs.js';
import { applyLink, removeLink, linkRangeAt } from '../engine/links';
import { isText as isTextSel } from '../engine/selection.js';
import { createState } from '../engine/state.js';
import { tableGrid } from '../engine/tables.js';
import * as Tbl from '../engine/tables.js';
import { EditorView } from '../engine/view.js';
import ChartView from '../nodeviews/ChartView.jsx';
import FormulaView from '../nodeviews/FormulaView.jsx';
import ImageView from '../nodeviews/ImageView.jsx';
import MathView from '../nodeviews/MathView.jsx';
import MermaidView from '../nodeviews/MermaidView.jsx';
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

/* ── atom renderer ──────────────────────────────────────── */
/**
 * One bad node view must not take the document down with it.
 *
 * Node views render content the user never authored directly — a chart spec or
 * mermaid source can arrive from an ingested document or an AI write. Without a
 * boundary here the nearest one wraps ALL of BeeEditor, so a single malformed
 * spec replaced the whole editor with the error screen, and its retry remounted
 * from the same content and crashed again: the notebook could not be opened.
 */
class AtomErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) {
    console.error(`[BeeEditor] ${this.props.type} node view failed to render`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] select-none"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px dashed var(--border-default)' }}
          title={String(this.state.error?.message || this.state.error)}
        >
          {this.props.label}
        </span>
      );
    }
    return this.props.children;
  }
}

function AtomRenderer({ node, view, selected, editable, brokenLabel }) {
  let el = null;
  if (node.type === 'image') el = <ImageView node={node} view={view} selected={selected} editable={editable} />;
  else if (node.type === 'mermaid') el = <MermaidView node={node} view={view} editable={editable} />;
  else if (node.type === 'mathBlock') el = <MathView node={node} view={view} inline={false} editable={editable} />;
  else if (node.type === 'mathInline') el = <MathView node={node} view={view} inline editable={editable} />;
  else if (node.type === 'formula') el = <FormulaView node={node} view={view} editable={editable} />;
  else if (node.type === 'chart') el = <ChartView node={node} view={view} editable={editable} />;
  if (!el) return null;
  return <AtomErrorBoundary type={node.type} label={brokenLabel}>{el}</AtomErrorBoundary>;
}

/* ── block-insert catalogue (status-strip Insert menu + slash menu) ──────── */
function buildInsertItems(t) {
  const tt = mkTt(t);
  return [
    { key: 'h1', icon: Heading1, label: tt('notebooks.heading_1', 'Heading 1'), keywords: 'h1 title', apply: (c) => c.toggleHeading({ level: 1 }) },
    { key: 'h2', icon: Heading2, label: tt('notebooks.heading_2', 'Heading 2'), keywords: 'h2 subtitle', apply: (c) => c.toggleHeading({ level: 2 }) },
    { key: 'h3', icon: Heading3, label: tt('notebooks.heading_3', 'Heading 3'), keywords: 'h3', apply: (c) => c.toggleHeading({ level: 3 }) },
    { key: 'bullet', icon: List, label: tt('notebooks.bullet_list', 'Bullet list'), keywords: 'ul unordered', apply: (c) => c.toggleBulletList() },
    { key: 'ordered', icon: ListOrdered, label: tt('notebooks.numbered_list', 'Numbered list'), keywords: 'ol numbered', apply: (c) => c.toggleOrderedList() },
    { key: 'task', icon: CheckSquare, label: tt('notebooks.task_list', 'Task list'), keywords: 'todo checkbox', apply: (c) => c.toggleTaskList() },
    { key: 'quote', icon: Quote, label: tt('notebooks.blockquote', 'Quote'), keywords: 'blockquote', apply: (c) => c.toggleBlockquote() },
    { key: 'code', icon: Code, label: tt('notebooks.code_block', 'Code block'), keywords: 'pre snippet', apply: (c) => c.setCodeBlock() },
    // Slash-menu only. The toolbar has a dedicated Table button whose size
    // picker sits right next to the Insert menu, so offering a second entry
    // point that silently inserts a fixed 3×3 read as the picker being broken
    // (BFSF-316). Typing "/table" is a keyboard flow where a sensible default
    // is what you want, so it stays there.
    { key: 'table', icon: Table2, label: tt('notebooks.table', 'Table'), keywords: 'grid', slashOnly: true, apply: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
    { key: 'divider', icon: Minus, label: tt('notebooks.divider', 'Divider'), keywords: 'hr rule horizontal', apply: (c) => c.setHorizontalRule() },
    { key: 'image', icon: ImageIcon, label: tt('notebooks.upload_image', 'Image'), keywords: 'picture photo', action: 'image' },
    { key: 'math', icon: Sigma, label: tt('notebooks.math_formula', 'Math'), keywords: 'formula latex equation', action: 'math' },
  ];
}

/* ── bubble menus ───────────────────────────────────────── */

// FormatBubble — the contextual formatter shown on a text selection. It is now
// the PRIMARY formatting surface (the persistent toolbar was demoted): inline
// marks + "turn into" block type + alignment + colour/highlight/font + AI.
function FormatBubble({ view, editor, t, askAiEnabled, onAction, onAsk, askOpen, onLink }) {
  const rect = useFloatingRect(view, { enabled: !askOpen });
  if (!rect || !editor) return null;
  const tt = mkTt(t);
  const chain = () => editor.chain().focus();
  const align = (a) => editor.isActive({ align: a });
  const currentColor = editor.getAttributes('textStyle').color || null;
  const currentFont = editor.getAttributes('textStyle').fontFamily || null;
  const isPlain = !editor.isActive('heading') && !editor.isActive('bulletList') && !editor.isActive('orderedList') && !editor.isActive('taskList') && !editor.isActive('blockquote');

  // Above the selection, flipping below when there's no room; clamp horizontally.
  const W = 360;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const left = Math.max(8, Math.min(rect.left, vw - W - 8));
  const above = rect.top - 46;
  const top = above < 8 ? rect.bottom + 8 : above;

  const turnLabel = editor.isActive('heading', { level: 1 }) ? 'H1'
    : editor.isActive('heading', { level: 2 }) ? 'H2'
    : editor.isActive('heading', { level: 3 }) ? 'H3'
    : editor.isActive('bulletList') ? '•'
    : editor.isActive('orderedList') ? '1.'
    : editor.isActive('taskList') ? '☑'
    : editor.isActive('blockquote') ? '❝'
    : tt('notebooks.paragraph', 'Text');

  return (
    <div className="fixed z-[9998] flex items-center flex-wrap px-1.5 py-1 rounded-xl shadow-xl border backdrop-blur-md"
      style={{ top, left, gap: 2, maxWidth: 'min(94vw, 540px)', background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
      role="toolbar" aria-label={tt('notebooks.format', 'Format')}
      onMouseDown={(e) => e.preventDefault()}>
      <Btn onClick={() => chain().toggleBold().run()} active={editor.isActive('bold')} icon={Bold} title={tt('notebooks.bold', 'Bold')} />
      <Btn onClick={() => chain().toggleItalic().run()} active={editor.isActive('italic')} icon={Italic} title={tt('notebooks.italic', 'Italic')} />
      <Btn onClick={() => chain().toggleUnderline().run()} active={editor.isActive('underline')} icon={UnderlineIcon} title={tt('notebooks.underline', 'Underline')} />
      <Btn onClick={() => chain().toggleStrike().run()} active={editor.isActive('strike')} icon={Strikethrough} title={tt('notebooks.strikethrough', 'Strikethrough')} />
      <Btn onClick={() => chain().toggleCode().run()} active={editor.isActive('code')} icon={Code} title={tt('notebooks.inline_code', 'Inline code')} />
      <Btn onClick={() => chain().toggleHighlight().run()} active={editor.isActive('highlight')} icon={Highlighter} title={tt('notebooks.highlight', 'Highlight')} />
      <Btn onClick={() => onLink?.()} active={editor.isActive('link')} icon={LinkIcon} title={tt('notebooks.insert_link', 'Insert link')} />

      <BubbleDivider />

      {/* Turn into block type */}
      <Dropdown trigger={(open, setOpen) => (
        <button onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }} className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]" title={tt('notebooks.turn_into', 'Turn into')}>
          <span className="min-w-[14px] text-center">{turnLabel}</span><ChevronDown className="w-3 h-3 opacity-50" />
        </button>
      )}>
        {(setOpen) => (
          <>
            <Item icon={Pilcrow} label={tt('notebooks.paragraph', 'Text')} active={isPlain} onClick={() => { chain().setParagraph().run(); setOpen(false); }} />
            <Item icon={Heading1} label={tt('notebooks.heading_1', 'Heading 1')} active={editor.isActive('heading', { level: 1 })} onClick={() => { chain().toggleHeading({ level: 1 }).run(); setOpen(false); }} />
            <Item icon={Heading2} label={tt('notebooks.heading_2', 'Heading 2')} active={editor.isActive('heading', { level: 2 })} onClick={() => { chain().toggleHeading({ level: 2 }).run(); setOpen(false); }} />
            <Item icon={Heading3} label={tt('notebooks.heading_3', 'Heading 3')} active={editor.isActive('heading', { level: 3 })} onClick={() => { chain().toggleHeading({ level: 3 }).run(); setOpen(false); }} />
            <MenuDivider />
            <Item icon={List} label={tt('notebooks.bullet_list', 'Bullet list')} active={editor.isActive('bulletList')} onClick={() => { chain().toggleBulletList().run(); setOpen(false); }} />
            <Item icon={ListOrdered} label={tt('notebooks.numbered_list', 'Numbered list')} active={editor.isActive('orderedList')} onClick={() => { chain().toggleOrderedList().run(); setOpen(false); }} />
            <Item icon={CheckSquare} label={tt('notebooks.task_list', 'Task list')} active={editor.isActive('taskList')} onClick={() => { chain().toggleTaskList().run(); setOpen(false); }} />
            <Item icon={Quote} label={tt('notebooks.blockquote', 'Quote')} active={editor.isActive('blockquote')} onClick={() => { chain().toggleBlockquote().run(); setOpen(false); }} />
          </>
        )}
      </Dropdown>

      {/* Alignment */}
      <Dropdown trigger={(open, setOpen) => (
        <button onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }} className={`flex items-center gap-0.5 p-1.5 rounded-md ${align('center') || align('right') ? 'text-[var(--accent-primary)] bg-[var(--accent-primary)]/10' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`} title={tt('notebooks.alignment', 'Alignment')}>
          <AlignLeft className="w-3.5 h-3.5" /><ChevronDown className="w-2.5 h-2.5 opacity-50" />
        </button>
      )}>
        {(setOpen) => (
          <>
            <Item icon={AlignLeft} label={tt('notebooks.align_left', 'Align left')} active={align('left')} onClick={() => { chain().setTextAlign('left').run(); setOpen(false); }} />
            <Item icon={AlignCenter} label={tt('notebooks.align_center', 'Center')} active={align('center')} onClick={() => { chain().setTextAlign('center').run(); setOpen(false); }} />
            <Item icon={AlignRight} label={tt('notebooks.align_right', 'Align right')} active={align('right')} onClick={() => { chain().setTextAlign('right').run(); setOpen(false); }} />
          </>
        )}
      </Dropdown>

      {/* Colour / highlight / font */}
      <Dropdown trigger={(open, setOpen) => (
        <button onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }} className={`flex items-center gap-1 p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] ${currentColor || currentFont ? 'bg-[var(--accent-primary)]/10' : ''}`} title={tt('notebooks.text_style', 'Text style')}>
          <Palette className="w-3.5 h-3.5" style={{ color: currentColor || 'currentColor' }} /><ChevronDown className="w-2.5 h-2.5 opacity-50" />
        </button>
      )}>
        {(setOpen) => (
          <div className="p-2.5" style={{ minWidth: 208 }}>
            <MenuLabel>{tt('notebooks.text_color', 'Text color')}</MenuLabel>
            <div className="grid grid-cols-8 gap-1 mb-1.5">
              {PALETTE.map((c) => (
                <button key={c} onMouseDown={(e) => { e.preventDefault(); chain().setColor(c).run(); }} className="w-5 h-5 rounded-md border hover:scale-110 transition-transform" style={{ background: c, borderColor: currentColor === c ? 'white' : 'transparent', boxShadow: currentColor === c ? `0 0 0 2px ${c}` : 'none' }} />
              ))}
            </div>
            <div className="flex items-center justify-between mb-2">
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input type="color" value={currentColor || '#000000'} onChange={(e) => chain().setColor(e.target.value).run()} className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent p-0" />
                {tt('notebooks.custom', 'Custom')}
              </label>
              <button onMouseDown={(e) => { e.preventDefault(); chain().unsetColor().run(); }} className="text-[10px]" style={{ color: 'var(--text-muted)' }}>✕ {tt('notebooks.reset', 'Reset')}</button>
            </div>
            <MenuLabel>{tt('notebooks.highlight', 'Highlight')}</MenuLabel>
            <div className="grid grid-cols-8 gap-1 mb-1.5">
              {HIGHLIGHTS.map((c) => (
                <button key={c} onMouseDown={(e) => { e.preventDefault(); chain().toggleHighlight({ color: c }).run(); }} className="w-5 h-5 rounded-md border hover:scale-110 transition-transform" style={{ background: c, borderColor: 'transparent' }} />
              ))}
            </div>
            <MenuLabel>{tt('notebooks.font', 'Font')}</MenuLabel>
            <div className="max-h-[150px] overflow-y-auto custom-scrollbar -mx-1">
              {FONT_FAMILIES.map((f) => (
                <button key={f.label} onMouseDown={(e) => { e.preventDefault(); f.value ? chain().setFontFamily(f.value).run() : chain().unsetFontFamily().run(); setOpen(false); }} className={`flex items-center w-full px-2 py-1 text-[11px] rounded hover:bg-[var(--bg-tertiary)] ${f.value === currentFont ? 'text-[var(--accent-primary)] font-semibold' : 'text-[var(--text-secondary)]'}`} style={{ fontFamily: f.css }}>{f.label}</button>
              ))}
            </div>
          </div>
        )}
      </Dropdown>

      {askAiEnabled && (
        <>
          <BubbleDivider />
          {[['rewrite', RefreshCw, tt('notebooks.ai_action_rewrite', 'Rewrite')], ['shorten', Scissors, tt('notebooks.ai_action_shorten', 'Shorten')], ['expand', Expand, tt('notebooks.ai_action_expand', 'Expand')]].map(([k, Icon, label]) => (
            <button key={k} onClick={() => onAction(k)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-secondary)' }}>
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
          <button onClick={() => onAsk({ top: rect.top, left: rect.left }, view.selectionFlat?.()?.from ?? 0, view.selectionFlat?.()?.to ?? 0, selectionText(view))}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px]" style={{ color: 'var(--accent-primary)' }}>
            <Wand2 className="w-3 h-3" /> {tt('notebooks.ask_ai', 'Ask AI')}
          </button>
        </>
      )}
    </div>
  );
}

function ImageBubble({ view, node }) {
  const rect = useNodeRect(view, node);
  if (!rect) return null;
  const attrs = node.attrs || {};
  const setAttr = (a) => view.updateAtom(node, a);
  const width = (pct) => { const w = pct === 100 ? null : Math.round(((view.host.clientWidth - 40) * pct) / 100); setAttr({ width: w }); };
  return (
    <div className="fixed z-[9998] flex items-center gap-0.5 px-1.5 py-1 rounded-xl shadow-xl border backdrop-blur-md"
      style={{ top: rect.top - 44, left: rect.left, background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
      onMouseDown={(e) => e.preventDefault()}>
      {['left', 'center', 'right'].map((al) => {
        const Icon = al === 'left' ? AlignLeft : al === 'center' ? AlignCenter : AlignRight;
        return <button key={al} onClick={() => setAttr({ alignment: al })} className={`p-1.5 rounded-lg ${(attrs.alignment || 'center') === al ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}><Icon className="w-3.5 h-3.5" /></button>;
      })}
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
      <button onClick={() => setAttr({ textWrap: !attrs.textWrap })} className={`p-1.5 rounded-lg ${attrs.textWrap ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}><WrapText className="w-3.5 h-3.5" /></button>
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
      {[25, 50, 75, 100].map((p) => {
        const full = view.host ? view.host.clientWidth - 40 : 0;
        const cur = attrs.width || (full || null);
        const activePct = !attrs.width ? 100 : (full ? Math.round((attrs.width / full) * 100) : null);
        const isActive = activePct != null && Math.abs(activePct - p) <= 4;
        return <button key={p} title={`${p}%`} onClick={() => width(p)} className={`px-1.5 py-1 rounded-lg text-[10px] font-semibold ${isActive ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}>{p}%</button>;
      })}
      <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
      <button onClick={() => view.deleteAtom(node)} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
    </div>
  );
}

function AskPortal({ ask, query, setQuery, onSubmit, onClose, t }) {
  const inputRef = useRef(null);
  const tt = mkTt(t);
  useEffect(() => { const id = requestAnimationFrame(() => inputRef.current?.focus()); return () => cancelAnimationFrame(id); }, []);
  useEffect(() => {
    const h = (e) => { const p = document.querySelector('[data-ask-portal]'); if (p && !p.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  const preview = (ask.text || '').slice(0, 120);
  // Clamp to the viewport: keep within the right edge, and drop below the
  // selection when there isn't room above (mirrors the old editor).
  const W = 360;
  const left = Math.max(8, Math.min(ask.anchor.left, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8));
  const above = ask.anchor.top - 52;
  const top = above < 8 ? ask.anchor.top + 24 : above;
  return (
    <div data-ask-portal className="fixed z-[9999] flex flex-col rounded-xl shadow-2xl border backdrop-blur-md overflow-hidden"
      style={{ top, left, minWidth: 280, maxWidth: W, background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
      onMouseDown={(e) => e.stopPropagation()}>
      {preview && (
        <div className="px-3 pt-2 pb-1.5 text-[10px] border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          <div className="text-[9px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{tt('notebooks.selected_text', 'Selected text')}</div>
          <p className="italic line-clamp-3">{preview}</p>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Wand2 className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
        <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tt('notebooks.ask_ai_placeholder', 'Ask me…')}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } else if (e.key === 'Escape') onClose(); }}
          className="bg-transparent border-none outline-none text-[11px] w-[200px] text-[var(--text-primary)]" />
        <button onMouseDown={(e) => { e.preventDefault(); onSubmit(); }} className="px-2 py-1 rounded-lg text-[10px] font-bold bg-[var(--accent-primary)] text-white" disabled={!query.trim()}>{tt('notebooks.send', 'Send')}</button>
        <button onMouseDown={(e) => { e.preventDefault(); onClose(); }} className="px-1.5 py-1 text-[var(--text-tertiary)]">×</button>
      </div>
    </div>
  );
}

function GeneratingOverlay({ label, t }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(127,127,127,0.06)' }}>
      <div className="flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border text-sm font-semibold" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}>
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent-primary)' }} />
        <span>{t('editor.generating', 'Generating {what}…', { what: String(label).replace(/_/g, ' ') })}</span>
        <span className="flex gap-0.5">
          {[0, 1, 2].map((i) => <span key={i} className="w-1 h-1 rounded-full animate-bounce" style={{ background: 'var(--accent-primary)', animationDelay: `${i * 120}ms` }} />)}
        </span>
      </div>
    </div>
  );
}

/* ── table add-row / add-column controls ─────────────────── */
// Floating "+" affordances glued to the right edge (add column) and bottom edge
// (add row) of the table the caret is in. Re-measures on scroll/resize and when
// the table node changes (after an append). Appends always go to the table end.
/**
 * Per-visual-column and per-row screen geometry for a rendered table.
 *
 * Derived from the DOM rather than assumed, because colspan/rowspan mean a
 * row's array index is not its column number. For each visual column we look
 * for a cell that starts there and is exactly one column wide; if the whole
 * column is spanned we fall back to slicing a spanning cell evenly.
 */
function tableGeometry(tableEl, node) {
  if (!tableEl || !node) return null;
  const { grid, rows, cols } = tableGrid(node);
  // :scope keeps rows of a nested table (legacy artifact) out of the outer
  // table's geometry — unscoped, every nested row inflated rowY and misplaced
  // the row gutter and overlays (S8).
  const rowEls = Array.from(tableEl.querySelectorAll(':scope > tbody > tr'));
  if (!rowEls.length || !cols) return null;

  const colX = new Array(cols).fill(null);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const e = grid[r]?.[c];
      if (!e) continue;
      const el = rowEls[e.rowIdx]?.children?.[e.cellIdx];
      if (!el) continue;
      const box = el.getBoundingClientRect();
      const span = Math.max(1, parseInt(e.cell?.attrs?.colspan, 10) || 1);
      if (span === 1 && e.originC === c) { colX[c] = { left: box.left, width: box.width }; break; }
      // Spanned: take this column's share of the spanning cell.
      if (!colX[c]) colX[c] = { left: box.left + ((c - e.originC) * box.width) / span, width: box.width / span };
    }
  }
  const rowY = rowEls.map((el) => { const b = el.getBoundingClientRect(); return { top: b.top, height: b.height }; });
  return { colX, rowY, cols, rows, grid };
}

/** Column label: ALWAYS the spreadsheet letter — `A · headertext` when the
 *  table has a header row — so a formula's `A1` has a visible anchor even on
 *  tables with named headers. */
function columnName(node, grid, c) {
  const letter = colLabel(c);
  const head = grid[0]?.[c];
  if (head?.cell?.attrs?.header) {
    const text = [];
    const walk = (n) => { if (!n) return; if (n.type === 'text') text.push(n.text || ''); (n.content || []).forEach(walk); };
    walk(head.cell);
    const s = text.join('').trim();
    if (s) return `${letter} · ${s}`;
  }
  return letter;
}

// Exported for TableControls.test.jsx: the crash in BFSF-351 lived in the two
// gutter .map()s below, and reaching them from a full BeeEditor mount would mean
// driving a real caret into a real table.
export function TableControls({ view, info, t, collapsed, onToggleCollapse, headersHidden }) {
  const tt = mkTt(t);
  const [rect, setRect] = useState(null);
  const [geom, setGeom] = useState(null);
  // Top of the editable area — the column strip sits above the table and must
  // not be drawn over the toolbar when a table is the very first block.
  const [hostTop, setHostTop] = useState(null);
  useEffect(() => {
    if (!view || !info?.el) { setRect(null); setGeom(null); return undefined; }
    const measure = () => {
      const r = info.el.getBoundingClientRect();
      if (!r.width && !r.height) { setRect(null); setGeom(null); return; }
      setRect({ top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
      setGeom(collapsed ? null : tableGeometry(info.el, info.node));
      try { setHostTop(view.host.getBoundingClientRect().top); } catch (e) { setHostTop(null); }
    };
    measure();
    const scroller = view.host?.closest('.overflow-y-auto') || window;
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { scroller.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [view, info?.el, info?.node, collapsed, headersHidden]);
  if (!rect) return null;
  const run = (cmd) => view.chain().focus()[cmd]().run();
  const dispatch = (fn, kind = 'structural') => view.dispatch(fn, { kind });
  const btn = 'fixed z-[60] flex items-center justify-center rounded-md border shadow-sm transition-colors hover:text-white hover:bg-[var(--accent-primary)] hover:border-[var(--accent-primary)]';
  const style = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' };
  const rows = info.node?.content?.length || 0;
  return (
    <>
      {/* collapse / expand chevron in the left gutter */}
      <button type="button" title={collapsed ? tt('notebooks.expand_table', 'Expand table') : tt('notebooks.collapse_table', 'Collapse table')}
        onMouseDown={(e) => { e.preventDefault(); onToggleCollapse?.(); }}
        className={btn} style={{ ...style, top: rect.top + 2, left: rect.left - 26, width: 22, height: 22 }}>
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {collapsed ? (
        <span className="fixed z-[60] px-2 py-0.5 rounded-md border shadow-sm text-[10px] font-medium"
          style={{ ...style, top: rect.top + 2, left: rect.right + 6 }}>
          {tt('notebooks.rows_collapsed', '{n} rows').replace('{n}', String(rows))}
        </span>
      ) : (
        <>
          <button type="button" title={tt('notebooks.add_column', 'Add column')} aria-label={tt('notebooks.add_column', 'Add column')}
            onMouseDown={(e) => { e.preventDefault(); run('appendColumn'); }}
            className={btn} style={{ ...style, top: rect.top + rect.height / 2 - 11, left: rect.right + 4, width: 22, height: 22 }}>
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button type="button" title={tt('notebooks.add_row', 'Add row')} aria-label={tt('notebooks.add_row', 'Add row')}
            onMouseDown={(e) => { e.preventDefault(); run('appendRow'); }}
            className={btn} style={{ ...style, top: rect.bottom + 4, left: rect.left + rect.width / 2 - 11, width: 22, height: 22 }}>
            <Plus className="w-3.5 h-3.5" />
          </button>

          {/* ── Column-name strip ──
              Shows the header cell's text when the table has one, otherwise the
              spreadsheet letter, so a formula's A1 always has a visible anchor.
              Click selects the column; the × deletes it; while a formula editor
              is open a click inserts a whole-column reference instead. */}
          {!headersHidden && geom && hostTop != null && rect.top - 20 >= hostTop && geom.colX.map((col, c) => col && (
            <div key={`c${c}`} className="bf-table-colhead group/col"
              style={{ position: 'fixed', zIndex: 59, top: rect.top - 20, left: col.left, width: col.width, height: 18 }}
              onMouseDown={(e) => {
                e.preventDefault();
                if (view.refPick) {
                  const tp = view.refPick.tablePath;
                  if (!tp || tp.join() === info.path.join()) { view.refPick.onPick?.(Tbl.columnRef(c)); view.refPick.onCommitPick?.(); }
                  return;
                }
                dispatch((s) => Tbl.selectColumn(s, info.path, c), 'selection');
              }}
              title={tt('notebooks.select_column', 'Select column')}
            >
              <span className="bf-table-colhead-label">{columnName(info.node, geom.grid, c)}</span>
              <button type="button" className="bf-table-gutter-sum opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
                title={tt('notebooks.sum_column', 'Sum column')} aria-label={tt('notebooks.sum_column', 'Sum column')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dispatch((s) => Tbl.addColumnTotal(s, info.path, c)); }}>
                Σ
              </button>
              <button type="button" className="bf-table-gutter-del opacity-0 group-hover/col:opacity-100 focus-visible:opacity-100"
                title={tt('notebooks.delete_col', 'Delete column')} aria-label={tt('notebooks.delete_col', 'Delete column')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dispatch((s) => Tbl.deleteColumnAt(s, info.path, c)); }}>
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}

          {/* ── Row gutter ── click selects the row, × deletes it. */}
          {geom && geom.rowY.map((row, r) => (
            <div key={`r${r}`} className="bf-table-rowhead group/row"
              style={{ position: 'fixed', zIndex: 59, top: row.top, left: rect.left - 22, width: 20, height: row.height }}
              onMouseDown={(e) => { e.preventDefault(); dispatch((s) => Tbl.selectRow(s, info.path, r), 'selection'); }}
              title={tt('notebooks.select_row', 'Select row')}
            >
              <span className="bf-table-rowhead-label">{r + 1}</span>
              <button type="button" className="bf-table-gutter-del opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                title={tt('notebooks.delete_row', 'Delete row')} aria-label={tt('notebooks.delete_row', 'Delete row')}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dispatch((s) => Tbl.deleteRowAt(s, info.path, r)); }}>
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/* ── collapse persistence (view-only; never serialized) ──── */
function loadCollapsed(notebookId) {
  try { return new Set(JSON.parse(localStorage.getItem(`bf.table.collapsed.${notebookId || 'doc'}`) || '[]')); }
  catch (e) { return new Set(); }
}
function saveCollapsed(notebookId, set) {
  try { localStorage.setItem(`bf.table.collapsed.${notebookId || 'doc'}`, JSON.stringify([...set])); }
  catch { /* noop */ }
}
function loadHiddenHeaders(notebookId) {
  try { return new Set(JSON.parse(localStorage.getItem(`bf.table.noheaders.${notebookId || 'doc'}`) || '[]')); }
  catch (e) { return new Set(); }
}
function saveHiddenHeaders(notebookId, set) {
  try { localStorage.setItem(`bf.table.noheaders.${notebookId || 'doc'}`, JSON.stringify([...set])); }
  catch { /* noop */ }
}

/* ── hooks & helpers ────────────────────────────────────── */
function useNodeRect(view, node) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!view) return undefined;
    const update = () => {
      const el = view.domForNode.get(node);
      if (el) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left + 8 }); }
    };
    update();
    // Keep the bubble glued to the image while the document scrolls / resizes.
    const scroller = view.host?.closest('.overflow-y-auto') || window;
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { scroller.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [view, node]);
  return rect;
}

function selectionText(view) {
  if (!view) return '';
  const sel = view.state.selection;
  if (sel.type !== 'text') return '';
  const dsel = window.getSelection();
  return dsel ? dsel.toString() : '';
}

/** Screen box of the DOM selection (anchors the link bubble and editor). */
function selectionRect() {
  try {
    const dsel = window.getSelection();
    if (!dsel || !dsel.rangeCount) return null;
    const r = dsel.getRangeAt(0).getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0)) return null;
    return { top: r.top, left: r.left, bottom: r.bottom };
  } catch (e) {
    return null;
  }
}

/**
 * Where to anchor a popover when the selection has no box of its own (a caret
 * on an empty line, or an engine without Range geometry): the current block,
 * else the top of the editor.
 */
function blockRect(view) {
  try {
    const block = view.currentBlock?.();
    const el = (block && view.domForNode.get(block)) || view.host;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: el === view.host ? r.top + 24 : r.bottom };
  } catch {
    return { top: 120, left: 120, bottom: 144 };
  }
}

/** An uploaded image's address the editor will embed: same-origin or http(s). */
// A picture carried inside the document (a page embeds its images, since the
// PDF renderer fetches nothing): raster types only, and about 300 KB of image
// at most, which is roughly 410 KB of base64.
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_DATA_IMAGE_CHARS = 410 * 1024;

function isSafeImageSrc(src) {
  const s = typeof src === 'string' ? src : '';
  if (!s) return false;
  if (s.startsWith('/') || /^https?:\/\//i.test(s)) return true;
  return s.length <= MAX_DATA_IMAGE_CHARS && DATA_IMAGE.test(s);
}

/** The notebook image endpoint (the default uploader when a notebookId is set). */
async function uploadNotebookImage(nbId, file) {
  const fd = new FormData();
  fd.append('image', file);
  // authFetch, not the global fetch: the bare call bypassed the demo-mode
  // transport, so an image paste inside a public feature demo escaped the
  // fixture layer and hit the real API unauthenticated.
  const res = await authFetch(`${API_BASE}/api/notebooks/${encodeURIComponent(nbId)}/images`, { method: 'POST', body: fd, credentials: 'include' });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  const data = await res.json();
  return data?.url ? { src: `${API_BASE}${data.url}`, alt: file.name } : null;
}

/**
 * Whether a co-editor's caret sits inside top-level blocks [from, from+count):
 * moving that part would delete and re-insert it under their fingers.
 */
function peerInBlocks(binding, peers, from, count) {
  if (!binding || !peers?.length) return false;
  for (const p of peers) {
    if (!p.cursor) continue;
    const at = binding.relToPos(p.cursor.head);
    if (at && at.path[0] >= from && at.path[0] < from + count) return true;
  }
  return false;
}

export default BeeEditor;
