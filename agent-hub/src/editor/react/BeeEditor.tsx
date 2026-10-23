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
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { buildEditorHandle } from './beeEditorHandle';
import BeeEditorView from './BeeEditorView';
import { mountEditorView } from './mountEditorView';
import { peerInBlocks } from './peerLocks';
import SectionDragLayer from './SectionDragLayer';
import { TableControls } from './TableControls';
import useBeeEditorState from './useBeeEditorState';
import useEditorInteractions from './useEditorInteractions';
import useEditorSync from './useEditorSync';
import useEditorTableView from './useEditorTableView';
import useEditorViewLifecycle from './useEditorViewLifecycle';
import '../editor.css';
import 'katex/dist/katex.min.css';
import type { BeeEditorProps } from './beeEditorTypes';

/* ── main component ─────────────────────────────────────── */
// The body is split over hooks that are called in the order it always declared
// them (state, sync, table view, view lifecycle, ref API, interactions).
const BeeEditor = forwardRef(function BeeEditor(props: BeeEditorProps, ref) {
  const s = useBeeEditorState(props);
  const sync = useEditorSync(s, props);
  const tableView = useEditorTableView(s, props.notebookId, sync.refreshChrome);

  /* mount the view once */
  useEffect(() => mountEditorView({
    host: s.hostRef.current as HTMLDivElement,
    content: props.content,
    editable: props.editable,
    s,
    sync,
    // Declared below by the lifecycle hook; only called after mount.
    uploadImage: (file) => uploadImage(file),
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the ProseMirror view is created once per mount; later prop changes are applied by the effects below
  []);

  const { uploadImage } = useEditorViewLifecycle(s, props, sync);

  /* imperative ref API (parity + setMarkdown fix) */
  useImperativeHandle(ref, () => buildEditorHandle({ s, sync }), [sync.refreshChrome]);

  const ix = useEditorInteractions(s, props, sync, sync.refreshChrome);

  const { collab } = sync;
  const dragLayer = (
    <SectionDragLayer hostRef={s.hostRef} viewRef={s.viewRef} isLocked={collab.bound ? (from: number, count: number) => peerInBlocks(collab.binding, props.collab?.peers, from, count) : null} />
  );

  return <BeeEditorView s={s} props={props} sync={sync} ix={ix} tableView={tableView} uploadImage={uploadImage} dragLayer={dragLayer} />;
});

// TableControls lives in ./TableControls; still exported here for callers that imported it from this module.
export { TableControls };

export default BeeEditor;
