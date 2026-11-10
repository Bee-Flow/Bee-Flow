import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dynamic text and effects (schema version 3) as the real hook runs them: a toast or confirm whose text is a
 * formula, a navigate whose screen is a formula (an own screen or an error), an open_url whose address is a
 * formula (https on a listed host or an error), a switch case picked by a formula, and the effects of a
 * sequence. A literal step is checked too: it behaves as it always did.
 */

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/components/shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('./components/AppModal', () => ({ openAppModal: vi.fn(), closeAppModal: vi.fn() }));

import useActionRunner from './useActionRunner';
import toast from '@/components/shared/Toast';
import { asMock, stub } from '@/test/mocks';

const SCREENS = [{ id: 'scr_home' }, { id: 'scr_other' }];

async function run(steps: unknown[], extra: Record<string, unknown> = {}, def: Record<string, unknown> = {}) {
    const definition = {
        schemaVersion: 3,
        screens: SCREENS,
        variables: [{ name: 'n', type: 'number', default: 12 }, { name: 'go', type: 'text', default: 'scr_other' }],
        actions: { act_1: { kind: 'sequence', steps, ...extra } },
        ...def,
    };
    const onNavigate = vi.fn();
    const confirm = vi.fn(async () => true);
    const openWindow = vi.fn();
    const realOpen = window.open;
    window.open = openWindow;
    try {
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), { onNavigate, confirm }));
        await act(async () => { await result.current.runAction('act_1'); });
        return { onNavigate, confirm, openWindow, entry: result.current.actionState.act_1 };
    } finally {
        window.open = realOpen;
    }
}

const shown = (fn: unknown) => asMock(fn).mock.calls.map((c) => c[0]);
const resetToasts = () => { asMock(toast.info).mockReset(); asMock(toast.error).mockReset(); asMock(toast.success).mockReset(); };

describe('dynamic text in a sequence', () => {
    beforeEach(resetToasts);
    afterEach(() => { vi.restoreAllMocks(); });

    it('shows a toast whose message is a formula, and the literal when the formula gives nothing', async () => {
        await run([
            { kind: 'toast', messageExpr: "concat('Saved ', vars.n, ' rows')" },
            { kind: 'toast', message: 'plain', tone: 'info' },
            { kind: 'toast', message: 'fallback text', messageExpr: 'vars.missing_thing' },
        ]);
        expect(shown(toast.info)).toEqual(['Saved 12 rows', 'plain', 'fallback text']);
    });

    it('asks the question a confirm formula builds, with its title and button labels', async () => {
        const { confirm } = await run([{ kind: 'confirm', messageExpr: "concat('Delete ', vars.n, '?')", titleExpr: "'Careful'", confirmLabelExpr: "'Delete'", cancelLabel: 'Keep' }]);
        expect(confirm).toHaveBeenCalledTimes(1);
        const asked = asMock(confirm).mock.calls[0][0] as Record<string, unknown>;
        expect(asked).toMatchObject({ message: 'Delete 12?', title: 'Careful', confirmLabel: 'Delete', cancelLabel: 'Keep' });
    });

    it('passes a literal confirm to the dialog untouched', async () => {
        const step = { kind: 'confirm', message: 'Sure?', title: 'Hold on' };
        const { confirm } = await run([step]);
        expect(asMock(confirm).mock.calls[0][0]).toEqual(step);
    });

    it('opens the screen a formula names when the app has it', async () => {
        const { onNavigate } = await run([{ kind: 'navigate', screenExpr: 'vars.go' }]);
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(asMock(onNavigate).mock.calls[0][0]).toBe('scr_other');
    });

    it('stops with an error for a screen the app does not have, and never navigates', async () => {
        const { onNavigate } = await run([{ kind: 'navigate', screenExpr: "'/admin/users'" }, { kind: 'toast', message: 'not reached' }]);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(shown(toast.error).join(' ')).toMatch(/not part of this app/);
        expect(shown(toast.info)).toEqual([]);
    });

    it('opens a formula address on a listed https host and refuses everything else', async () => {
        const allowed = { allowedLinkHosts: ['example.com'] };
        const ok = await run([{ kind: 'open_url', urlExpr: "concat('https://example.com/o/', vars.n)" }], {}, allowed);
        expect(asMock(ok.openWindow).mock.calls[0][0]).toBe('https://example.com/o/12');

        for (const url of ["'http://example.com/'", "'https://evil.test/'", "'https://example.com:8443/'", "'https://user:pw@example.com/'", "'javascript:alert(1)'", "'/relative'"]) {
            resetToasts();
            const bad = await run([{ kind: 'open_url', urlExpr: url }], {}, allowed);
            expect(bad.openWindow, url).not.toHaveBeenCalled();
            expect(shown(toast.error).length, url).toBe(1);
        }
    });

    it('opens no formula address at all while the app lists no hosts', async () => {
        const { openWindow } = await run([{ kind: 'open_url', urlExpr: "'https://example.com/'" }]);
        expect(openWindow).not.toHaveBeenCalled();
        expect(shown(toast.error).join(' ')).toMatch(/allowed hosts/);
    });

    it('keeps opening a literal https url exactly as before', async () => {
        const { openWindow } = await run([{ kind: 'open_url', url: 'https://example.com/a', newTab: true }]);
        expect(asMock(openWindow).mock.calls[0]).toEqual(['https://example.com/a', '_blank', 'noopener,noreferrer']);
    });

    it('runs the first switch case that matches, by value or by its formula', async () => {
        const steps = [{ kind: 'switch', expr: 'vars.n', cases: [
            { value: 5, steps: [{ kind: 'toast', message: 'five' }] },
            { whenExpr: 'vars.n >= 10', steps: [{ kind: 'toast', message: 'ten or more' }] },
            { whenExpr: 'vars.n >= 1', steps: [{ kind: 'toast', message: 'one or more' }] },
        ], default: [{ kind: 'toast', message: 'default' }] }];
        await run(steps);
        expect(shown(toast.info)).toEqual(['ten or more']);
        resetToasts();
        await run([{ ...steps[0], expr: '5' }]);
        expect(shown(toast.info)).toEqual(['five']);
    });

    it('still reads a case with a stray `when` as it always did', async () => {
        await run([{ kind: 'switch', expr: '7', cases: [{ when: 'true', steps: [{ kind: 'toast', message: 'wrong' }] }], default: [{ kind: 'toast', message: 'default' }] }]);
        expect(shown(toast.info)).toEqual(['default']);
    });
});

describe('effects after a sequence', () => {
    beforeEach(resetToasts);

    it('applies onSuccess once the steps have run', async () => {
        const { onNavigate } = await run([{ kind: 'toast', message: 'step' }], { onSuccess: { toast: { message: 'All done', tone: 'success' }, navigateTo: 'scr_other' } });
        expect(shown(toast.info)).toEqual(['step']);
        expect(shown(toast.success)).toEqual(['All done']);
        expect(asMock(onNavigate).mock.calls[0][0]).toBe('scr_other');
    });

    it('applies onError, not onSuccess, when a step fails', async () => {
        const { onNavigate } = await run([{ kind: 'navigate', screenExpr: "'scr_nowhere'" }], {
            onSuccess: { toast: { message: 'fine', tone: 'success' } },
            onError: { toast: { message: 'It went wrong', tone: 'danger' }, navigateTo: 'scr_home' },
        });
        expect(shown(toast.success)).toEqual([]);
        expect(shown(toast.error)).toContain('It went wrong');
        expect(asMock(onNavigate).mock.calls.map((c) => c[0])).toEqual(['scr_home']);
    });
});
