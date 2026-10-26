/**
 * The drag handle of the refine rail (A2 step 1).
 *
 * The rail moved from left to RIGHT. That is not only a different start width: the
 * handle now sits on the left side of the rail, so dragging to the LEFT must make it
 * WIDER. Without this test, the only way to notice a reversed sign is dragging by
 * hand in a browser.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/useChatPanelResize.test.jsx
 */
import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';

import useChatPanelResize from './useChatPanelResize';
import { partial, stub } from '@/test/mocks';

afterEach(() => cleanup());

function drag(result: { current: { onDragStart: (...args: unknown[]) => unknown } }, from: number, to: number) {
    act(() => { result.current.onDragStart({ clientX: from }); });
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: to })); });
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', {})); });
}

describe('useChatPanelResize', () => {
    it('start op 360px', () => {
        const { result } = renderHook(() => useChatPanelResize());
        expect(result.current.chatWidth).toBe(360);
    });

    it('rail rechts: naar links slepen maakt hem breder', () => {
        const { result } = renderHook(() => useChatPanelResize());
        drag(stub<Parameters<typeof drag>[0]>(result), 900, 800);
        expect(result.current.chatWidth).toBe(460);
    });

    it('rail rechts: naar rechts slepen maakt hem smaller, tot de ondergrens van 300', () => {
        const { result } = renderHook(() => useChatPanelResize());
        drag(stub<Parameters<typeof drag>[0]>(result), 900, 940);
        expect(result.current.chatWidth).toBe(320);
        drag(stub<Parameters<typeof drag>[0]>(result), 940, 1400);
        expect(result.current.chatWidth).toBe(300);
    });

    it('houdt de bovengrens op 600', () => {
        const { result } = renderHook(() => useChatPanelResize());
        drag(stub<Parameters<typeof drag>[0]>(result), 900, 100);
        expect(result.current.chatWidth).toBe(600);
    });

    it('een rail LINKS telt de andere kant op', () => {
        const { result } = renderHook(() => useChatPanelResize({ side: 'left', initial: 400 }));
        drag(stub<Parameters<typeof drag>[0]>(result), 900, 950);
        expect(result.current.chatWidth).toBe(450);
    });

    it('laat de body-cursor niet achter na het loslaten', () => {
        const { result } = renderHook(() => useChatPanelResize());
        act(() => { result.current.onDragStart(partial<Parameters<typeof result.current.onDragStart>[0]>({ clientX: 900 })); });
        expect(document.body.style.cursor).toBe('col-resize');
        act(() => { window.dispatchEvent(new MouseEvent('mouseup', {})); });
        expect(document.body.style.cursor).toBe('');
    });
});
