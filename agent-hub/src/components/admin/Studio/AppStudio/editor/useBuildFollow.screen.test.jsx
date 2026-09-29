import { act, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useBuildFollow from './useBuildFollow';

// The chapter rule (2026-09-13): the canvas switches to the screen the AI is
// building — before the cells land when the typed batch names its parent —
// unless the person has taken the camera.
const DEF = {
    screens: [
        { id: 'scr_a', name: 'Home', sections: [{ id: 'sec_a1', children: [{ id: 'cmp_x', type: 'heading' }] }] },
        { id: 'scr_b', name: 'Suppliers', sections: [{ id: 'sec_b1', children: [{ id: 'cmp_b', type: 'card', children: [] }] }] },
    ],
};

function surface() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    root.querySelector = vi.fn(() => ({ scrollIntoView: scrollSpy }));
    return root;
}
const scrollSpy = vi.fn();

function mount(initial) {
    const dispatch = vi.fn();
    const root = surface();
    const base = { surfaceRef: { current: root }, reveal: null, toolDraft: null, lastCall: null, definition: DEF, screenId: 'scr_a', dispatch, enabled: true, reducedMotion: false };
    const hook = renderHook((props) => useBuildFollow(props), { initialProps: { ...base, ...initial } });
    return { ...hook, dispatch, root, base };
}

describe('useBuildFollow — the screen being built', () => {
    it('switches to the screen whose section the typed batch names — once, not again on the next render', () => {
        const { result, rerender, dispatch, base } = mount({ toolDraft: { name: 'app_add_components', parentId: 'sec_b1', items: [] } });
        expect(dispatch).toHaveBeenCalledWith({ type: 'set_screen', screenId: 'scr_b' });
        expect(result.current.screen).toEqual({ id: 'scr_b', name: 'Suppliers', reason: 'typing' });
        dispatch.mockClear();
        rerender({ ...base, toolDraft: { name: 'app_add_components', parentId: 'sec_b1', items: [{ kind: 'component' }] } });
        expect(dispatch).not.toHaveBeenCalled();
        // The reducer switched: no further dispatch either.
        rerender({ ...base, screenId: 'scr_b', toolDraft: { name: 'app_add_components', parentId: 'sec_b1', items: [] } });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('a screen the last call added becomes the chapter as soon as the definition carries it', () => {
        const before = { screens: [DEF.screens[0]] };
        const { rerender, dispatch, base } = mount({ definition: before, lastCall: { name: 'app_add_screen', added: [{ id: 'scr_b', type: 'screen', label: 'Suppliers' }] } });
        expect(dispatch).not.toHaveBeenCalled();
        rerender({ ...base, definition: DEF, lastCall: { name: 'app_add_screen', added: [{ id: 'scr_b', type: 'screen', label: 'Suppliers' }] } });
        expect(dispatch).toHaveBeenCalledWith({ type: 'set_screen', screenId: 'scr_b' });
    });

    it('the chapter is sticky across calls that name no screen, and forgotten when the build ends', () => {
        const { result, rerender, base } = mount({ lastCall: { name: 'app_add_components', added: [{ id: 'cmp_b', type: 'card' }] }, reveal: { plan: { ids: ['cmp_b'], screens: [] }, at: 1 }, screenId: 'scr_b' });
        expect(result.current.screen.id).toBe('scr_b');
        rerender({ ...base, screenId: 'scr_b', lastCall: { name: 'app_set_action', added: [] }, reveal: null });
        expect(result.current.screen.id).toBe('scr_b');
        rerender({ ...base, screenId: 'scr_b', enabled: false });
        expect(result.current.screen).toBeNull();
    });

    it('a yielded camera blocks the switch; follow() goes back to the chapter and then scrolls', () => {
        const { result, rerender, dispatch, root, base } = mount({});
        act(() => { fireEvent.wheel(root); });
        expect(result.current.following).toBe(false);
        rerender({ ...base, toolDraft: { name: 'app_add_components', parentId: 'sec_b1', items: [] }, reveal: { plan: { ids: ['cmp_b'], screens: [] }, at: Date.now() } });
        expect(dispatch).not.toHaveBeenCalled();
        expect(result.current.screen.id).toBe('scr_b', 'resolved, just not applied');
        act(() => { result.current.follow(); });
        expect(result.current.following).toBe(true);
        expect(dispatch).toHaveBeenCalledWith({ type: 'set_screen', screenId: 'scr_b' });
        expect(scrollSpy).not.toHaveBeenCalled();
        // The reducer switched → the pending scroll runs against the new DOM.
        rerender({ ...base, screenId: 'scr_b', toolDraft: { name: 'app_add_components', parentId: 'sec_b1', items: [] }, reveal: { plan: { ids: ['cmp_b'], screens: [] }, at: Date.now() } });
        expect(root.querySelector).toHaveBeenCalledWith('[data-node-id="cmp_b"]');
        expect(scrollSpy).toHaveBeenCalled();
    });

    it('reduced motion still switches — it is navigation, not motion', () => {
        const { dispatch } = mount({ reducedMotion: true, toolDraft: { name: 'app_add_components', parentId: 'cmp_b', items: [] } });
        expect(dispatch).toHaveBeenCalledWith({ type: 'set_screen', screenId: 'scr_b' });
    });

    it('nothing happens when the build is not running or nothing names a screen', () => {
        const idle = mount({ enabled: false, toolDraft: { parentId: 'sec_b1' } });
        expect(idle.dispatch).not.toHaveBeenCalled();
        expect(idle.result.current.screen).toBeNull();
        const themed = mount({ lastCall: { name: 'app_set_theme', added: [] } });
        expect(themed.dispatch).not.toHaveBeenCalled();
    });
});
