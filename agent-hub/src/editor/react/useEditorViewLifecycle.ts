import { useCallback, useEffect } from 'react';
import { errorName } from '../../utils/caughtError';
import { createState } from '../engine/state.js';
import { EditorView } from '../engine/view.js';
import { htmlToAst } from '../serialization/htmlToAst.js';
import type { AtomHost, BeeEditorProps, EditorShared } from './beeEditorTypes';
import { contentToDoc } from './contentPipeline';
import { chainOf } from './beeEditorHelpers';
import { makeFacade } from './editorFacade';
import { isSafeImageSrc, uploadNotebookImage } from './imageUpload';
import { matchShortcut } from './shortcuts';
import type { EditorSync } from './useEditorSync';

/** The image of a paste/drop payload, handed to `upload`; false when it carries none. */
function imageFromTransfer(dt: DataTransfer | null | undefined, upload: (file: File) => void): boolean {
  const list: ArrayLike<DataTransferItem | File> = dt?.items || dt?.files || [];
  const items = Array.from(list);
  const img = items.find((i) => (i.type || '').startsWith('image/'));
  if (!img) return false;
  const file = 'getAsFile' in img ? img.getAsFile() : img;
  if (file) upload(file);
  return true;
}

/**
 * Creating and destroying the EditorView, applying external content changes,
 * the placeholder and image upload: the fourth block of hooks of BeeEditor, in
 * the order the body always declared them. The view's lifecycle (creation,
 * listeners, destroy and cleanup order) is the mount effect below, unchanged.
 */
export default function useEditorViewLifecycle(s: EditorShared, props: BeeEditorProps, sync: EditorSync) {
  const { content, placeholder, editable = true } = props;
  const { t, hostRef, viewRef, facadeRef, setViewInst, setAtoms, saveTimer, lastHtmlRef, contentGenRef, notebookIdRef, onSaveRef, runShortcutRef, setUploadError, uploadError, onUploadImageRef } = s;
  const { chromeRef, collab, collabRef, effectiveEditable, refreshChrome } = sync;

  /* mount the view once */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let nextAtomId = 1;
    const view = new EditorView(host, {
      state: createState(contentToDoc(content)),
      editable,
      htmlToAst: (html: string) => htmlToAst(html),
      mountAtom: (node: AtomHost['__bfAtomNode'], hostEl: AtomHost) => {
        hostEl.__bfAtomNode = node;
        const id = nextAtomId++;
        hostEl.__bfAtomId = id;
        if (node) setAtoms((a) => [...a, { host: hostEl, node, id }]);
      },
      unmountAtom: (hostEl: AtomHost) => setAtoms((a) => a.filter((x) => x.host !== hostEl)),
      // Re-point an atom's portal at the new node (attr change) WITHOUT unmounting,
      // so the mermaid/math view keeps its DOM + internal state (no flicker/reset).
      remapAtom: (hostEl: AtomHost, n: NonNullable<AtomHost['__bfAtomNode']>) => { hostEl.__bfAtomNode = n; setAtoms((a) => a.map((x) => (x.host === hostEl ? { ...x, node: n } : x))); },
      onUpdate: (meta?: { remote?: boolean }) => {
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
              console.error('[BeeEditor] could not serialise the document — it was not saved', errorName(e) || 'Error');
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
    const onPaste = (e: ClipboardEvent) => { if (imageFromTransfer(e.clipboardData, uploadImage)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    const onDrop = (e: DragEvent) => { if (imageFromTransfer(e.dataTransfer, uploadImage)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('drop', onDrop, true);
    // Shortcuts beyond the engine's own (bold/italic/underline/undo/redo).
    const onKeyDown = (e: KeyboardEvent) => {
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

  useEffect(() => { viewRef.current?.setEditable(effectiveEditable); }, [effectiveEditable, s.viewInst]);

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
  const uploadImage = useCallback(async (file: File) => {
    if (!file || !/^image\//.test(file.type)) return;
    const nbId = notebookIdRef.current;
    const upload = onUploadImageRef.current || (nbId ? (f: File) => uploadNotebookImage(nbId, f) : null);
    if (!upload) return;
    try {
      const result = await upload(file);
      if (result === null) return;
      if (!isSafeImageSrc(result?.src)) { setUploadError(true); return; }
      setUploadError(false);
      const view = viewRef.current;
      if (view) chainOf(view).focus().setImage({ src: String(result?.src), alt: result?.alt || file.name }).run();
    } catch (err) {
      console.error('[BeeEditor] image upload failed', errorName(err) || 'Error');
      setUploadError(true);
    }
  }, []);
  useEffect(() => {
    if (!uploadError) return undefined;
    const timer = setTimeout(() => setUploadError(false), 6000);
    return () => clearTimeout(timer);
  }, [uploadError]);

  return { uploadImage };
}
