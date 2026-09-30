/**
 * BeeEditor's editing surface without co-editing: link popover (no prompt
 * dialog), keyboard shortcuts and their sheet, find and replace, injectable
 * image upload, the outline with scrolling, comment-anchor helpers, and the
 * per-frame throttling of the document summary. The save debounce must behave
 * exactly as before.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BeeEditorJsx from './BeeEditor.jsx';
import { textSelection, pos } from '../engine/selection.js';
import * as T from '../engine/transforms.js';

/* The editor module is untyped JS. */
const BeeEditor = BeeEditorJsx as any;
type Handle = any;

const box = { top: 100, left: 40, bottom: 118, right: 90, width: 50, height: 18, x: 40, y: 100, toJSON() {} };
const proto = Range.prototype as any;
const saved = { gbcr: proto.getBoundingClientRect, gcr: proto.getClientRects };

beforeEach(() => {
    proto.getBoundingClientRect = () => box;
    proto.getClientRects = () => [box];
});
afterEach(() => {
    proto.getBoundingClientRect = saved.gbcr;
    proto.getClientRects = saved.gcr;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function mount(props: Record<string, unknown> = {}) {
    const ref = createRef<Handle>();
    const utils = render(<BeeEditor ref={ref} content="hello world" notebookId="nb1" {...props} />);
    const host = utils.container.querySelector('.bf-content') as HTMLElement;
    const view = () => ref.current.getEditor()._view;
    return { ...utils, ref, host, view };
}

const typeInto = (view: any, text: string) => {
    act(() => { for (const ch of text) view.dispatch((s: any) => T.insertText(s, ch), { kind: 'type' }); });
};
const key = (host: HTMLElement, init: Record<string, unknown>) => { act(() => { fireEvent.keyDown(host, init); }); };
/** Select like a user does: model and browser selection together. */
const select = (view: any, anchor: [number[], number], head?: [number[], number]) => {
    act(() => {
        view.setSelection(textSelection(pos(anchor[0], anchor[1]), head ? pos(head[0], head[1]) : undefined));
        view.writeSelection();
        view.dispatch((s: any) => s, { kind: 'selection' });
    });
};

describe('mounting', () => {
    it('does not announce itself on the console', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        mount();
        expect(info).not.toHaveBeenCalled();
    });
});

describe('links', () => {
    it('Ctrl+K opens an inline link editor instead of the browser prompt, and applies the address', async () => {
        const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => null);
        const user = userEvent.setup();
        const { host, view } = mount();
        select(view(), [[0], 0], [[0], 5]);
        key(host, { key: 'k', ctrlKey: true });
        const input = await screen.findByLabelText('Link address');
        await user.type(input, 'example.com{Enter}');
        expect(view().getMarkdown().trim()).toBe('[hello](https://example.com) world');
        expect(prompt).not.toHaveBeenCalled();
    });

    it('refuses a script address and says why, keeping the dialog open', async () => {
        const user = userEvent.setup();
        const { host, view } = mount();
        select(view(), [[0], 0], [[0], 5]);
        key(host, { key: 'k', ctrlKey: true });
        const input = await screen.findByLabelText('Link address');
        await user.type(input, 'javascript:alert(1){Enter}');
        expect(screen.getByText('Enter a web address, such as example.com.')).toBeInTheDocument();
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(view().getMarkdown().trim()).toBe('hello world');
    });

    it('the toolbar link button opens the same editor', async () => {
        const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => null);
        const user = userEvent.setup();
        const { view } = mount();
        select(view(), [[0], 0], [[0], 5]);
        await user.click(screen.getAllByRole('button', { name: 'Insert link' })[0]);
        expect(await screen.findByLabelText('Link address')).toBeInTheDocument();
        expect(prompt).not.toHaveBeenCalled();
    });

    it('shows the link under the caret with edit and remove', async () => {
        const user = userEvent.setup();
        const { view } = mount({ content: 'a [site](https://s.test) b' });
        select(view(), [[0], 4]);
        const remove = await screen.findByRole('button', { name: 'Remove link' });
        await user.click(remove);
        expect(view().getMarkdown().trim()).toBe('a site b');
    });
});

describe('keyboard shortcuts', () => {
    it('turns the block into a heading and a list', () => {
        const { host, view } = mount({ content: 'title' });
        select(view(), [[0], 1]);
        key(host, { key: '¡', code: 'Digit1', ctrlKey: true, altKey: true });
        expect(view().getMarkdown().trim()).toBe('# title');
        key(host, { key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true });
        expect(view().getMarkdown().trim()).toBe('- # title');
    });

    it('opens the shortcut sheet, which lists the shortcuts', async () => {
        const { host } = mount();
        key(host, { key: '/', code: 'Slash', ctrlKey: true });
        const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
        expect(dialog).toHaveTextContent('Add or edit link');
        expect(dialog).toHaveTextContent('Find in document');
    });

    it('does not format a read-only document', () => {
        const { host, view } = mount({ content: 'title', editable: false });
        select(view(), [[0], 1]);
        key(host, { key: '¡', code: 'Digit1', ctrlKey: true, altKey: true });
        expect(view().getMarkdown().trim()).toBe('title');
    });
});

describe('find and replace', () => {
    it('counts matches, steps through them and replaces all in one undoable step', async () => {
        const user = userEvent.setup();
        const { host, view } = mount({ content: 'cat and cat' });
        key(host, { key: 'f', ctrlKey: true });
        const input = await screen.findByRole('textbox', { name: 'Find in document' });
        await user.type(input, 'cat');
        expect(screen.getByText('1 of 2')).toBeInTheDocument();
        await user.keyboard('{Enter}');
        expect(screen.getByText('2 of 2')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Show replace' }));
        await user.type(screen.getByRole('textbox', { name: 'Replace with' }), 'dog');
        await user.click(screen.getByRole('button', { name: 'Replace all' }));
        expect(view().getMarkdown().trim()).toBe('dog and dog');
        await waitFor(() => expect(screen.getByText('No results')).toBeInTheDocument());
        act(() => { view().undo(); });
        expect(view().getMarkdown().trim()).toBe('cat and cat');
    });

    it('offers no replace to someone who cannot edit', async () => {
        const { host } = mount({ editable: false });
        key(host, { key: 'f', ctrlKey: true });
        await screen.findByRole('textbox', { name: 'Find in document' });
        expect(screen.queryByRole('button', { name: 'Show replace' })).toBeNull();
    });

    it('scrolls to a match when the user moves to it, never when the document changes under the bar', async () => {
        const user = userEvent.setup();
        const { host, view } = mount({ content: '<p>cat here</p><p>second para</p><p>third para</p><p>last cat</p>' });
        key(host, { key: 'f', ctrlKey: true });
        await user.type(await screen.findByRole('textbox', { name: 'Find in document' }), 'cat');
        await waitFor(() => expect(screen.getByText('1 of 2')).toBeInTheDocument());
        const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
        // Editing elsewhere with the bar open: caret moves and typing.
        select(view(), [[1], 3]);
        select(view(), [[2], 5]);
        typeInto(view(), 'xyz');
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        expect(scroll).not.toHaveBeenCalled();
        // Moving to the next match does scroll, once.
        await user.click(screen.getByRole('button', { name: 'Next match' }));
        expect(screen.getByText('2 of 2')).toBeInTheDocument();
        expect(scroll).toHaveBeenCalledTimes(1);
    });

    it('never draws its highlights inside the editable host', async () => {
        const user = userEvent.setup();
        const { host } = mount({ content: 'cat cat' });
        key(host, { key: 'f', ctrlKey: true });
        await user.type(await screen.findByRole('textbox', { name: 'Find in document' }), 'cat');
        expect(host.querySelector('.bf-range-overlay, .bf-range-rect')).toBeNull();
        expect(document.querySelectorAll('.bf-find-rect, .bf-find-current-rect').length).toBeGreaterThan(0);
    });
});

describe('image upload', () => {
    const pasteImage = (host: HTMLElement, file: File) => {
        act(() => { fireEvent.paste(host, { clipboardData: { items: [{ type: file.type, getAsFile: () => file }], getData: () => '' } }); });
    };

    it('uses the uploader the page provides', async () => {
        const onUploadImage = vi.fn(async (f: File) => ({ src: '/api/storage/x.png', alt: f.name }));
        const { host, view } = mount({ onUploadImage, notebookId: undefined });
        pasteImage(host, new File(['x'], 'photo.png', { type: 'image/png' }));
        await waitFor(() => expect(view().getHTML()).toContain('/api/storage/x.png'));
        expect(onUploadImage).toHaveBeenCalledTimes(1);
    });

    it('says so quietly when the upload fails or returns an unsafe address', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onUploadImage = vi.fn(async (): Promise<any> => { throw new Error('nope'); });
        const { host, view } = mount({ onUploadImage });
        pasteImage(host, new File(['x'], 'a.png', { type: 'image/png' }));
        expect(await screen.findByText(/could not be uploaded/)).toBeInTheDocument();
        onUploadImage.mockImplementation(async () => ({ src: 'javascript:alert(1)' }));
        pasteImage(host, new File(['x'], 'b.png', { type: 'image/png' }));
        await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(2));
        expect(view().getHTML()).not.toContain('javascript:');
    });

    it('keeps a picture a page carries inside itself as a data: URL (png, jpeg, gif, webp)', async () => {
        for (const type of ['png', 'jpeg', 'gif', 'webp']) {
            const src = `data:image/${type};base64,iVBORw0KGgo=`;
            const onUploadImage = vi.fn(async (f: File) => ({ src, alt: f.name }));
            const { host, view, unmount } = mount({ onUploadImage, notebookId: undefined });
            pasteImage(host, new File(['x'], `p.${type}`, { type: `image/${type}` }));
            await waitFor(() => expect(view().getHTML()).toContain(src));
            unmount();
        }
    });

    it('refuses an SVG data: URL (it can carry script), a malformed one and one that is too large', async () => {
        const large = `data:image/png;base64,${'A'.repeat(420 * 1024)}`;
        for (const src of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<script>', large]) {
            const onUploadImage = vi.fn(async () => ({ src, alt: 'x' }));
            const { host, view, unmount } = mount({ onUploadImage, notebookId: undefined });
            pasteImage(host, new File(['x'], 'x.png', { type: 'image/png' }));
            expect(await screen.findByText(/could not be uploaded/)).toBeInTheDocument();
            expect(view().getHTML()).not.toContain('data:image');
            unmount();
        }
    });
});

describe('outline', () => {
    it('reports nested headings and scrolls to one by its index', async () => {
        const onTocUpdate = vi.fn();
        const { ref, host } = mount({ content: '# Top\n\n> ## Quoted\n\ntext', onTocUpdate });
        await waitFor(() => expect(onTocUpdate).toHaveBeenCalled());
        const items = onTocUpdate.mock.calls.at(-1)![0];
        expect(items.map((i: any) => [i.level, i.textContent])).toEqual([[1, 'Top'], [2, 'Quoted']]);
        const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
        act(() => { ref.current.scrollToHeading(1); });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.instances[0]).toBe(host.querySelector('blockquote h2'));
    });
});

describe('comment anchors', () => {
    it('captures the selection as an anchor, highlights it outside the host and scrolls to it', () => {
        const { ref, host, view } = mount({ content: 'The price is ten euros.' });
        select(view(), [[0], 13], [[0], 16]);
        const anchor = ref.current.getSelectionAnchor();
        expect(anchor).toMatchObject({ quote: 'ten', blockIndex: 0 });
        act(() => { ref.current.highlightAnchors([{ id: 't1', anchor }], 't1'); });
        expect(host.querySelector('.bf-comment-active-rect')).toBeNull();
        expect(document.querySelector('.bf-comment-active-rect')).not.toBeNull();
        expect(ref.current.scrollToAnchor(anchor)).toBe(true);
        expect(ref.current.scrollToAnchor({ quote: 'gone', prefix: '', suffix: '', blockIndex: 0 })).toBe(false);
        act(() => { ref.current.highlightAnchors([]); });
        expect(document.querySelector('.bf-comment-active-rect')).toBeNull();
    });
});

describe('summary work per frame', () => {
    it('reports a burst of keystrokes once, with the final HTML and word count', async () => {
        const onChange = vi.fn();
        const onWordCountChange = vi.fn();
        const { view } = mount({ content: 'one', onChange, onWordCountChange });
        await waitFor(() => expect(onWordCountChange).toHaveBeenCalledWith(1));
        onWordCountChange.mockClear();
        select(view(), [[0], 3]);
        typeInto(view(), ' two');
        await waitFor(() => expect(onChange).toHaveBeenCalled());
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toContain('one two');
        expect(onChange.mock.calls[0][1]).toEqual({ remote: false });
        expect(onWordCountChange).toHaveBeenCalledTimes(1);
        expect(onWordCountChange).toHaveBeenCalledWith(2);
    });

    it('still saves two seconds after the last edit, and flush saves at once', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onSave = vi.fn();
        const { ref, view } = mount({ content: 'a', onSave });
        select(view(), [[0], 1]);
        typeInto(view(), 'b');
        act(() => { vi.advanceTimersByTime(1900); });
        expect(onSave).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(200); });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0][0]).toContain('ab');
        typeInto(view(), 'c');
        let flushed: string | null = null;
        act(() => { flushed = ref.current.flush(); });
        expect(flushed).toContain('abc');
        expect(onSave).toHaveBeenCalledTimes(2);
    });
});
