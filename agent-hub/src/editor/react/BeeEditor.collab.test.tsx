/**
 * BeeEditor with a co-editing session (the `collab` prop): read-only until the
 * first sync, then bound to the shared document; no local save debounce; the
 * content prop is ignored while bound; read-only for viewers and ended
 * sessions; remote edits appear without touching the caret's focus; and the
 * co-editors' carets are drawn beside the host, never inside it.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import BeeEditorJsx from './BeeEditor.jsx';
import { textSelection, pos } from '../engine/selection.js';
import * as T from '../engine/transforms.js';
import { markdownToAst } from '../serialization/mdToAst.js';
import { astToFragment } from '../collab/yConvert';
import { encodeRelpos, relativeFromPos } from '../collab/relpos';
import type { CollabHandle, CollabPeer } from '../collab/useCollab';

const BeeEditor = BeeEditorJsx as any;

const box = { top: 100, left: 40, bottom: 118, right: 42, width: 2, height: 18, x: 40, y: 100, toJSON() {} };
const proto = Range.prototype as any;
const saved = { gbcr: proto.getBoundingClientRect, gcr: proto.getClientRects };
beforeEach(() => { proto.getBoundingClientRect = () => box; proto.getClientRects = () => [box]; });
afterEach(() => { proto.getBoundingClientRect = saved.gbcr; proto.getClientRects = saved.gcr; vi.useRealTimers(); });

let docs: Y.Doc[] = [];
afterEach(() => { docs.forEach((d) => d.destroy()); docs = []; });

function sharedDoc(md: string) {
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const fragment = ydoc.getXmlFragment('content');
    astToFragment(markdownToAst(md), fragment);
    return { ydoc, fragment, awareness: new Awareness(ydoc) };
}

function handle(shared: ReturnType<typeof sharedDoc>, over: Partial<CollabHandle> = {}): CollabHandle {
    return {
        status: 'synced', canEdit: true, ready: true, peers: [], userId: 'me', retry: () => {}, destroy: () => {},
        ydoc: shared.ydoc, fragment: shared.fragment, awareness: shared.awareness, ...over,
    };
}

function mount(collab: CollabHandle, props: Record<string, unknown> = {}) {
    const ref = createRef<any>();
    const utils = render(<BeeEditor ref={ref} content="saved copy" notebookId="nb1" collab={collab} {...props} />);
    const host = utils.container.querySelector('.bf-content') as HTMLElement;
    const view = () => ref.current.getEditor()._view;
    return { ...utils, ref, host, view };
}

describe('joining', () => {
    it('shows the saved copy read-only with a quiet status until the session has synced', () => {
        const shared = sharedDoc('shared text');
        const { host, view } = mount(handle(shared, { status: 'connecting', ready: false }));
        expect(view().getMarkdown().trim()).toBe('saved copy');
        expect(host.getAttribute('contenteditable')).toBe('false');
        expect(host.getAttribute('aria-busy')).toBe('true');
        expect(screen.getByRole('status')).toHaveTextContent('Opening the live document…');
        expect(screen.queryByRole('toolbar', { name: 'Editor toolbar' })).toBeNull();
    });

    it('binds to the shared document once synced and becomes editable', async () => {
        const shared = sharedDoc('shared text');
        const { host, view, rerender, ref } = mount(handle(shared, { status: 'connecting', ready: false }));
        rerender(<BeeEditor ref={ref} content="saved copy" notebookId="nb1" collab={handle(shared)} />);
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('shared text'));
        expect(host.getAttribute('contenteditable')).toBe('true');
        expect(screen.queryByText('Opening the live document…')).toBeNull();
    });

    it('stays an ordinary editor when the session is switched off before it synced', () => {
        const shared = sharedDoc('shared text');
        const { host, view } = mount(handle(shared, { status: 'disabled', ready: false, canEdit: false }));
        expect(view().getMarkdown().trim()).toBe('saved copy');
        expect(host.getAttribute('contenteditable')).toBe('true');
    });
});

describe('while bound', () => {
    it('shares typing, never schedules the local save and has nothing to flush', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onSave = vi.fn();
        const onChange = vi.fn();
        const shared = sharedDoc('abc');
        const { view, ref } = mount(handle(shared), { onSave, onChange });
        await vi.waitFor(() => expect(view().getMarkdown().trim()).toBe('abc'));
        act(() => {
            view().setSelection(textSelection(pos([0], 3)));
            view().dispatch((s: any) => T.insertText(s, 'd'), { kind: 'type' });
        });
        expect((shared.fragment.get(0) as Y.XmlElement).toString()).toContain('abcd');
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onSave).not.toHaveBeenCalled();
        expect(ref.current.flush()).toBeNull();
        await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining('abcd'), { remote: false }));
    });

    it('ignores the content prop, which would otherwise replace everyone\'s work', async () => {
        const shared = sharedDoc('shared');
        const { view, rerender, ref } = mount(handle(shared));
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('shared'));
        const h = handle(shared);
        rerender(<BeeEditor ref={ref} content="<p>stale server copy</p>" notebookId="nb1" collab={h} />);
        expect(view().getMarkdown().trim()).toBe('shared');
    });

    it('shows a co-editor\'s change and reports it as remote', async () => {
        const onChange = vi.fn();
        const shared = sharedDoc('hello');
        const { view, host } = mount(handle(shared), { onChange });
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('hello'));
        const other = new Y.Doc();
        docs.push(other);
        Y.applyUpdate(other, Y.encodeStateAsUpdate(shared.ydoc));
        const text = (other.getXmlFragment('content').get(0) as Y.XmlElement).get(0) as Y.XmlText;
        text.insert(5, ' world');
        act(() => { Y.applyUpdate(shared.ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(shared.ydoc))); });
        expect(host.textContent).toBe('hello world');
        await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('hello world'), { remote: true }));
    });

    it('keeps a co-editor\'s paragraph when a rewrite made from an older snapshot lands (AI fill)', async () => {
        const shared = sharedDoc('Intro {{name}}\n\nSecond');
        const { view, ref } = mount(handle(shared));
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('Intro {{name}}\n\nSecond'));
        const snapshot = ref.current.getEditor().getHTML();
        const other = new Y.Doc();
        docs.push(other);
        Y.applyUpdate(other, Y.encodeStateAsUpdate(shared.ydoc));
        const para = new Y.XmlElement('textblock');
        para.setAttribute('type', 'paragraph');
        const text = new Y.XmlText();
        para.insert(0, [text]);
        text.insert(0, 'B wrote this');
        other.getXmlFragment('content').insert(2, [para]);
        act(() => { Y.applyUpdate(shared.ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(shared.ydoc))); });
        expect(view().getMarkdown().trim()).toBe('Intro {{name}}\n\nSecond\n\nB wrote this');
        act(() => { ref.current.replaceDocument('Intro Alice\n\nSecond', { markdown: true, base: snapshot }); });
        expect(view().getMarkdown().trim()).toBe('Intro Alice\n\nSecond\n\nB wrote this');
        expect(shared.fragment.toString()).toContain('B wrote this');
        expect(shared.fragment.toString()).toContain('Alice');
    });

    it('is read-only for a viewer and after the session ended', async () => {
        const shared = sharedDoc('text');
        const { host, view, rerender, ref } = mount(handle(shared, { status: 'readonly', canEdit: false }));
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('text'));
        expect(host.getAttribute('contenteditable')).toBe('false');
        rerender(<BeeEditor ref={ref} content="x" notebookId="nb1" collab={handle(shared, { status: 'synced' })} />);
        expect(host.getAttribute('contenteditable')).toBe('true');
        rerender(<BeeEditor ref={ref} content="x" notebookId="nb1" collab={handle(shared, { status: 'error', lastError: 'DELETED' })} />);
        expect(host.getAttribute('contenteditable')).toBe('false');
        expect(view().getMarkdown().trim()).toBe('text');
    });
});

describe('co-editors\' carets', () => {
    function peerAt(shared: ReturnType<typeof sharedDoc>, offset: number): CollabPeer {
        const rel = encodeRelpos(relativeFromPos(shared.fragment, [0], offset)!);
        return { clientId: 7, userId: 'anna', name: 'Anna', color: '#0284c7', colorIndex: 0, editing: true, cursor: { anchor: rel, head: rel } };
    }

    it('draws a caret with a name flag beside the host, never inside it', async () => {
        const shared = sharedDoc('hello world');
        const { host, view, container } = mount(handle(shared, { peers: [peerAt(shared, 5)] }));
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('hello world'));
        const caret = await waitFor(() => {
            const el = container.querySelector('.bf-peer-caret');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        expect(host.contains(caret)).toBe(false);
        expect(host.querySelector('[class*="bf-peer"]')).toBeNull();
        expect(caret.textContent).toBe('Anna');
        expect(caret.className).toContain('bf-peer-0');
    });

    it('draws nothing for a peer whose position no longer exists', async () => {
        const shared = sharedDoc('abc');
        const gone: CollabPeer = { clientId: 8, userId: 'bo', color: '#000', colorIndex: 1, editing: true, cursor: { anchor: 'AAAA', head: 'AAAA' } };
        const { container, view } = mount(handle(shared, { peers: [gone] }));
        await waitFor(() => expect(view().getMarkdown().trim()).toBe('abc'));
        expect(container.querySelector('.bf-peer-caret')).toBeNull();
    });
});
