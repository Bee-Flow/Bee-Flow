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

// ── Step error handling: onError handlers, retry, the error scope, transaction vars ──

const runSeq = async (actions: Record<string, unknown>, id = 'seq') => {
    const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>({ schemaVersion: 2, actions })));
    await act(async () => { await result.current.runAction(id); });
    return result;
};
const AI_DOWN = { ok: false, error: 'The AI provider had a temporary problem. Try again.', code: 'provider_unavailable', retryable: true };

describe('useActionRunner — step error handling', () => {
    beforeEach(() => {
        asMock(authFetch).mockReset();
        asMock(toast.error).mockReset();
        asMock(toast.success).mockReset();
        asMock(toast.info).mockReset();
    });

    it('spec: a failing ai_generate with onError [set_variable fallback, create_record] runs the handler with error in the body and continues, no error toast', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(200, AI_DOWN))
            .mockResolvedValueOnce(resp(200, { ok: true, result: { id: 'rec_1' } }))
            .mockResolvedValueOnce(resp(200, { ok: true, result: { id: 'rec_2' } }));
        const result = await runSeq({
            seq: { kind: 'sequence', steps: [
                { kind: 'ai_generate', prompt: 'x', resultVar: 'draft', onError: { steps: [
                    { kind: 'set_variable', name: 'fallback', value: { kind: 'formula', expr: 'error.message' } },
                    { kind: 'create_record', tableId: 't', values: {} },
                ] } },
                { kind: 'create_record', tableId: 't', values: {} },
            ] },
        });
        expect(authFetch).toHaveBeenCalledTimes(3);
        const handlerBody = bodyOfCall(1);
        // ordinals: ai_generate 0, the later create_record 1, then the handler: set_variable 2, create_record 3
        expect(handlerBody.stepIndex).toBe(3);
        expect(handlerBody.error).toEqual({ message: AI_DOWN.error, step: 'ai_generate', code: 'provider_unavailable', attempts: 1, stepIndex: 0 });
        expect(handlerBody.vars.fallback).toBe(AI_DOWN.error);
        const lastBody = bodyOfCall(2);
        expect(lastBody.stepIndex).toBe(1);
        expect(lastBody.error).toBeUndefined();
        expect(lastBody.vars.fallback).toBe(AI_DOWN.error);
        expect(toast.error).not.toHaveBeenCalled();
        expect(result.current.actionState.seq?.status).toBe('success');
    });

    it('spec: retry times 1 → two POSTs and success', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(200, { ok: false, error: 'busy', code: 'db_busy', retryable: true }))
            .mockResolvedValueOnce(resp(200, { ok: true, result: { id: 'rec_1' } }));
        const result = await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {}, retry: { times: 1, delayMs: 0 }, resultVar: 'row' }] } });
        expect(authFetch).toHaveBeenCalledTimes(2);
        expect(bodyOfCall(1).stepIndex).toBe(0);
        expect(result.current.actionState.seq?.status).toBe('success');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('retryable:false is posted once; a 5xx is retried, a 4xx is not', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: false, error: 'Record not found', retryable: false }));
        await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 't', values: {}, retry: { times: 3, delayMs: 0 } }] } });
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(toast.error).toHaveBeenCalledWith('Record not found');

        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValueOnce(resp(503, { error: 'unavailable' })).mockResolvedValueOnce(resp(200, { ok: true, result: null }));
        await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 't', values: {}, retry: { times: 1, delayMs: 0 } }] } });
        expect(authFetch).toHaveBeenCalledTimes(2);

        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValue(resp(400, { error: 'stepIndex is the position of the step in the action.' }));
        await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 't', values: {}, retry: { times: 2, delayMs: 0 } }] } });
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it('an aborted request (unknown outcome) is never retried', async () => {
        asMock(authFetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        const result = await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {}, retry: { times: 3, delayMs: 0 } }] } });
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(result.current.actionState.seq?.status).toBe('error');
    });

    it('no onError: a failure stops the sequence with its reason, as before', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, AI_DOWN));
        const result = await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x' }, { kind: 'create_record', tableId: 't', values: {} }] } });
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(toast.error).toHaveBeenCalledWith(AI_DOWN.error);
        expect(result.current.actionState.seq).toMatchObject({ status: 'error', error: AI_DOWN.error });
    });

    it('stop: true and the legacy array run the handler and then end quietly', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, AI_DOWN));
        await runSeq({ seq: { kind: 'sequence', steps: [
            { kind: 'ai_generate', prompt: 'x', onError: { steps: [{ kind: 'toast', message: 'We will try later', tone: 'info' }], stop: true } },
            { kind: 'create_record', tableId: 't', values: {} },
        ] } });
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(toast.info).toHaveBeenCalledWith('We will try later');
        expect(toast.error).not.toHaveBeenCalled();

        asMock(authFetch).mockClear();
        asMock(toast.info).mockClear();
        await runSeq({ seq: { kind: 'sequence', steps: [
            { kind: 'ai_generate', prompt: 'x', onError: [{ kind: 'toast', message: 'Legacy', tone: 'info' }] },
            { kind: 'create_record', tableId: 't', values: {} },
        ] } });
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(toast.info).toHaveBeenCalledWith('Legacy');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('a failure inside the handler propagates like any other', async () => {
        asMock(authFetch).mockResolvedValueOnce(resp(200, AI_DOWN)).mockResolvedValueOnce(resp(200, { ok: false, error: 'Table not found', retryable: false }));
        const result = await runSeq({ seq: { kind: 'sequence', steps: [
            { kind: 'ai_generate', prompt: 'x', onError: { steps: [{ kind: 'create_record', tableId: 't', values: {} }] } },
            { kind: 'toast', message: 'never' },
        ] } });
        expect(toast.error).toHaveBeenCalledWith('Table not found');
        expect(result.current.actionState.seq?.status).toBe('error');
    });

    it('a transaction\'s child resultVars land in vars for the steps after it', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(200, { ok: true, result: { results: [{ id: 'ord_1', created: true }], vars: { order: { id: 'ord_1', created: true } }, count: 1 } }))
            .mockResolvedValueOnce(resp(200, { ok: true, result: null }));
        await runSeq({ seq: { kind: 'sequence', steps: [
            { kind: 'transaction', steps: [{ kind: 'create_record', tableId: 't', values: {}, resultVar: 'order' }] },
            { kind: 'create_record', tableId: 'lines', values: {} },
        ] } });
        expect(bodyOfCall(1).vars.order).toEqual({ id: 'ord_1', created: true });
        // The transaction's children take no ordinal: the step after it is 1.
        expect(bodyOfCall(1).stepIndex).toBe(1);
    });
});
