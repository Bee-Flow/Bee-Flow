import { errorName } from '../../utils/caughtError';
import { createState } from '../engine/state.js';
import { EditorView } from '../engine/view';
import { htmlToAst } from '../serialization/htmlToAst';
import type { AtomNode } from './AtomRenderer';
import type { AtomHost, BeeEditorProps, EditorShared } from './beeEditorTypes';
import { contentToDoc } from './contentPipeline';
import { makeFacade } from './editorFacade';
import { matchShortcut } from './shortcuts';
import type { EditorSync } from './useEditorSync';
import { logger } from '../../utils/logger';

/** The image of a paste/drop payload, handed to `upload`; false when it carries none. */
export function imageFromTransfer(dt: DataTransfer | null | undefined, upload: (file: File) => void): boolean {
  const list: ArrayLike<DataTransferItem | File> = dt?.items || dt?.files || [];
  const items = Array.from(list);
  const img = items.find((i) => (i.type || '').startsWith('image/'));
  if (!img) return false;
  const file = 'getAsFile' in img ? img.getAsFile() : img;
  if (file) upload(file);
  return true;
}

export interface MountEditorViewDeps {
  host: HTMLDivElement;
  content: BeeEditorProps['content'];
  editable?: boolean;
  s: EditorShared;
  sync: EditorSync;
  uploadImage: (file: File) => void;
}

/**
 * Create the EditorView on the host and wire it up; returns the teardown.
 * BeeEditor.jsx runs it from a `useEffect(..., [])` (the view is created once
 * per mount), so the effect stays under the react-hooks lint rules.
 */
export function mountEditorView(deps: MountEditorViewDeps): () => void {
  const { host, content, editable = true, s, sync } = deps;
  const { viewRef, facadeRef, setViewInst, setAtoms, saveTimer, lastHtmlRef, contentGenRef, notebookIdRef, onSaveRef, runShortcutRef } = s;
  const { chromeRef, collabRef } = sync;
  let nextAtomId = 1;
  const view = new EditorView(host, {
    state: createState(contentToDoc(content)),
    editable,
    htmlToAst: (html: string) => htmlToAst(html),
    mountAtom: (node: AtomNode, hostEl: AtomHost) => {
      hostEl.__bfAtomNode = node;
      const id = nextAtomId++;
      hostEl.__bfAtomId = id;
      setAtoms((a) => [...a, { host: hostEl, node, id }]);
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
  const onPaste = (e: ClipboardEvent) => { if (imageFromTransfer(e.clipboardData, deps.uploadImage)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  const onDrop = (e: DragEvent) => { if (imageFromTransfer(e.dataTransfer, deps.uploadImage)) { e.preventDefault(); e.stopImmediatePropagation(); } };
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
    try { host.textContent = ''; } catch (err) { logger.debug('noop', err); }
    setAtoms([]);
    viewRef.current = null;
    facadeRef.current = null;
    setViewInst(null);
  };
}
