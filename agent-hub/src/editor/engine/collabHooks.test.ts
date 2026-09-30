/**
 * The co-editing seams of EditorView: plugins, the setSelection choke point,
 * applyExternal (no history, mapped selection, focus guard), undo-provider
 * delegation with kind-based capture stopping, and the composition hook.
 * Without a plugin or provider the editor must behave exactly as before.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorView } from './view.js';
import { createState } from './state.js';
import { markdownToAst } from '../serialization/mdToAst.js';
import { textSelection, pos } from './selection.js';
import * as T from './transforms.js';

/* The engine is untyped JS: the view and its states are `any` here. */
type View = any;
let views: Array<{ view: View; host: HTMLElement }> = [];
function makeView(md: string, opts: Record<string, unknown> = {}): View {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view: View = new EditorView(host, { state: createState(markdownToAst(md)), ...opts });
  views.push({ view, host });
  return view;
}
afterEach(() => {
  views.forEach(({ view, host }) => { view.destroy(); host.remove(); });
  views = [];
});

const type = (view: View, text: string) => { for (const ch of text) view.dispatch((s: any) => T.insertText(s, ch), { kind: 'type' }); };
const md = (view: View): string => view.getMarkdown().trim();

function fakeUndo() {
  return { undo: vi.fn(), redo: vi.fn(), canUndo: vi.fn(() => true), canRedo: vi.fn(() => false), stopCapturing: vi.fn() };
}

describe('plugins', () => {
  it('see every committed change with the state before and after, and its kind', () => {
    const view = makeView('ab');
    const docChanged = vi.fn();
    const beforeChange = vi.fn();
    view.addPlugin({ docChanged, beforeChange });
    view.setSelection(textSelection(pos([0], 2)));
    type(view, 'c');
    expect(beforeChange).toHaveBeenCalledTimes(1);
    expect(docChanged).toHaveBeenCalledTimes(1);
    const [prev, next, meta] = docChanged.mock.calls[0];
    expect(prev.doc).not.toBe(next.doc);
    expect(meta).toEqual({ kind: 'type' });
  });

  it('hear every caret move, including the ones that bypass dispatch', () => {
    const view = makeView('hello');
    const selectionChanged = vi.fn();
    view.addPlugin({ selectionChanged });
    view.setSelection(textSelection(pos([0], 3)));
    expect(selectionChanged).toHaveBeenCalledWith(view.state, { source: 'local' });
    view.dispatch((s: any) => ({ ...s, selection: textSelection(pos([0], 1)) }), { kind: 'selection' });
    expect(selectionChanged).toHaveBeenCalledTimes(2);
  });

  it('can be removed again, and a failing plugin never breaks the edit', () => {
    const onError = vi.fn();
    const view = makeView('x', { onError });
    const remove = view.addPlugin({ docChanged: () => { throw new Error('boom'); } });
    view.setSelection(textSelection(pos([0], 1)));
    type(view, 'y');
    expect(md(view)).toBe('xy');
    expect(onError).toHaveBeenCalledTimes(1);
    remove();
    type(view, 'z');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('are told when the view is destroyed', () => {
    const view = makeView('x');
    const viewDestroyed = vi.fn();
    view.addPlugin({ viewDestroyed });
    view.destroy();
    expect(viewDestroyed).toHaveBeenCalledTimes(1);
  });
});

describe('setSelection', () => {
  it('keeps stored marks unless told otherwise', () => {
    const view = makeView('abc');
    view.state = { ...view.state, storedMarks: [{ type: 'bold' }] };
    view.setSelection(textSelection(pos([0], 1)));
    expect(view.state.storedMarks).toEqual([{ type: 'bold' }]);
    view.setSelection(textSelection(pos([0], 2)), { storedMarks: null });
    expect(view.state.storedMarks).toBeNull();
  });
});

describe('applyExternal', () => {
  it('shows the new document without an undo step and emits a remote change', () => {
    const onUpdate = vi.fn();
    const view = makeView('one', { onUpdate });
    view.applyExternal(markdownToAst('one two'));
    expect(md(view)).toBe('one two');
    expect(view.host.textContent).toBe('one two');
    expect(view.can().undo()).toBe(false);
    expect(onUpdate).toHaveBeenLastCalledWith({ remote: true });
  });

  it('maps the selection through the caller, and clamps what no longer exists', () => {
    const view = makeView('hello');
    view.setSelection(textSelection(pos([0], 5)));
    view.applyExternal(markdownToAst('Oh, hello'), { mapSelection: (sel: any) => textSelection(pos([0], sel.anchor.offset + 4)) });
    expect(view.state.selection.anchor).toEqual({ path: [0], offset: 9 });
    view.applyExternal(markdownToAst('x'), { mapSelection: () => textSelection(pos([4], 9)) });
    expect(view.state.selection.anchor.path).toEqual([0]);
  });

  it('never moves the browser selection while focus is elsewhere (an input outside the editor)', () => {
    const view = makeView('hello');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const spy = vi.spyOn(view, 'writeSelection');
    view.applyExternal(markdownToAst('hello there'));
    expect(spy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('writes the selection when the editor itself has focus', () => {
    const view = makeView('hello');
    view.host.focus();
    const spy = vi.spyOn(view, 'writeSelection');
    view.applyExternal(markdownToAst('hello there'));
    expect(spy).toHaveBeenCalled();
  });

  it('a first load starts a fresh history with the caret at the start', () => {
    const view = makeView('old');
    view.setSelection(textSelection(pos([0], 3)));
    type(view, 'x');
    view.applyExternal(markdownToAst('# Shared'), { origin: 'load' });
    expect(md(view)).toBe('# Shared');
    expect(view.can().undo()).toBe(false);
    expect(view.state.selection.anchor).toEqual({ path: [0], offset: 0 });
  });

  it('moves a pending composition start along with the document', () => {
    const view = makeView('abc');
    view.compStartSel = textSelection(pos([0], 3));
    view.applyExternal(markdownToAst('Xabc'), { mapSelection: (sel: any) => textSelection(pos([0], sel.anchor.offset + 1)) });
    expect(view.compStartSel.anchor.offset).toBe(4);
  });
});

describe('undo provider', () => {
  it('takes over undo, redo and can(), and records no snapshots', () => {
    const view = makeView('a');
    const u = fakeUndo();
    view.setUndoProvider(u);
    view.setSelection(textSelection(pos([0], 1)));
    type(view, 'b');
    view.undo();
    view.redo();
    expect(u.undo).toHaveBeenCalledTimes(1);
    expect(u.redo).toHaveBeenCalledTimes(1);
    expect(view.can().undo()).toBe(true);
    expect(view.can().redo()).toBe(false);
    expect(view.history.done).toHaveLength(0);
  });

  it('keeps a run of typing in one step and starts a new one for any other kind', () => {
    const view = makeView('a');
    const u = fakeUndo();
    view.setUndoProvider(u);
    view.setSelection(textSelection(pos([0], 1)));
    type(view, 'bcd');
    expect(u.stopCapturing).toHaveBeenCalledTimes(1);
    view.dispatch(T.splitBlock, { kind: 'structural' });
    expect(u.stopCapturing).toHaveBeenCalledTimes(2);
    type(view, 'e');
    expect(u.stopCapturing).toHaveBeenCalledTimes(3);
  });

  it('removing it gives back the built-in history, starting empty', () => {
    const view = makeView('a');
    view.setUndoProvider(fakeUndo());
    view.setUndoProvider(null);
    expect(view.can().undo()).toBe(false);
    view.setSelection(textSelection(pos([0], 1)));
    type(view, 'b');
    view.undo();
    expect(md(view)).toBe('a');
  });
});

describe('setDoc while collaborative', () => {
  it('is an undoable edit that keeps the history instead of a wholesale replace', () => {
    const view = makeView('before');
    const docChanged = vi.fn();
    view.addPlugin({ docChanged });
    view.setCollaborative(true);
    view.setDoc(markdownToAst('after'));
    expect(md(view)).toBe('after');
    expect(docChanged).toHaveBeenCalledTimes(1);
    view.undo();
    expect(md(view)).toBe('before');
  });

  it('without co-editing still resets the history (the switch-notebook guard)', () => {
    const view = makeView('a');
    view.setSelection(textSelection(pos([0], 1)));
    type(view, 'b');
    view.setDoc(markdownToAst('other'));
    expect(view.can().undo()).toBe(false);
  });
});

describe('composition', () => {
  it('tells plugins when it ends, before the committed text is applied', () => {
    const view = makeView('ab');
    const order: string[] = [];
    view.addPlugin({ compositionEnd: () => order.push('hook'), docChanged: () => order.push('text') });
    view.setSelection(textSelection(pos([0], 2)));
    view.composing = true;
    view.compStartSel = view.state.selection;
    const e = new Event('compositionend');
    Object.defineProperty(e, 'data', { value: 'c' });
    Object.defineProperty(e, 'target', { value: view.host });
    view.onCompositionEnd(e);
    expect(order).toEqual(['hook', 'text']);
    expect(md(view)).toBe('abc');
  });
});

describe('rangeFor', () => {
  it('builds a DOM range over model positions, or null for positions that do not exist', () => {
    const view = makeView('hello world');
    const r = view.rangeFor(pos([0], 6), pos([0], 11));
    expect(r.toString()).toBe('world');
    expect(view.rangeFor(pos([7], 0), pos([7], 1))).toBeNull();
  });
});
