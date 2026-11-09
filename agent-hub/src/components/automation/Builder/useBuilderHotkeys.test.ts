import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useBuilderHotkeys from './useBuilderHotkeys';

/** A keydown that bubbles from `target` up to the document, as a real key press does. */
function press(target: Element, init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

describe('useBuilderHotkeys — Escape', () => {
    it('closes the builder panel on a plain Escape', () => {
        const onEscape = vi.fn();
        renderHook(() => useBuilderHotkeys({ onEscape }));
        press(document.body, { key: 'Escape' });
        expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('leaves the panel open when a menu or popover inside it already took the Escape', () => {
        const onEscape = vi.fn();
        renderHook(() => useBuilderHotkeys({ onEscape }));
        const menu = document.createElement('div');
        document.body.appendChild(menu);
        // The inner control closes itself and marks the key as handled.
        menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); });
        press(menu, { key: 'Escape' });
        expect(onEscape).not.toHaveBeenCalled();
        menu.remove();
    });
});

describe('useBuilderHotkeys — run and save', () => {
    it('Cmd/Ctrl+Enter starts a dry run on the canvas, not inside a text field, and not while a run is going', () => {
        const onDryRun = vi.fn();
        const { rerender } = renderHook(({ runBlocked }) => useBuilderHotkeys({ onDryRun, runBlocked }), { initialProps: { runBlocked: false } });
        press(document.body, { key: 'Enter', ctrlKey: true });
        expect(onDryRun).toHaveBeenCalledTimes(1);

        const field = document.createElement('textarea');
        document.body.appendChild(field);
        press(field, { key: 'Enter', ctrlKey: true });
        expect(onDryRun).toHaveBeenCalledTimes(1);
        field.remove();

        rerender({ runBlocked: true });
        press(document.body, { key: 'Enter', ctrlKey: true });
        expect(onDryRun).toHaveBeenCalledTimes(1);
    });

    it('Cmd/Ctrl+S saves now and keeps the browser\'s own save dialog away', () => {
        const onSave = vi.fn();
        renderHook(() => useBuilderHotkeys({ onSave }));
        const event = press(document.body, { key: 's', metaKey: true });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });
});
