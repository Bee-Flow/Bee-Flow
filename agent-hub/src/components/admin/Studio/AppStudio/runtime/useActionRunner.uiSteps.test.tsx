import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useActionRunner from './useActionRunner';
import AppRenderer from './AppRenderer';
import { stub } from '@/test/mocks';
import toast from '@/components/shared/Toast';
import { registerFormFieldSetter } from './formContext';
import { getUiSnapshot, publishUiState, registerUiSetter, resetUiStateForTests } from './uiState';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * App Studio runtime — the browser steps of schema 3 through the real sequence
 * coordinator (server/appStudio/componentSpecs/steps: set_form_field, focus,
 * scroll_to, copy_to_clipboard, set_ui, back, wait) and the `ui` root in a step
 * formula. Real @shared/expr, resolveBinding, buildScope, modal bus and ui state
 * store; no step here reaches the network.
 */

type Def = Parameters<typeof useActionRunner>[1];
const stat = (value: unknown) => ({ kind: 'static', value });
const seq = (steps: unknown[], extra: Record<string, unknown> = {}) => stub<Def>({ schemaVersion: 3, actions: { go: { kind: 'sequence', steps } }, ...extra });

describe('useActionRunner — browser steps of schema 3', () => {
    beforeEach(() => { resetUiStateForTests(); });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('set_form_field puts the resolved value into the mounted form by name', async () => {
        const setter = vi.fn();
        const off = registerFormFieldSetter('order', setter);
        const { result } = renderHook(() => useActionRunner('app1', seq([
            { kind: 'set_variable', name: 'n', value: stat(4) },
            { kind: 'set_form_field', form: 'order', field: 'quantity', value: { kind: 'formula', expr: 'vars.n * 2' } },
            { kind: 'set_form_field', form: 'nobody', field: 'quantity', value: stat(1) },
        ])));
        await act(async () => { await result.current.runAction('go'); });
        off();
        expect(setter).toHaveBeenCalledTimes(1);
        expect(setter).toHaveBeenCalledWith('quantity', 8);
        expect(result.current.actionState.go?.status).not.toBe('error');
    });

    it('set_ui opens and closes a mounted modal through its bus and hands a tab value to the store', async () => {
        const modalApp = stub<AppDefinition>({
            schemaVersion: 3, homeScreenId: 'scr_t', actions: {},
            screens: [{ id: 'scr_t', name: 'T', sections: [{ id: 'sec_t', style: {}, children: [
                { id: 'cmp_modal', type: 'modal', visible: true, props: { title: 'Details', showTrigger: false }, style: {}, children: [] },
            ] }] }],
        });
        render(<AppRenderer definition={modalApp} screenId="scr_t" mode="run" />);
        const tabSetter = vi.fn();
        const off = registerUiSetter('activeTab', 'cmp_tabs', tabSetter);
        const open = renderHook(() => useActionRunner('app1', seq([
            { kind: 'set_ui', nodeId: 'cmp_modal', state: 'open', value: stat(true) },
            { kind: 'set_ui', nodeId: 'cmp_tabs', state: 'activeTab', value: stat('cmp_tab_b') },
        ])));
        await act(async () => { await open.result.current.runAction('go'); });
        expect(getUiSnapshot().modals.cmp_modal).toEqual({ open: true });
        expect(tabSetter).toHaveBeenCalledWith('cmp_tab_b');
        const close = renderHook(() => useActionRunner('app1', seq([
            { kind: 'set_ui', nodeId: 'cmp_modal', state: 'open', value: stat(false) },
        ])));
        await act(async () => { await close.result.current.runAction('go'); });
        expect(getUiSnapshot().modals.cmp_modal).toEqual({ open: false });
        off();
    });

    it('a step formula reads the ui root when the definition reads it', async () => {
        publishUiState('activeTab', 'cmp_tabs', 'cmp_tab_b', Symbol('t'));
        const { result } = renderHook(() => useActionRunner('app1', seq([
            { kind: 'condition', expr: "ui.tabs.cmp_tabs.active == 'cmp_tab_b'", then: [{ kind: 'set_variable', name: 'hit', value: stat('yes') }], else: [] },
        ])));
        await act(async () => { await result.current.runAction('go'); });
        expect(result.current.vars.hit).toBe('yes');
    });

    it('back returns to the previous screen with its params; at the start of a visit it does nothing', async () => {
        const onNavigate = vi.fn();
        const definition = seq([{ kind: 'back' }]);
        const { result, rerender } = renderHook(({ screen }) => useActionRunner('app1', definition, { onNavigate, screen }), {
            initialProps: { screen: { id: 'scr_list', params: {} } as Record<string, unknown> },
        });
        await act(async () => { await result.current.runAction('go'); });
        expect(onNavigate).not.toHaveBeenCalled();
        rerender({ screen: { id: 'scr_detail', params: { recordId: 'r1' } } });
        rerender({ screen: { id: 'scr_detail', params: { recordId: 'r2' } } });
        await act(async () => { await result.current.runAction('go'); });
        expect(onNavigate).toHaveBeenLastCalledWith('scr_detail', { recordId: 'r1' });
        rerender({ screen: { id: 'scr_detail', params: { recordId: 'r1' } } });
        await act(async () => { await result.current.runAction('go'); });
        expect(onNavigate).toHaveBeenLastCalledWith('scr_list', {});
    });

    it('copy_to_clipboard writes the text; a refused write fails the step and ends the sequence', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        const { result } = renderHook(() => useActionRunner('app1', seq([
            { kind: 'copy_to_clipboard', text: { kind: 'formula', expr: "'REF-' + 12" } },
            { kind: 'copy_to_clipboard', text: stat({ a: 1 }) },
        ])));
        await act(async () => { await result.current.runAction('go'); });
        expect(writeText).toHaveBeenNthCalledWith(1, 'REF-12');
        expect(writeText).toHaveBeenNthCalledWith(2, '{"a":1}');

        writeText.mockImplementation(() => Promise.reject(new Error('denied')));
        const shown = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        const handled = renderHook(() => useActionRunner('app1', seq([
            { kind: 'copy_to_clipboard', text: stat('x') },
            { kind: 'set_variable', name: 'after', value: stat(true) },
        ])));
        await act(async () => { await handled.result.current.runAction('go'); });
        expect(handled.result.current.vars.after).toBeUndefined();
        expect(shown).toHaveBeenCalledWith('The text could not be copied to the clipboard.');
        shown.mockRestore();
    });

    it('focus puts the cursor in the first field of the component; scroll_to scrolls; a missing node is skipped', async () => {
        document.body.innerHTML = '<div class="app-runtime"><div data-node-id="cmp_box"><label>Q</label><input id="q" /></div><div data-node-id="cmp_far"></div></div>';
        const scrolled: string[] = [];
        Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this.getAttribute('data-node-id') || this.className); };
        const { result } = renderHook(() => useActionRunner('app1', seq([
            { kind: 'focus', nodeId: 'cmp_box' },
            { kind: 'scroll_to', nodeId: 'cmp_far' },
            { kind: 'scroll_to', nodeId: 'top' },
            { kind: 'focus', nodeId: 'cmp_gone' },
        ])));
        await act(async () => { await result.current.runAction('go'); });
        expect(document.activeElement?.id).toBe('q');
        expect(scrolled).toEqual(['cmp_far', 'app-runtime']);
        expect(result.current.actionState.go?.status).not.toBe('error');
    });

    it('wait holds the next step back for its seconds', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useActionRunner('app1', seq([
            { kind: 'wait', seconds: 3 },
            { kind: 'set_variable', name: 'after', value: stat(1) },
        ])));
        let done = false;
        await act(async () => { void result.current.runAction('go').then(() => { done = true; }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(2900); });
        expect(done).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(done).toBe(true);
        expect(result.current.vars.after).toBe(1);
    });
});
