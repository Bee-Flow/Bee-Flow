/**
 * editorFacade.js — a TipTap-shaped facade over an EditorView, returned by
 * BeeEditor's getEditor(). It implements only the surface the call sites and the
 * ported toolbar actually use (grep-confirmed): chain / isActive / getAttributes
 * / can / getHTML / getText / state / commands.setContent / storage.markdown.
 */
import { contentToDoc } from './contentPipeline.js';
import { astToHtml } from '../serialization/astToHtml.js';
import { markdownToAst } from '../serialization/mdToAst.js';
import type { DocAttrs, DocNode } from '../model/schema.js';
import type { EditorView } from '../engine/view.js';
import type { commands } from '../commands/index.js';

/** `editor.chain().focus().toggleBold().run()`: every command, then run(). */
export type EditorChain = {
  [K in Exclude<keyof typeof commands, 'run'>]: (...args: Parameters<(typeof commands)[K]>) => EditorChain;
} & { undo: () => EditorChain; redo: () => EditorChain; run: () => boolean };

/** The TipTap-shaped surface BeeEditor's getEditor() hands out. */
export interface EditorFacade {
  chain: () => EditorChain;
  can: EditorView['can'];
  isActive: (name: string | DocAttrs, attrs?: DocAttrs) => boolean;
  getAttributes: (name: string) => DocAttrs;
  getHTML: EditorView['getHTML'];
  getText: EditorView['getText'];
  getMarkdown: EditorView['getMarkdown'];
  readonly state: EditorView['state'];
  readonly isEditable: boolean;
  focus: () => EditorFacade;
  commands: {
    setContent: (content: string | DocNode | null | undefined, emitUpdate?: boolean) => ReturnType<EditorView['setDoc']>;
    focus: () => ReturnType<EditorView['focus']>;
  };
  storage: {
    markdown: {
      getMarkdown: EditorView['getMarkdown'];
      parser: { parse: (md: string | null | undefined) => string };
    };
  };
  view: { dom: HTMLElement };
  _view: EditorView;
}

export function makeFacade(view: EditorView): EditorFacade {
  return {
    chain: () => view.chain() as EditorChain,
    can: () => view.can(),
    isActive: (name: string | DocAttrs, attrs?: DocAttrs) => view.isActive(name, attrs),
    getAttributes: (name: string) => view.getAttributes(name),
    getHTML: () => view.getHTML(),
    getText: () => view.getText(),
    getMarkdown: () => view.getMarkdown(),
    get state() { return view.state; },
    get isEditable() { return view.editable; },
    focus: () => { view.focus(); return makeFacade(view); },
    commands: {
      setContent: (content: string | DocNode | null | undefined, emitUpdate = false) => view.setDoc(contentToDoc(content), { emitUpdate: emitUpdate === true }),
      focus: () => view.focus(),
    },
    storage: {
      markdown: {
        getMarkdown: () => view.getMarkdown(),
        parser: { parse: (md: string | null | undefined) => astToHtml(markdownToAst(md || '')) },
      },
    },
    view: { dom: view.host },
    _view: view,
  };
}
