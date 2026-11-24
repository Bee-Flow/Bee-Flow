import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { floatingPanes, MIN_CENTER, useShellPanes } from './ShellPanes';
import type { SidePane } from './ShellPanes';

const pane = (open: boolean): SidePane => ({
    width: 320, setWidth: () => {}, open, setOpen: () => {}, persistWidth: () => {}, toggle: () => {},
});

describe('floatingPanes: which side panes float over the canvas', () => {
    it('keeps both in place when the canvas keeps its minimum width', () => {
        expect(floatingPanes(340 + 320 + MIN_CENTER, 340, 320)).toEqual({ chat: false, inspector: false });
    });

    it('floats the chat pane first (the 1280px laptop)', () => {
        expect(floatingPanes(1040, 340, 320)).toEqual({ chat: true, inspector: false });
    });

    it('floats both on the 1024px laptop next to the Studio menu', () => {
        expect(floatingPanes(784, 340, 320)).toEqual({ chat: true, inspector: true });
    });

    it('floats nothing it does not show, and nothing before the shell is measured', () => {
        expect(floatingPanes(784, 0, 320)).toEqual({ chat: false, inspector: true });
        expect(floatingPanes(null, 340, 320)).toEqual({ chat: false, inspector: false });
    });
});

describe('useShellPanes: one floating pane open at a time', () => {
    it('starts floating panes closed, and opening one closes the other', () => {
        const { result } = renderHook(() => useShellPanes(pane(true), pane(true), { chat: true, inspector: true }));
        expect(result.current.chatPane.open).toBe(false);
        expect(result.current.inspectorPane.open).toBe(false);
        act(() => result.current.chatPane.toggle());
        expect(result.current.chatPane.open).toBe(true);
        act(() => result.current.inspectorPane.setOpen(true));
        expect(result.current.chatPane.open).toBe(false);
        expect(result.current.inspectorPane.open).toBe(true);
    });

    it('hands a pane in place through unchanged', () => {
        const chat = pane(true);
        const { result } = renderHook(() => useShellPanes(chat, pane(false), { chat: false, inspector: false }));
        expect(result.current.chatPane).toBe(chat);
    });
});
