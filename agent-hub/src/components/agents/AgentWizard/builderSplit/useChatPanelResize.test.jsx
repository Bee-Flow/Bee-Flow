/**
 * De sleepgreep van de verfijn-rail (A2 stap 1).
 *
 * De rail verhuisde van links naar RECHTS. Dat is niet alleen een andere
 * startbreedte: de greep zit nu aan de linkerkant van de rail, dus naar
 * LINKS slepen moet hem BREDER maken. Zonder deze test is de enige manier om
 * een omgedraaid teken te merken het handmatig slepen in een browser.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/useChatPanelResize.test.jsx
 */
import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';

import useChatPanelResize from './useChatPanelResize';

afterEach(() => cleanup());

function drag(result, from, to) {
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
        drag(result, 900, 800);
        expect(result.current.chatWidth).toBe(460);
    });

    it('rail rechts: naar rechts slepen maakt hem smaller, tot de ondergrens van 300', () => {
        const { result } = renderHook(() => useChatPanelResize());
        drag(result, 900, 940);
        expect(result.current.chatWidth).toBe(320);
        drag(result, 940, 1400);
        expect(result.current.chatWidth).toBe(300);
    });

    it('houdt de bovengrens op 600', () => {
        const { result } = renderHook(() => useChatPanelResize());
        drag(result, 900, 100);
        expect(result.current.chatWidth).toBe(600);
    });

    it('een rail LINKS telt de andere kant op', () => {
        const { result } = renderHook(() => useChatPanelResize({ side: 'left', initial: 400 }));
        drag(result, 900, 950);
        expect(result.current.chatWidth).toBe(450);
    });

    it('laat de body-cursor niet achter na het loslaten', () => {
        const { result } = renderHook(() => useChatPanelResize());
        act(() => { result.current.onDragStart({ clientX: 900 }); });
        expect(document.body.style.cursor).toBe('col-resize');
        act(() => { window.dispatchEvent(new MouseEvent('mouseup', {})); });
        expect(document.body.style.cursor).toBe('');
    });
});
