import { useCallback, useEffect, useRef } from 'react';
import type { BeeEditorProps, EditorShared } from './beeEditorTypes';
import useEditorAnchors from './useEditorAnchors';
import useEditorChrome from './useEditorChrome';
import useEditorCollab from './useEditorCollab';

/**
 * The callback refs, the throttled chrome, co-editing and the comment anchors
 * of BeeEditor: the second block of hooks of the component, in the order the
 * body always declared them.
 */
export default function useEditorSync(s: EditorShared, props: BeeEditorProps) {
  const { editable = true, onChange, onSave, onTocUpdate, onWordCountChange, notebookId, collab: collabHandle = null } = props;
  const {
    viewRef, lastHtmlRef, viewInst, setTick, setWordCount, onChangeRef, onSaveRef,
    notebookIdRef, saveTimer, contentGenRef,
  } = s;

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
  const applyWordCount = useCallback((n: number) => { setWordCount(n); onWordCountRef.current?.(n); }, []);

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

  return { chrome, chromeRef, collab, collabRef, effectiveEditable, editableRef, anchors, anchorsRef, refreshChrome };
}

export type EditorSync = ReturnType<typeof useEditorSync>;
