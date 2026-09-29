import { act, fireEvent, render } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import useEditorHotkeys from './useEditorHotkeys';
import { AppEditorProvider, useAppEditor } from '../state/AppEditorContext';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

const ctxRef = { current: null };
function Harness({ onTogglePresenter }) {
    const ctx = useAppEditor();
    useEffect(() => { ctxRef.current = ctx; });
    useEditorHotkeys({ enabled: true, onTogglePresenter });
    return null;
}
function setup() {
    const onTogglePresenter = vi.fn();
    render(
        <AppEditorProvider app={{ id: 'app-1', definition: KITCHEN_SINK, version: 1 }}>
            <Harness onTogglePresenter={onTogglePresenter} />
            <input aria-label="typing here" />
        </AppEditorProvider>,
    );
    return { onTogglePresenter };
}

// Presenting is what you do DURING a build: the toggle works while the
// stream lock has every other shortcut off. Plain P stays free; typing in a
// field never toggles it.
describe('useEditorHotkeys — presenter mode', () => {
    it('Shift+P toggles, even under streamLock; plain P and Ctrl+Shift+P do not', () => {
        const { onTogglePresenter } = setup();
        act(() => ctxRef.current.dispatch({ type: 'set_stream_lock', streamLock: true }));
        act(() => { fireEvent.keyDown(window, { key: 'P', shiftKey: true }); });
        expect(onTogglePresenter).toHaveBeenCalledTimes(1);
        act(() => { fireEvent.keyDown(window, { key: 'p' }); });
        act(() => { fireEvent.keyDown(window, { key: 'P', shiftKey: true, ctrlKey: true }); });
        expect(onTogglePresenter).toHaveBeenCalledTimes(1);
    });

    it('never while typing', () => {
        const { onTogglePresenter } = setup();
        const input = document.querySelector('input[aria-label="typing here"]');
        act(() => { fireEvent.keyDown(input, { key: 'P', shiftKey: true }); });
        expect(onTogglePresenter).not.toHaveBeenCalled();
    });
});
