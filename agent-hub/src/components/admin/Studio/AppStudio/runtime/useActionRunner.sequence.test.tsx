import { act, renderHook, waitFor } from '@testing-library/react';
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
import { backgroundTiming } from './actionRunner/backgroundRun';
import { stepPosts } from '@/test/runLogCalls';

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

        expect(stepPosts(authFetch)).toHaveLength(1);
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

        expect(stepPosts(authFetch)).toHaveLength(1);
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

        expect(stepPosts(authFetch)).toHaveLength(1);
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

        expect(stepPosts(authFetch)).toHaveLength(2);
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

        expect(stepPosts(authFetch)).toHaveLength(1);   // aborted after the first failure
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

        expect(stepPosts(authFetch)).toHaveLength(1);
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

        expect(stepPosts(authFetch)).toHaveLength(1);
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
        expect(stepPosts(authFetch)).toHaveLength(3);
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
        expect(stepPosts(authFetch)).toHaveLength(2);
        expect(bodyOfCall(1).stepIndex).toBe(0);
        expect(result.current.actionState.seq?.status).toBe('success');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('retryable:false is posted once; a 5xx is retried, a 4xx is not', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: false, error: 'Record not found', retryable: false }));
        await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 't', values: {}, retry: { times: 3, delayMs: 0 } }] } });
        expect(stepPosts(authFetch)).toHaveLength(1);
        expect(toast.error).toHaveBeenCalledWith('Record not found');

        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValueOnce(resp(503, { error: 'unavailable' })).mockResolvedValueOnce(resp(200, { ok: true, result: null }));
        await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 't', values: {}, retry: { times: 1, delayMs: 0 } }] } });
        expect(stepPosts(authFetch)).toHaveLength(2);

        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValue(resp(400, { error: 'stepIndex is the position of the step in the action.' }));
        await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'update_record', tableId: 't', values: {}, retry: { times: 2, delayMs: 0 } }] } });
        expect(stepPosts(authFetch)).toHaveLength(1);
    });

    it('an aborted request (unknown outcome) is never retried', async () => {
        asMock(authFetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        const result = await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {}, retry: { times: 3, delayMs: 0 } }] } });
        expect(stepPosts(authFetch)).toHaveLength(1);
        expect(result.current.actionState.seq?.status).toBe('error');
    });

    it('no onError: a failure stops the sequence with its reason, as before', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, AI_DOWN));
        const result = await runSeq({ seq: { kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x' }, { kind: 'create_record', tableId: 't', values: {} }] } });
        expect(stepPosts(authFetch)).toHaveLength(1);
        expect(toast.error).toHaveBeenCalledWith(AI_DOWN.error);
        expect(result.current.actionState.seq).toMatchObject({ status: 'error', error: AI_DOWN.error });
    });

    it('stop: true and the legacy array run the handler and then end quietly', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, AI_DOWN));
        await runSeq({ seq: { kind: 'sequence', steps: [
            { kind: 'ai_generate', prompt: 'x', onError: { steps: [{ kind: 'toast', message: 'We will try later', tone: 'info' }], stop: true } },
            { kind: 'create_record', tableId: 't', values: {} },
        ] } });
        expect(stepPosts(authFetch)).toHaveLength(1);
        expect(toast.info).toHaveBeenCalledWith('We will try later');
        expect(toast.error).not.toHaveBeenCalled();

        asMock(authFetch).mockClear();
        asMock(toast.info).mockClear();
        await runSeq({ seq: { kind: 'sequence', steps: [
            { kind: 'ai_generate', prompt: 'x', onError: [{ kind: 'toast', message: 'Legacy', tone: 'info' }] },
            { kind: 'create_record', tableId: 't', values: {} },
        ] } });
        expect(stepPosts(authFetch)).toHaveLength(1);
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

// ── Background actions ───────────────────────────────────────────────────────
// The click starts a server job and resolves at once; the entry follows the job and ends
// with its result, written vars and replayed toasts/refreshes; a locked start attaches to
// the viewer's own run or says why not; a declined leading confirm starts nothing.

const JOB = 'sar_0123456789abcdef0123456789abcdef';
const progress = (over = {}) => ({ stepIndex: 1, kind: 'ai_generate', executed: 1, message: null, loop: null, waiting: null, ...over });

const BG = { kind: 'sequence', background: true, progressVar: 'status', steps: [{ kind: 'ai_generate', prompt: 'x' }, { kind: 'toast', message: 'Done' }] };
const bgDefinition = (action: unknown = BG) => stub<Parameters<typeof useActionRunner>[1]>({ schemaVersion: 2, actions: { act_bg: action } });

describe('useActionRunner — background actions', () => {
    beforeEach(() => {
        asMock(authFetch).mockReset();
        for (const fn of [toast.success, toast.error, toast.info]) asMock(fn).mockReset();
        vi.spyOn(backgroundTiming, 'wait').mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('starts the job, follows its progress and ends with the result, vars and replayed effects', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' }))
            .mockResolvedValueOnce(resp(200, { jobId: JOB, actionId: 'act_bg', status: 'running', progress: progress({ message: 'Reading 1 of 2' }) }))
            .mockResolvedValueOnce(resp(200, {
                jobId: JOB, actionId: 'act_bg', status: 'success', progress: progress(), result: { text: 'ok' },
                vars: { status: 'Finished' }, effects: [{ kind: 'toast', message: 'Done', tone: 'success' }, { kind: 'refresh', tableId: 'tbl_1' }],
                error: null, errorStep: null, startedAt: null, finishedAt: null, durationMs: 10,
            }));
        const onRefresh = vi.fn();
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition(), { onRefresh }));
        await act(async () => { await result.current.runAction('act_bg', { formValues: { id: 'o1' } }); });

        const [url, init] = asMock(authFetch).mock.calls[0];
        expect(String(url)).toBe('/api/studio-apps/app1/actions/act_bg/background');
        expect(JSON.parse(init.body)).toMatchObject({ formValues: { id: 'o1' } });
        await waitFor(() => expect(result.current.actionState.act_bg?.status).toBe('success'));
        expect(String(asMock(authFetch).mock.calls[1][0])).toBe(`/api/studio-apps/app1/actions/jobs/${JOB}`);
        expect(result.current.actionState.act_bg?.result).toEqual({ text: 'ok' });
        expect(result.current.vars.status).toBe('Finished');
        expect(toast.success).toHaveBeenCalledWith('Done');
        expect(onRefresh).toHaveBeenCalledWith({ tableId: 'tbl_1', datasetId: null });
    });

    it('a failed job ends in error with the server reason and a danger toast', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' }))
            .mockResolvedValueOnce(resp(200, { jobId: JOB, actionId: 'act_bg', status: 'error', progress: progress(), error: 'The AI gave no answer within 120 s', errorStep: { kind: 'ai_generate' } }));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition()));
        await act(async () => { await result.current.runAction('act_bg'); });
        await waitFor(() => expect(result.current.actionState.act_bg?.status).toBe('error'));
        expect(result.current.actionState.act_bg?.error).toBe('The AI gave no answer within 120 s');
        expect(toast.error).toHaveBeenCalledWith('The AI gave no answer within 120 s');
    });

    it('a locked start with the viewer\'s own job attaches to it; without a job id it only says why', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(409, { code: 'action_locked', error: 'This is already running for the same item (started 2 min ago). Wait until it finishes.', jobId: JOB }))
            .mockResolvedValueOnce(resp(200, { jobId: JOB, actionId: 'act_bg', status: 'success', progress: progress(), result: 1 }));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition()));
        await act(async () => { await result.current.runAction('act_bg'); });
        expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/already running for the same item/));
        await waitFor(() => expect(result.current.actionState.act_bg?.status).toBe('success'));

        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValueOnce(resp(409, { code: 'action_locked', error: 'This is already running for the same item.' }));
        const other = renderHook(() => useActionRunner('app1', bgDefinition()));
        await act(async () => { await other.result.current.runAction('act_bg'); });
        expect(other.result.current.actionState.act_bg?.status).toBe('idle');
        expect(stepPosts(authFetch)).toHaveLength(1);
    });

    it('a declined leading confirm starts nothing', async () => {
        const action = { ...BG, steps: [{ kind: 'confirm', message: 'Start?' }, ...BG.steps] };
        const confirm = vi.fn(() => Promise.resolve(false));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition(action), { confirm }));
        await act(async () => { await result.current.runAction('act_bg'); });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(authFetch).not.toHaveBeenCalled();
    });

    // runOn: 'server' (schema 3): the same server job, but the click waits for it.
    const ON_SERVER = { kind: 'sequence', runOn: 'server', steps: [{ kind: 'create_record', tableId: 't', values: {} }, { kind: 'toast', message: 'Saved' }] };
    const ended = (over = {}) => ({ jobId: JOB, actionId: 'act_bg', status: 'success', progress: progress(), result: { id: 'rec_1' }, vars: { saved: true }, effects: [{ kind: 'toast', message: 'Saved', tone: 'success' }], error: null, errorStep: null, ...over });

    it('runOn server: one start request, and runAction resolves only when the run has ended with its result', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' }))
            .mockResolvedValueOnce(resp(200, { jobId: JOB, actionId: 'act_bg', status: 'running', progress: progress() }))
            .mockResolvedValueOnce(resp(200, ended()));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition(ON_SERVER)));
        await act(async () => { await result.current.runAction('act_bg', { formValues: { id: 'o1' } }); });
        // No waitFor: the click itself waited.
        expect(result.current.actionState.act_bg?.status).toBe('success');
        expect(result.current.actionState.act_bg?.result).toEqual({ id: 'rec_1' });
        expect(result.current.vars.saved).toBe(true);
        expect(toast.success).toHaveBeenCalledWith('Saved');
        expect(String(asMock(authFetch).mock.calls[0][0])).toBe('/api/studio-apps/app1/actions/act_bg/background');
        expect(asMock(authFetch).mock.calls.every(([url]) => !String(url).endsWith('/step'))).toBe(true);
    });

    it('runOn server: a second action on the same control runs after the server run ended, and not after a failed one', async () => {
        const two = stub<Parameters<typeof useActionRunner>[1]>({ schemaVersion: 3, actions: { act_bg: ON_SERVER, act_after: { kind: 'toast', message: 'Next' } } });
        asMock(authFetch).mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' })).mockResolvedValueOnce(resp(200, ended({ effects: [] })));
        const { result } = renderHook(() => useActionRunner('app1', two));
        await act(async () => { await result.current.runAction(['act_bg', 'act_after']); });
        expect(toast.info).toHaveBeenCalledWith('Next');

        asMock(toast.info).mockReset();
        asMock(authFetch).mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' })).mockResolvedValueOnce(resp(200, ended({ status: 'error', error: 'No access', result: undefined })));
        await act(async () => { await result.current.runAction(['act_bg', 'act_after']); });
        expect(result.current.actionState.act_bg?.status).toBe('error');
        expect(toast.info).not.toHaveBeenCalled();
    });

    it('runOn server: a run that goes on hold stops the waiting; the entry says what it waits for and the run is followed on', async () => {
        const held = { jobId: JOB, actionId: 'act_bg', status: 'paused', progress: progress({ waiting: 'timer' }), wakeAt: '2026-11-12T09:30:00.000Z', waitKind: null, error: null, errorStep: null };
        let release: (v: unknown) => void = () => {};
        asMock(authFetch)
            .mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' }))
            .mockResolvedValueOnce(resp(200, held))
            .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition(ON_SERVER)));
        await act(async () => { await result.current.runAction('act_bg'); });
        expect(result.current.actionState.act_bg?.status).toBe('running');
        expect(result.current.actionState.act_bg?.waiting).toEqual({ kind: null, wakeAt: '2026-11-12T09:30:00.000Z' });
        expect(toast.info).toHaveBeenCalledWith('This is waiting now and goes on by itself. You can close the page.');
        await act(async () => { release(resp(200, ended())); });
        await waitFor(() => expect(result.current.actionState.act_bg?.status).toBe('success'));
        expect(result.current.actionState.act_bg?.waiting).toBeUndefined();
    });

    it('a cancelled job leaves the action idle, marked cancelled, without an error', async () => {
        asMock(authFetch)
            .mockResolvedValueOnce(resp(202, { jobId: JOB, status: 'running' }))
            .mockResolvedValueOnce(resp(200, ended({ status: 'cancelled', error: 'The run was cancelled.', result: undefined, effects: undefined })));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition()));
        await act(async () => { await result.current.runAction('act_bg'); });
        await waitFor(() => expect(result.current.actionState.act_bg?.cancelled).toBe(true));
        expect(result.current.actionState.act_bg?.status).toBe('idle');
        expect(result.current.actionState.act_bg?.error).toBeNull();
        expect(toast.error).not.toHaveBeenCalled();
        expect(toast.info).toHaveBeenCalledWith('Cancelled');
    });

    it('a sequence without background still runs step by step in the page', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { text: 'inline' } }));
        const { result } = renderHook(() => useActionRunner('app1', bgDefinition({ kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x' }] })));
        await act(async () => { await result.current.runAction('act_bg'); });
        expect(String(asMock(authFetch).mock.calls[0][0])).toMatch(/\/actions\/act_bg\/step$/);
    });
});

// A server step refused by a data-model field rule answers `fieldErrors`: the runner keeps them on
// the action's state so the form that submitted can show each one under its input.
describe('useActionRunner — field rule errors', () => {
    const saveDef = def({ save: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {} }] } });
    beforeEach(() => { asMock(authFetch).mockReset(); });

    it('keeps the server fieldErrors (strings only) on the failed action', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: false, error: '"Quantity" must be at least 1.', code: 'field_invalid', retryable: false, fieldErrors: { qty: '"Quantity" must be at least 1.', bad: 3 } }));
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(saveDef)));
        await act(async () => { await result.current.runAction('save', { formValues: { qty: 0 } }); });
        const entry = result.current.actionState.save;
        expect(entry?.status).toBe('error');
        expect(entry?.error).toBe('"Quantity" must be at least 1.');
        expect(entry?.fieldErrors).toEqual({ qty: '"Quantity" must be at least 1.' });
    });

    it('a failure without fieldErrors writes no fieldErrors key', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: false, error: 'Record not found' }));
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(saveDef)));
        await act(async () => { await result.current.runAction('save'); });
        expect(result.current.actionState.save).toEqual({ status: 'error', result: undefined, error: 'Record not found' });
    });
});

// Dynamic text and effects (schema version 3), as the real hook runs them.
{
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
}

describe('the wide server scope (serverScope: "wide")', () => {
    beforeEach(() => { asMock(authFetch).mockReset(); asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec_new' } })); });

    const live = { forms: { cmp_other: { note: 'hi' } }, screen: { id: 'scr_a', params: { recordId: 'rec_7' } } };
    const WRITE = { kind: 'create_record', tableId: 't', values: {} };
    const reading = (expr: string) => ({ ...WRITE, values: { a: { kind: 'formula', expr } } });
    async function post(steps: unknown[], extra: Record<string, unknown> = { serverScope: 'wide' }) {
        asMock(authFetch).mockClear();
        const definition = { schemaVersion: 3, actions: { seq: { kind: 'sequence', steps } }, ...extra };
        const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), live));
        await act(async () => { await result.current.runAction('seq', { formValues: { a: 1 } }); });
        return stepPosts(authFetch).map((_, i) => bodyOfCall(i));
    }

    it('an app without the flag posts the body it always did, whatever the step reads', async () => {
        const [body] = await post([reading('screen.params.recordId + forms.cmp_other.note')], {});
        expect(Object.keys(body).sort()).toEqual(['formValues', 'runKey', 'stepIndex', 'vars']);
    });

    it('an app with the flag sends nothing extra for a step that reads none of the roots', async () => {
        const [body] = await post([reading('form.a + vars.b')]);
        expect(Object.keys(body).sort()).toEqual(['formValues', 'runKey', 'stepIndex', 'vars']);
    });

    it('sends the screen params and the forms to the step that reads them', async () => {
        const [first, second] = await post([reading('screen.params.recordId'), { ...WRITE, guard: 'forms.cmp_other.note == "hi"' }]);
        expect(first.screenParams).toEqual({ recordId: 'rec_7' });
        expect(first.forms).toBeUndefined();
        expect(second.forms).toEqual({ cmp_other: { note: 'hi' } });
        expect(second.screenParams).toBeUndefined();
    });

    it('sends the result of the action a step names, and no other', async () => {
        const [, second] = await post([WRITE, reading('actions.seq.result.id')]);
        expect(second.actionResults).toEqual({ seq: { status: 'running', result: { id: 'rec_new' }, error: null } });
        const [, quiet] = await post([WRITE, reading('actions.other_action.result')]);
        expect(quiet.actionResults).toBeUndefined();
    });
});
