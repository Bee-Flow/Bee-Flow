/**
 * BeeEditor's replaceDocument (an AI edit or a restore shown outside
 * co-editing) and openShortcuts (the command palette's entry).
 *
 * replaceDocument must be ONE undoable step: Ctrl+Z brings the previous text
 * back and that undo is saved like typing. The replacement itself saves
 * nothing (the server already holds it), and the parent echoing the same
 * HTML back as the content prop must not replace it again, which would drop
 * the undo step.
 */
import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BeeEditorJsx from './BeeEditor.jsx';

/* The editor module is untyped JS. */
const BeeEditor = BeeEditorJsx as any;

afterEach(() => { vi.useRealTimers(); });

function mount(props: Record<string, unknown> = {}) {
    const ref = createRef<any>();
    const onSave = vi.fn();
    const utils = render(<BeeEditor ref={ref} content="<p>hello world</p>" notebookId="nb1" onSave={onSave} {...props} />);
    const view = () => ref.current.getEditor()._view;
    return { ...utils, ref, view, onSave };
}

describe('replaceDocument', () => {
    it('shows the new content as one undo step and saves only the undo', () => {
        vi.useFakeTimers();
        const { ref, view, onSave } = mount();
        act(() => { ref.current.replaceDocument('<h2>Rewritten</h2><p>by the assistant</p>'); });
        expect(view().getMarkdown().trim()).toBe('## Rewritten\n\nby the assistant');
        act(() => { vi.advanceTimersByTime(3000); });
        expect(onSave).not.toHaveBeenCalled();

        act(() => { view().undo(); });
        expect(view().getMarkdown().trim()).toBe('hello world');
        act(() => { vi.advanceTimersByTime(3000); });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave.mock.calls[0][0]).toContain('hello world');
    });

    it('reads Markdown when asked', () => {
        const { ref, view } = mount();
        act(() => { ref.current.replaceDocument('# Filled\n\nwith **values**', { markdown: true }); });
        expect(view().getMarkdown().trim()).toBe('# Filled\n\nwith **values**');
        act(() => { view().undo(); });
        expect(view().getMarkdown().trim()).toBe('hello world');
    });

    it('keeps the undo step when the parent echoes the same HTML as the content prop', () => {
        const ref = createRef<any>();
        const next = '<p>from the server</p>';
        const { rerender } = render(<BeeEditor ref={ref} content="<p>hello world</p>" notebookId="nb1" />);
        act(() => { ref.current.replaceDocument(next); });
        rerender(<BeeEditor ref={ref} content={next} notebookId="nb1" />);
        const view = ref.current.getEditor()._view;
        expect(view.getMarkdown().trim()).toBe('from the server');
        act(() => { view.undo(); });
        expect(view.getMarkdown().trim()).toBe('hello world');
    });

    it('cancels a save still pending for the text it replaces', () => {
        vi.useFakeTimers();
        const { ref, view, onSave } = mount();
        act(() => { view().chain().focus().insertContent('!').run(); });
        act(() => { ref.current.replaceDocument('<p>the saved version</p>'); });
        act(() => { vi.advanceTimersByTime(3000); });
        expect(onSave).not.toHaveBeenCalled();
    });
});

describe('openShortcuts', () => {
    it('opens the keyboard shortcuts sheet', async () => {
        const { ref } = mount();
        act(() => { ref.current.openShortcuts(); });
        expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    });

    it('works for a read-only editor too', async () => {
        const { ref } = mount({ editable: false });
        act(() => { ref.current.openShortcuts(); });
        expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    });
});
