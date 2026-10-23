import { useRef, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import type { EditorView } from '../engine/view';
import type { AskState, AtomEntry, BeeEditorProps, ChartConfig, EditorShared, LinkEditState } from './beeEditorTypes';
import type { EditorFacade } from './editorFacade';
import { loadCollapsed, loadHiddenHeaders } from './tableViewState';

/**
 * The refs and state BeeEditor starts with. The first hooks of the component,
 * in the order the body always declared them.
 */
export default function useBeeEditorState(props: BeeEditorProps): EditorShared {
  const { onUploadImage, notebookId } = props;

  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The view as state as well, so hooks that need it (co-editing, find, anchors) re-run once it exists.
  const [viewInst, setViewInst] = useState<EditorView | null>(null);
  // The positioned wrapper around the host: overlays are measured against it.
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  // Bumped after every flushed document change: overlays re-measure on it.
  const [tick, setTick] = useState(0);
  const [linkEdit, setLinkEdit] = useState<LinkEditState | null>(null); // { rect, href, canRemove, doc, selection } | null
  const linkEditRef = useRef<LinkEditState | null>(null);
  linkEditRef.current = linkEdit;
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const onUploadImageRef = useRef(onUploadImage);
  onUploadImageRef.current = onUploadImage;
  // Assigned every render; the host's keydown listener calls through it.
  const runShortcutRef = useRef<(action: string) => boolean>(() => false);
  const facadeRef = useRef<EditorFacade | null>(null);
  const notebookIdRef = useRef(notebookId);
  const lastHtmlRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // contentGen increments on every external content swap (notebook switch / restore /
  // AI update). A debounced save captures the gen + notebook id at schedule time and
  // only fires if both still match — so a pending save from notebook A can never write
  // A's content into notebook B after a switch.
  const contentGenRef = useRef(0);
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  const [atoms, setAtoms] = useState<AtomEntry[]>([]);
  const [wordCount, setWordCount] = useState(0);
  const [ask, setAsk] = useState<AskState | null>(null); // {anchor:{top,left}, from, to, text}
  const [askQuery, setAskQuery] = useState('');
  const [chartConfig, setChartConfig] = useState<ChartConfig | null>(null); // { columns, rows } | null
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(notebookId)); // Set<ordinal>
  // Which tables have their column-name strip hidden. View-only, like collapse.
  const [hiddenHeaders, setHiddenHeaders] = useState(() => loadHiddenHeaders(notebookId)); // Set<ordinal>

  return {
    t, hostRef, viewRef, viewInst, setViewInst, wrapEl, setWrapEl, tick, setTick,
    linkEdit, setLinkEdit, linkEditRef, findOpen, setFindOpen, findFocus, setFindFocus,
    shortcutsOpen, setShortcutsOpen, uploadError, setUploadError, onUploadImageRef,
    runShortcutRef, facadeRef, notebookIdRef, lastHtmlRef, saveTimer, imageInputRef,
    contentGenRef, onChangeRef, onSaveRef, atoms, setAtoms, wordCount, setWordCount,
    ask, setAsk, askQuery, setAskQuery, chartConfig, setChartConfig,
    collapsed, setCollapsed, hiddenHeaders, setHiddenHeaders,
  };
}
