import type { AstNode } from '../collab/ySchema';
import type { EditorView } from '../engine/view.js';
import type { DocNode } from '../model/schema.js';
import type { EditorChain } from './editorFacade';

/** `view.chain()` with its command surface typed (the facade does the same). */
export function chainOf(view: EditorView): EditorChain {
  return view.chain() as EditorChain;
}

type Rebase = (current: AstNode, next: AstNode) => AstNode;

/** `replaceDoc` as the engine runs it: `rebase` keeps what co-editors changed since a base. */
interface RebasingView {
  replaceDoc(doc: DocNode, opts: { emitUpdate: boolean; rebase: Rebase | null }): void;
}

export function canRebase(view: EditorView): view is EditorView & RebasingView {
  return typeof view.replaceDoc === 'function';
}
