import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useAppVariables, { type AppVariablesInputs } from './useAppVariables';
import { persistKeyFor, readPersistedVariables, writePersistedVariables } from './persistedVariables';

/** The schema 3 keys of a declared variable in the browser: screen, kept and derived variables. */

const decl = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, type: 'number', default: 0, description: '', ...extra });
const def = (variables: unknown[]) => ({ schemaVersion: 3, variables });

interface Props { d: ReturnType<typeof def>; screenId: string; inputs?: Partial<AppVariablesInputs> }

function mount(d: ReturnType<typeof def>, inputs: Partial<AppVariablesInputs> = {}) {
    return renderHook(
        ({ d: definition, screenId, inputs: more }: Props) => useAppVariables(definition, { actionState: {}, screen: { id: screenId, params: {} }, ...more }),
        { initialProps: { d, screenId: 'scr_a', inputs } },
    );
}

afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
});

describe('useAppVariables', () => {
    it('an app without the schema 3 keys keeps one state object and the caller’s navigate', () => {
        const onNavigate = vi.fn();
        const { result, rerender } = mount(def([decl('a', { default: 1 })]), { onNavigate });
        const first = result.current.vars;
        expect(first).toEqual({ a: 1 });
        expect(result.current.onNavigate).toBe(onNavigate);
        expect(result.current.deriveVars).toBeNull();
        rerender({ d: def([decl('a', { default: 1 })]), screenId: 'scr_a', inputs: { onNavigate } });
        expect(result.current.vars).toBe(first);
    });

    it('works derived variables out over the live state, and a write to one changes nothing', () => {
        const { result } = mount(def([decl('qty', { default: 2 }), decl('total', { derived: { expr: 'vars.qty * 10' } })]));
        expect(result.current.vars).toEqual({ qty: 2, total: 20 });
        act(() => { result.current.setVars((prev) => ({ ...prev, qty: 3, total: 999 })); });
        expect(result.current.vars).toEqual({ qty: 3, total: 30 });
    });

    it('a derived formula reads forms and the screen too', () => {
        const { result } = mount(def([decl('label', { type: 'text', default: '', derived: { expr: 'forms.cmp_f.name + "@" + screen.id' } })]), {
            forms: { cmp_f: { name: 'Ann' } },
        });
        expect(result.current.vars.label).toBe('Ann@scr_a');
        expect(result.current.deriveVars?.({ vars: {}, forms: { cmp_f: { name: 'Bo' } }, screen: { id: 'x' } } as never)).toEqual({ label: 'Bo@x' });
    });

    it('a screen variable goes back to its default when another screen opens', () => {
        const d = def([decl('tab', { type: 'text', default: 'one', scope: 'screen' }), decl('kept', { default: 1 })]);
        const { result, rerender } = mount(d);
        act(() => { result.current.setVars((prev) => ({ ...prev, tab: 'two', kept: 5 })); });
        rerender({ d, screenId: 'scr_a', inputs: {} });
        expect(result.current.vars).toEqual({ tab: 'two', kept: 5 });
        rerender({ d, screenId: 'scr_b', inputs: {} });
        expect(result.current.vars).toEqual({ tab: 'one', kept: 5 });
    });

    it('a navigate resets first, so a value written right after it is the new screen’s', () => {
        const d = def([decl('tab', { type: 'text', default: 'one', scope: 'screen' })]);
        const onNavigate = vi.fn();
        const { result, rerender } = mount(d, { onNavigate });
        act(() => { result.current.setVars((prev) => ({ ...prev, tab: 'old' })); });
        act(() => {
            result.current.onNavigate?.('scr_b', { id: 1 });
            result.current.setVars((prev) => ({ ...prev, tab: 'set-after-navigate' }));
        });
        expect(onNavigate).toHaveBeenCalledWith('scr_b', { id: 1 });
        rerender({ d, screenId: 'scr_b', inputs: { onNavigate } });
        expect(result.current.vars.tab).toBe('set-after-navigate');
    });

    it('a kept variable is read at mount and written back, only with a key', () => {
        const d = def([decl('page', { persist: 'local' }), decl('draft', { type: 'text', default: '', persist: 'session' }), decl('plain')]);
        const key = persistKeyFor('app1', { id: 'u1' }, false);
        writePersistedVariables(key, d.variables, { page: 4, draft: 'hello', plain: 9 });
        const { result } = mount(d, { persistKey: key });
        expect(result.current.vars).toEqual({ page: 4, draft: 'hello', plain: 0 });
        act(() => { result.current.setVars((prev) => ({ ...prev, page: 7 })); });
        expect(readPersistedVariables(key, d.variables)).toEqual({ page: 7, draft: 'hello' });
        expect(JSON.parse(window.localStorage.getItem(`bfa.vars.${key}`) || '{}')).toEqual({ page: 7 });
        expect(JSON.parse(window.sessionStorage.getItem(`bfa.vars.${key}`) || '{}')).toEqual({ draft: 'hello' });

        const anonymous = mount(d, { persistKey: persistKeyFor('app1', null, false) });
        expect(anonymous.result.current.vars).toEqual({ page: 0, draft: '', plain: 0 });
    });
});

describe('persistedVariables', () => {
    it('keys a signed-in viewer per app, a draft apart, and nobody else', () => {
        expect(persistKeyFor('app1', { id: 'u1' }, false)).toBe('app1.u1');
        expect(persistKeyFor('app1', { id: 'u1' }, true)).toBe('app1.u1.draft');
        expect(persistKeyFor('app1', null, false)).toBeNull();
        expect(persistKeyFor('app1', { id: '' }, false)).toBeNull();
        expect(persistKeyFor(null, { id: 'u1' }, false)).toBeNull();
    });

    it('a stored value of the wrong type, or an undeclared name, is not read', () => {
        const variables = [decl('page', { persist: 'local' })];
        window.localStorage.setItem('bfa.vars.k', JSON.stringify({ page: 'not a number', other: 1 }));
        expect(readPersistedVariables('k', variables)).toEqual({});
        window.localStorage.setItem('bfa.vars.k', '{broken');
        expect(readPersistedVariables('k', variables)).toEqual({});
    });

    it('keeps what fits under the ceiling, the variables declared first first', () => {
        const variables = [decl('big', { type: 'text', default: '', persist: 'local' }), decl('small', { persist: 'local' })];
        writePersistedVariables('k', variables, { big: 'x'.repeat(20000), small: 3 });
        expect(readPersistedVariables('k', variables)).toEqual({ small: 3 });
    });
});
