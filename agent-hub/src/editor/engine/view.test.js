import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from './view.js';
import { createState } from './state.js';
import { markdownToAst } from '../serialization/mdToAst.js';
import { textSelection, pos } from './selection.js';

let views = [];
function makeView(md) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView(host, { state: createState(markdownToAst(md)) });
  views.push({ view, host });
  return view;
}
function select(view, anchor, head) { view.state = { ...view.state, selection: textSelection(anchor, head || anchor) }; }

afterEach(() => {
  views.forEach(({ view, host }) => { view.destroy(); host.remove(); });
  views = [];
});

describe('EditorView integration', () => {
  it('renders the document into the host', () => {
    const view = makeView('# Title\n\nbody');
    expect(view.host.querySelector('h1')?.textContent).toBe('Title');
    expect(view.host.querySelectorAll('p').length).toBe(1);
  });

  it('inserts content via chain and reconciles the DOM', () => {
    const view = makeView('ab');
    select(view, pos([0], 1));
    view.chain().insertContent('X').run();
    expect(view.getMarkdown().trim()).toBe('aXb');
    expect(view.host.querySelector('p')?.textContent).toBe('aXb');
  });

  it('toggles bold over a selection via chain()', () => {
    const view = makeView('hello');
    select(view, pos([0], 0), pos([0], 5));
    view.chain().toggleBold().run();
    expect(view.getMarkdown().trim()).toBe('**hello**');
    expect(view.host.querySelector('strong')?.textContent).toBe('hello');
  });

  it('sets a heading via chain()', () => {
    const view = makeView('hello');
    select(view, pos([0], 1));
    view.chain().toggleHeading({ level: 2 }).run();
    expect(view.getMarkdown().trim()).toBe('## hello');
    expect(view.host.querySelector('h2')).toBeTruthy();
  });

  it('supports undo/redo', () => {
    const view = makeView('hello');
    select(view, pos([0], 0), pos([0], 5));
    view.chain().toggleBold().run();
    expect(view.getMarkdown().trim()).toBe('**hello**');
    view.undo();
    expect(view.getMarkdown().trim()).toBe('hello');
    view.redo();
    expect(view.getMarkdown().trim()).toBe('**hello**');
  });

  it('reports active marks and block types', () => {
    const view = makeView('# Heading');
    select(view, pos([0], 2));
    expect(view.isActive('heading', { level: 1 })).toBe(true);
    expect(view.isActive('heading', { level: 2 })).toBe(false);
  });

  it('inserts a table via chain and reports inTable', () => {
    const view = makeView('text');
    select(view, pos([0], 4));
    view.chain().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
    expect(view.host.querySelector('table')).toBeTruthy();
    expect(view.host.querySelectorAll('th').length).toBe(2);
  });

  it('setDoc replaces the document', () => {
    const view = makeView('old');
    view.setDoc(markdownToAst('# New doc'), { emitUpdate: false });
    expect(view.getMarkdown().trim()).toBe('# New doc');
    expect(view.host.querySelector('h1')?.textContent).toBe('New doc');
  });

  it('replaceDoc is one undo step that brings the previous text back', () => {
    const view = makeView('first\n\nsecond');
    let updates = 0;
    view.onUpdate = () => { updates += 1; };
    view.replaceDoc(markdownToAst('# Rewritten\n\nby the assistant'), { emitUpdate: false });
    expect(view.getMarkdown().trim()).toBe('# Rewritten\n\nby the assistant');
    expect(view.host.querySelector('h1')?.textContent).toBe('Rewritten');
    expect(updates).toBe(0);
    view.undo();
    expect(view.getMarkdown().trim()).toBe('first\n\nsecond');
    view.redo();
    expect(view.getMarkdown().trim()).toBe('# Rewritten\n\nby the assistant');
  });

  it('replaceDoc keeps the caret where it was and the earlier history', () => {
    const view = makeView('hello\n\nworld');
    select(view, pos([1], 3));
    view.chain().insertContent('!').run();
    select(view, pos([1], 2));
    view.replaceDoc(markdownToAst('hello\n\nwor!ld and more'), { emitUpdate: false });
    expect(view.state.selection.head).toEqual(pos([1], 2));
    view.undo();
    expect(view.getMarkdown().trim()).toBe('hello\n\nwor!ld');
    view.undo();
    expect(view.getMarkdown().trim()).toBe('hello\n\nworld');
  });

  it('replaceDoc clamps a caret whose text is gone and keeps the scroll offset', () => {
    const view = makeView('a long first paragraph\n\nsecond');
    const scroller = document.createElement('div');
    view.host.parentElement.insertBefore(scroller, view.host);
    scroller.appendChild(view.host);
    scroller.scrollTop = 120;
    select(view, pos([1], 6));
    view.replaceDoc(markdownToAst('short'), { emitUpdate: false });
    expect(view.state.selection.head.path).toEqual([0]);
    expect(scroller.scrollTop).toBe(120);
    scroller.replaceWith(view.host);
  });

  it('replaceDoc emits one update when asked, like an edit', () => {
    const view = makeView('old');
    let updates = 0;
    view.onUpdate = () => { updates += 1; };
    view.replaceDoc(markdownToAst('new'));
    expect(updates).toBe(1);
  });

  it('exposes getHTML with export-compatible image markup', () => {
    const view = makeView('![a](x.png){w=200}');
    expect(view.getHTML()).toContain('class="notebook-image"');
    expect(view.getHTML()).toContain('data-width="200"');
  });
});
