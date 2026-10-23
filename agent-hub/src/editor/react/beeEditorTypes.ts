/**
 * Shared types of BeeEditor and the hooks it is built from. The hooks are
 * called by BeeEditor in a fixed order (see BeeEditor.jsx): they only split
 * the component's body, the order of the hooks and their dependency arrays
 * are the ones the body always had.
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { CollabHandle } from '../collab/useCollab';
import type { EditorView } from '../engine/view';
import type { Selection } from '../engine/selection.js';
import type { DocNode } from '../model/schema.js';
import type { AtomNode } from './AtomRenderer';
import type { EditorFacade } from './editorFacade';
import type { TocItem } from './toc';

/** The result of an image upload: where the image lives, with its alt text. */
export interface UploadedImage { src?: unknown; alt?: string }

export interface BeeEditorProps {
  content?: string | DocNode | null;
  placeholder?: string;
  editable?: boolean;
  onChange?: (html: string, meta?: { remote?: boolean }) => void;
  onSave?: (html: string) => void;
  onAIAction?: (key: string, text: string, range: { from: number; to: number }, customQuery: string | null) => void;
  onAIFill?: () => void;
  saving?: boolean;
  onImportClick?: () => void;
  generating?: string;
  aiFilling?: boolean;
  onTocUpdate?: (items: TocItem[]) => void;
  onWordCountChange?: (n: number) => void;
  notebookId?: string | number | null;
  askAiEnabled?: boolean;
  collab?: CollabHandle | null;
  onUploadImage?: (file: File) => Promise<UploadedImage | null | undefined> | UploadedImage | null | undefined;
}

/** The element a mounted atom is drawn into (the view tags it with its node and id). */
export interface AtomHost extends HTMLElement { __bfAtomNode?: AtomNode; __bfAtomId?: number }
export interface AtomEntry { host: AtomHost; node: AtomNode; id: number }

/** The link editor popover: the selection is captured when it opens. */
export interface LinkEditState {
  rect: { top: number; left: number; bottom: number };
  href: string;
  canRemove: boolean;
  doc: DocNode;
  selection: Selection;
}

export interface AskState { anchor: { top: number; left: number }; from: number; to: number; text: string }
export interface ChartConfig { columns: string[]; rows: string[][] }
export interface SlashState { query: string; rect: { top: number; left: number }; matchLen: number }


/** The refs and state every part of BeeEditor reads (created by useBeeEditorState). */
export interface EditorShared {
  t: TranslateFn;
  hostRef: RefObject<HTMLDivElement | null>;
  viewRef: RefObject<EditorView | null>;
  viewInst: EditorView | null;
  setViewInst: Dispatch<SetStateAction<EditorView | null>>;
  wrapEl: HTMLDivElement | null;
  setWrapEl: Dispatch<SetStateAction<HTMLDivElement | null>>;
  tick: number;
  setTick: Dispatch<SetStateAction<number>>;
  linkEdit: LinkEditState | null;
  setLinkEdit: Dispatch<SetStateAction<LinkEditState | null>>;
  linkEditRef: RefObject<LinkEditState | null>;
  findOpen: boolean;
  setFindOpen: Dispatch<SetStateAction<boolean>>;
  findFocus: number;
  setFindFocus: Dispatch<SetStateAction<number>>;
  shortcutsOpen: boolean;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  uploadError: boolean;
  setUploadError: Dispatch<SetStateAction<boolean>>;
  onUploadImageRef: RefObject<BeeEditorProps['onUploadImage']>;
  runShortcutRef: RefObject<(action: string) => boolean>;
  facadeRef: RefObject<EditorFacade | null>;
  notebookIdRef: RefObject<BeeEditorProps['notebookId']>;
  lastHtmlRef: RefObject<string | null>;
  saveTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  contentGenRef: RefObject<number>;
  onChangeRef: RefObject<BeeEditorProps['onChange']>;
  onSaveRef: RefObject<BeeEditorProps['onSave']>;
  atoms: AtomEntry[];
  setAtoms: Dispatch<SetStateAction<AtomEntry[]>>;
  wordCount: number;
  setWordCount: Dispatch<SetStateAction<number>>;
  ask: AskState | null;
  setAsk: Dispatch<SetStateAction<AskState | null>>;
  askQuery: string;
  setAskQuery: Dispatch<SetStateAction<string>>;
  chartConfig: ChartConfig | null;
  setChartConfig: Dispatch<SetStateAction<ChartConfig | null>>;
  collapsed: Set<number>;
  setCollapsed: Dispatch<SetStateAction<Set<number>>>;
  hiddenHeaders: Set<number>;
  setHiddenHeaders: Dispatch<SetStateAction<Set<number>>>;
}

