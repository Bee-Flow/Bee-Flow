import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Studio runtime — useActionRunner as a v2 SEQUENCE COORDINATOR.
 *
 * Real @shared/expr + resolveBinding + buildScope; authFetch and Toast are
 * mocked, and openAppModal is spied. Covers: confirm-gate abort, set_variable
 * threading, condition branch selection, server-step dispatch + result
 * threading, open_modal wiring, and v1 single-action back-compat (the legacy
 * /run bridge must be untouched).
 */

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/components/shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('./components/AppModal', () => ({ openAppModal: vi.fn(), closeAppModal: vi.fn() }));

import { openAppModal } from './components/AppModal';
import useActionRunner from './useActionRunner';
import { authFetch } from '@/utils/helpers';
import toast from '@/components/shared/Toast';
import { asMock, stub } from '@/test/mocks';

const resp = (status: number, body: unknown, ok = status >= 200 && status < 300) => ({ ok, status, json: async () => body });

// Parse the JSON body of the Nth authFetch POST.
function bodyOfCall(i = 0) {
    const call = asMock(authFetch).mock.calls[i];
    return JSON.parse(call[1].body);
}
function urlOfCall(i = 0) {
    return String(asMock(authFetch).mock.calls[i][0]);
}

function def(actions: Record<string, unknown>) {
    return { schemaVersion: 2, actions };
}

describe('useActionRunner — v2 sequence coordinator', () => {
    beforeEach(() => {
        asMock(authFetch).mockReset();
        asMock(toast.success).mockReset();
        asMock(toast.error).mockReset();
        asMock(toast.info).mockReset();
        asMock(openAppModal).mockReset();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('confirm gate: a declined confirm ABORTS the sequence — the later server step never dispatches', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec_new' } }));
        const confirmMock = vi.fn(() => Promise.resolve(false));
        const definition = def({
            seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'confirm', message: 'Sure?' },
                    { kind: 'create_record', tableId: 't', values: {} },
                ],
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), { confirm: confirmMock }));

        await act(async () => { await result.current.runAction('seq'); });

        expect(confirmMock).toHaveBeenCalledTimes(1);
        expect(authFetch).not.toHaveBeenCalled();           // create_record never dispatched
        expect(result.current.actionState.seq?.status).not.toBe('error');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('confirm gate: an accepted confirm lets the sequence proceed to the server step', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec_new' } }));
        const definition = def({
            seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'confirm', message: 'Sure?' },
                    { kind: 'create_record', tableId: 't', values: {} },
                ],
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), { confirm: () => Promise.resolve(true) }));

        await act(async () => { await result.current.runAction('seq'); });

        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(urlOfCall(0)).toContain('/actions/seq/step');
        expect(result.current.actionState.seq.status).toBe('success');
    });

    it('set_variable threads into a later server step body', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec_new' } }));
        const definition = def({
            seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'set_variable', name: 'priority', value: { kind: 'static', value: 5 } },
                    { kind: 'create_record', tableId: 't', values: {} },
                ],
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('seq', { formValues: { a: 1 } }); });

        expect(authFetch).toHaveBeenCalledTimes(1);
        const body = bodyOfCall(0);
        expect(body.stepIndex).toBe(1);
        expect(body.vars).toEqual({ priority: 5 });
        expect(body.formValues).toEqual({ a: 1 });
    });

    it('condition: only the taken branch runs — the else branch server step never dispatches', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec_new' } }));
        const definition = def({
            seq: {
                kind: 'sequence',
                steps: [{
                    kind: 'condition', expr: 'form.go == true',
                    then: [{ kind: 'create_record', tableId: 't', values: {} }],   // pre-order index 1
                    else: [{ kind: 'delete_record', tableId: 't', recordId: { kind: 'static', value: 'r' } }], // index 2
                }],
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('seq', { formValues: { go: true } }); });

        expect(authFetch).toHaveBeenCalledTimes(1);
        // The dispatched step is the `then` branch's create_record at index 1.
        expect(bodyOfCall(0).stepIndex).toBe(1);
    });

    it('server step dispatch: the result threads into vars for a later server step', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec_new' } }));
        const definition = def({
            seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'create_record', tableId: 't', values: {}, resultVar: 'created' }, // index 0
                    { kind: 'update_record', tableId: 't', recordId: { kind: 'formula', expr: 'vars.created.id' }, values: {} }, // index 1
                ],
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('seq'); });

        expect(authFetch).toHaveBeenCalledTimes(2);
        expect(bodyOfCall(0).stepIndex).toBe(0);
        // The second dispatch carries the first step's result threaded under `created`.
        const second = bodyOfCall(1);
        expect(second.stepIndex).toBe(1);
        expect(second.vars.created).toEqual({ id: 'rec_new' });
        expect(result.current.actionState.seq.status).toBe('success');
        expect(result.current.actionState.seq.result).toEqual({ id: 'rec_new' });
    });

    it('a failing server step aborts the sequence, sets error state and toasts', async () => {
        asMock(authFetch).mockImplementation((url: string) => {
            if (String(url).includes('/step')) {
                if (asMock(authFetch).mock.calls.length === 1) return Promise.resolve(resp(200, { ok: false, error: 'Record not found' }));
            }
            return Promise.resolve(resp(200, { ok: true, result: { id: 'rec_2' } }));
        });
        const definition = def({
            seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'create_record', tableId: 't', values: {} },       // fails
                    { kind: 'create_record', tableId: 't', values: {} },       // must NOT run
                ],
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('seq'); });

        expect(authFetch).toHaveBeenCalledTimes(1);   // aborted after the first failure
        expect(result.current.actionState.seq.status).toBe('error');
        expect(result.current.actionState.seq.error).toMatch(/not found/i);
        expect(toast.error).toHaveBeenCalled();
    });

    it('open_modal calls openAppModal (pure-client sequence, no dispatch, no spinner)', async () => {
        const definition = def({ seq: { kind: 'sequence', steps: [{ kind: 'open_modal', modalId: 'mod_1' }] } });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('seq'); });

        expect(openAppModal).toHaveBeenCalledWith('mod_1');
        expect(authFetch).not.toHaveBeenCalled();
        expect(result.current.actionState.seq).toBeUndefined(); // no running state for pure-client work
    });

    it('navigate step calls onNavigate; a bare v1 open_modal action still works', async () => {
        const onNavigate = vi.fn();
        const definition = def({
            seq: { kind: 'sequence', steps: [{ kind: 'navigate', screenId: 'scr_2' }] },
            bareModal: { kind: 'open_modal', modalId: 'mod_bare' },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), { onNavigate }));

        await act(async () => { await result.current.runAction('seq'); });
        expect(onNavigate).toHaveBeenCalledWith('scr_2', {});

        await act(async () => { await result.current.runAction('bareModal'); });
        expect(openAppModal).toHaveBeenCalledWith('mod_bare');
    });

    // ── v1 back-compat: the legacy /run bridge is untouched ─────────────────────
    it('v1 single-action back-compat: a bare run_automation still POSTs to /run and applies onSuccess', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { status: 'success', result: { count: 3 } }));
        const definition = def({
            act_run: {
                kind: 'run_automation',
                automationId: 'auto-1',
                onSuccess: { toast: { tone: 'success', message: 'Done' } },
            },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('act_run'); });

        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(urlOfCall(0)).toContain('/actions/act_run/run');   // legacy /run, NOT /step
        expect(urlOfCall(0)).not.toContain('/step');
        expect(result.current.actionState.act_run.status).toBe('success');
        expect(result.current.actionState.act_run.result).toEqual({ count: 3 });
        expect(toast.success).toHaveBeenCalledWith('Done');
    });

    it('a bare run_automation as a SEQUENCE step dispatches to /step (not /run)', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { runId: 'r1', output: { ok: 1 } } }));
        const definition = def({
            seq: { kind: 'sequence', steps: [{ kind: 'run_automation', automationId: 'auto-1', resultVar: 'out' }] },
        });
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));

        await act(async () => { await result.current.runAction('seq'); });

        expect(urlOfCall(0)).toContain('/actions/seq/step');
        expect(result.current.actionState.seq.status).toBe('success');
    });
});

// ── call_action: one action runs another as a subroutine ────────────────────
// A server step inside a called action posts to the ROOT action's URL with
// callPath + params; cycles and too-deep chains are refused before any request.

type Def = Parameters<typeof useActionRunner>[1];
const callDef = (actions: Record<string, unknown>) => stub<Def>({ schemaVersion: 2, actions });

describe('useActionRunner — call_action', () => {
    beforeEach(() => {
        asMock(authFetch).mockReset();
        for (const fn of [toast.success, toast.error, toast.info]) asMock(fn).mockReset();
    });

    it('spec: a called action\'s server step posts to the ROOT with callPath and params; the result lands in resultVar for a later step', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { double: 4 } }));
        const definition = callDef({
            main: { kind: 'sequence', steps: [
                { kind: 'toast', message: 'start' },
                { kind: 'call_action', actionId: 'calc', params: { n: { kind: 'formula', expr: '1 + 1' } }, resultVar: 'calc' },
                { kind: 'set_variable', name: 'total', value: { kind: 'formula', expr: 'vars.calc.double' } },
            ] },
            calc: { kind: 'sequence', steps: [
                { kind: 'toast', tone: 'success', message: 'inside' },
                { kind: 'create_record', tableId: 't', values: {} },
            ] },
        });
        const { result } = renderHook(() => useActionRunner('app1', definition));
        await act(async () => { await result.current.runAction('main'); });

        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(urlOfCall(0)).toContain('/actions/main/step');
        const body = bodyOfCall(0);
        expect(body.stepIndex).toBe(1);
        expect(body.callPath).toEqual([1]);
        expect(body.params).toEqual({ n: 2 });
        expect(toast.success).toHaveBeenCalledWith('inside');
        expect(result.current.vars.calc).toEqual({ double: 4 });
        expect(result.current.vars.total).toBe(4);
        expect(result.current.actionState.main?.status).toBe('success');
    });

    it('the spinner and beforeServerStep fire when the only server step is in the called action', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'r1' } }));
        const beforeServerStep = vi.fn(async () => ({ ok: true }));
        const definition = callDef({
            main: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'save' }] },
            save: { kind: 'create_record', tableId: 't', values: {} },
        });
        const { result } = renderHook(() => useActionRunner('app1', definition, { beforeServerStep }));
        await act(async () => { await result.current.runAction('main'); });
        expect(beforeServerStep).toHaveBeenCalledTimes(1);
        expect(bodyOfCall(0).callPath).toEqual([0]);
        expect(bodyOfCall(0).params).toBeUndefined();
        expect(result.current.actionState.main?.status).toBe('success');
    });

    it('a bare call_action on a button runs the called action', async () => {
        const definition = callDef({
            btn: { kind: 'call_action', actionId: 'hello', params: { who: { kind: 'static', value: 'Ada' } } },
            hello: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'greeting', value: { kind: 'formula', expr: 'params.who' } }] },
        });
        const { result } = renderHook(() => useActionRunner('app1', definition));
        await act(async () => { await result.current.runAction('btn'); });
        expect(result.current.vars.greeting).toBe('Ada');
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('item is not inherited by the called action (pass it as a param)', async () => {
        const definition = callDef({
            main: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'sub', params: { row: { kind: 'formula', expr: 'item' } } }] },
            sub: { kind: 'sequence', steps: [
                { kind: 'set_variable', name: 'inner', value: { kind: 'formula', expr: 'item' } },
                { kind: 'set_variable', name: 'passed', value: { kind: 'formula', expr: 'params.row.id' } },
            ] },
        });
        const { result } = renderHook(() => useActionRunner('app1', definition));
        await act(async () => { await result.current.runAction('main', { item: { id: 'r7' } }); });
        expect(result.current.vars.inner ?? null).toBeNull();
        expect(result.current.vars.passed).toBe('r7');
    });

    it('a cycle is refused with the i18n message and no request', async () => {
        const definition = callDef({
            a: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'b' }, { kind: 'create_record', tableId: 't', values: {} }] },
            b: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'a' }] },
        });
        const { result } = renderHook(() => useActionRunner('app1', definition));
        await act(async () => { await result.current.runAction('a'); });
        expect(authFetch).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith('An action cannot run itself, directly or through another action.');
    });

    it('more than three calls deep, or a missing action, is refused with no request', async () => {
        const chain: Record<string, unknown> = {};
        for (let i = 0; i < 5; i++) chain[`a${i}`] = { kind: 'sequence', steps: [i < 4 ? { kind: 'call_action', actionId: `a${i + 1}` } : { kind: 'create_record', tableId: 't', values: {} }] };
        const { result } = renderHook(() => useActionRunner('app1', callDef(chain)));
        await act(async () => { await result.current.runAction('a0'); });
        expect(authFetch).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith('Actions call each other more than 3 levels deep.');

        asMock(toast.error).mockReset();
        const missing = renderHook(() => useActionRunner('app1', callDef({ m: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'gone' }] } })));
        await act(async () => { await missing.result.current.runAction('m'); });
        expect(toast.error).toHaveBeenCalledWith('This step runs an action that no longer exists.');
    });
});
