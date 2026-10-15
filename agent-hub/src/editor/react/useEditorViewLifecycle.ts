import { useCallback, useEffect } from 'react';
import { errorName } from '../../utils/caughtError';
import type { BeeEditorProps, EditorShared } from './beeEditorTypes';
import { contentToDoc } from './contentPipeline';
import { chainOf } from './beeEditorHelpers';
import { isSafeImageSrc, uploadNotebookImage } from './imageUpload';
import type { EditorSync } from './useEditorSync';

/**
 * Applying external content changes, the placeholder and image upload: the
 * hooks of BeeEditor that follow its mount effect (mountEditorView), in the
 * order the body always declared them.
 */
export default function useEditorViewLifecycle(s: EditorShared, props: BeeEditorProps, sync: EditorSync) {
  const { content, placeholder } = props;
  const { t, hostRef, viewRef, saveTimer, lastHtmlRef, notebookIdRef, setUploadError, uploadError, onUploadImageRef } = s;
  const { collab, effectiveEditable, refreshChrome } = sync;

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
