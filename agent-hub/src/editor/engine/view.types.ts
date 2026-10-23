import type { EditorState } from './state.js';
import type { DocNode } from '../model/schema.js';

/** A hook-callback argument: a state, or the small meta object a hook receives. */
export type HookArg = EditorState | { source: string } | { kind: string } | undefined;

/** A co-editing plugin: any subset of the hook callbacks (see the header). */
export interface ViewPlugin { [hook: string]: ((...args: HookArg[]) => void) | undefined }

/** An external undo manager (per-user undo while co-editing). */
export interface UndoProvider { undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean; stopCapturing(): void }

/** What formula reference picking hands the view (see beginRefPick). */
export interface RefPickHandlers { tablePath?: number[] | null; onPick?(ref: string): void; onCommitPick?(): void }

/** A node a node view hands back to identify its atom: attrs of any shape, not only DocAttrs. */
export interface AtomNode { type: string; attrs?: object }

export interface EditorViewOptions {
  state?: EditorState;
  editable?: boolean;
  onUpdate?(meta?: { remote?: boolean }): void;
  onSelectionChange?(state: EditorState): void;
  onError?: ((e: unknown) => void) | null;
  htmlToAst?: ((html: string) => DocNode) | null;
  plugins?: ViewPlugin[];
  mountAtom?(node: DocNode, host: HTMLElement): void;
  unmountAtom?(el: Element): void;
  remapAtom?(el: Element, node: DocNode): void;
}

/** Where resolveAtom found an atom: a block by path, an inline atom by path plus offset. */
export type AtomResolution = { inline: false; path: number[] } | { inline: true; path: number[]; offset: number };
