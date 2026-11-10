import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The control kinds of the step registry in the browser coordinator: return,
 * break, continue, while, raise_error and try (runtime/actionRunner/controlFlow.ts).
 * Real @shared/expr, resolveBinding and buildScope; authFetch and Toast are mocked.
 * The server walker runs the same cases in server/appStudio/sequenceWalkFlow.test.js.
 */

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/components/shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('./components/AppModal', () => ({ openAppModal: vi.fn(), closeAppModal: vi.fn() }));

import useActionRunner from './useActionRunner';
import { authFetch } from '@/utils/helpers';
import toast from '@/components/shared/Toast';
import { asMock, stub } from '@/test/mocks';
import { stepPosts } from '@/test/runLogCalls';

type Step = Record<string, unknown>;

const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const seq = (steps: Step[]) => ({ kind: 'sequence', steps });
const setVar = (name: string, expr: string): Step => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const when = (expr: string, then: Step[]): Step => ({ kind: 'condition', expr, then, else: [] });
const write = (tag: string): Step => ({ kind: 'create_record', tableId: tag, values: {} });
const list = (value: unknown[]) => ({ kind: 'static', value });

/** The step POSTs so far, as `<stepIndex>:<kind sent or ->`. */
const posted = () => stepPosts(authFetch).map((c) => {
    const body = JSON.parse((c[1] as { body: string }).body) as { stepIndex: number; kind?: string };
    return `${body.stepIndex}:${body.kind ?? '-'}`;
});

async function run(actions: Record<string, unknown>, id = 'main', variables: Array<Record<string, unknown>> = []) {
    const definition = { schemaVersion: 3, actions, variables };
    const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));
    await act(async () => { await result.current.runAction(id); });
    return result;
}

describe('useActionRunner: control kinds', () => {
    beforeEach(() => {
        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValue(resp(200, { ok: true, result: { id: 'rec' } }));
        asMock(toast.error).mockReset();
        asMock(toast.info).mockReset();
    });

    it('return ends the action as a success; its value is the result, also without a server step', async () => {
        const result = await run({ main: seq([setVar('n', '41'), when('vars.n > 0', [{ kind: 'return', value: { kind: 'formula', expr: 'vars.n + 1' } }]), write('never')]) });
        expect(stepPosts(authFetch)).toHaveLength(0);
        expect(toast.error).not.toHaveBeenCalled();
        expect(result.current.actionState.main).toMatchObject({ status: 'success', result: 42 });
    });

    it('return inside a called action ends only that action; the value lands in resultVar', async () => {
        const result = await run({
            main: seq([{ kind: 'call_action', actionId: 'sub', resultVar: 'got' }, setVar('after', 'vars.got + 1')]),
            sub: seq([{ kind: 'loop', source: list([1, 2, 3]), steps: [{ kind: 'return', value: { kind: 'formula', expr: 'item * 10' } }] }, write('never')]),
        });
        expect(stepPosts(authFetch)).toHaveLength(0);
        expect(result.current.vars).toMatchObject({ got: 10, after: 11 });
    });

    it('break leaves the nearest loop, continue skips the rest of the round, and the loop still hands its writes back', async () => {
        const body = [when('item == 2', [{ kind: 'continue' }]), when('item == 4', [{ kind: 'break' }]), setVar('seen', 'vars.seen + item')];
        const result = await run({ main: seq([{ kind: 'loop', source: list([1, 2, 3, 4, 5]), itemVar: 'row', steps: body }, setVar('done', 'true')]) }, 'main', [{ name: 'seen', type: 'number', default: 0 }]);
        expect(result.current.vars.seen).toBe(4);
        expect(result.current.vars.done).toBe(true);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('break outside a loop fails the action, also when a loop sits around the call', async () => {
        await run({ main: seq([{ kind: 'break' }]) });
        expect(asMock(toast.error).mock.calls[0][0]).toMatch(/only works inside a loop or while/);
        asMock(toast.error).mockReset();
        await run({ main: seq([{ kind: 'loop', source: list([1]), steps: [{ kind: 'call_action', actionId: 'sub' }] }]), sub: seq([{ kind: 'continue' }]) });
        expect(asMock(toast.error).mock.calls[0][0]).toMatch(/only works inside a loop or while/);
    });

    it('while runs while its formula holds, takes break and continue, and stops at maxIterations', async () => {
        const counted = await run({ main: seq([{ kind: 'while', expr: 'vars.n < 3', steps: [setVar('n', 'vars.n + 1')] }]) }, 'main', [{ name: 'n', type: 'number', default: 0 }]);
        expect(counted.current.vars.n).toBe(3);
        const body = [setVar('n', 'vars.n + 1'), when('vars.n == 2', [{ kind: 'continue' }]), when('vars.n == 4', [{ kind: 'break' }]), setVar('sum', 'vars.sum + vars.n')];
        const exits = await run({ main: seq([{ kind: 'while', expr: 'true', steps: body }]) }, 'main', [{ name: 'n', type: 'number', default: 0 }, { name: 'sum', type: 'number', default: 0 }]);
        expect(exits.current.vars).toMatchObject({ n: 4, sum: 4 });
        const capped = await run({ main: seq([{ kind: 'while', expr: 'true', maxIterations: 5, steps: [setVar('n', 'vars.n + 1')] }, setVar('after', 'true')]) }, 'main', [{ name: 'n', type: 'number', default: 0 }]);
        expect(capped.current.vars).toMatchObject({ n: 5, after: true });
        const ceiling = await run({ main: seq([{ kind: 'while', expr: 'true', maxIterations: 9999, steps: [setVar('n', 'vars.n + 1')] }]) }, 'main', [{ name: 'n', type: 'number', default: 0 }]);
        expect(ceiling.current.vars.n).toBe(200);
    });

    it('raise_error fails the action with the message, before the steps after it', async () => {
        const result = await run({ main: seq([write('a'), { kind: 'raise_error', message: { kind: 'formula', expr: '"No lines on " + vars.order' }, code: 'no_lines' }, write('never')]) }, 'main', [{ name: 'order', type: 'text', default: 'A7' }]);
        expect(stepPosts(authFetch)).toHaveLength(1);
        expect(toast.error).toHaveBeenCalledWith('No lines on A7');
        expect(result.current.actionState.main).toMatchObject({ status: 'error', error: 'No lines on A7' });
    });

    it('try: a failing step runs catch with the error in scope, then the sequence goes on', async () => {
        asMock(authFetch).mockResolvedValueOnce(resp(200, { ok: true, result: 1 })).mockResolvedValueOnce(resp(200, { ok: false, error: 'b failed', code: 'boom', retryable: false })).mockResolvedValue(resp(200, { ok: true, result: 3 }));
        const result = await run({ main: seq([
            { kind: 'try', steps: [write('a'), write('b'), write('skipped')], catch: [setVar('why', 'error.message + "/" + error.step + "/" + error.code + "/" + error.stepIndex')] },
            write('after'),
        ]) });
        expect(posted()).toEqual(['1:create_record', '2:create_record', '5:create_record']);
        expect(result.current.vars.why).toBe('b failed/create_record/boom/2');
        expect(toast.error).not.toHaveBeenCalled();
        expect(result.current.actionState.main.status).toBe('success');
    });

    it('try: finally runs after success, after a catch, and before a failure leaves a try without catch', async () => {
        const order = (name: string) => setVar('trail', `vars.trail + "${name}"`);
        const vars = [{ name: 'trail', type: 'text', default: '' }];
        const ok = await run({ main: seq([{ kind: 'try', steps: [order('a')], catch: [order('c')], finally: [order('f')] }, order('z')]) }, 'main', vars);
        expect(ok.current.vars.trail).toBe('afz');
        const boom: Step = { kind: 'raise_error', message: { kind: 'static', value: 'Nope' }, code: 'nope' };
        const caught = await run({ main: seq([{ kind: 'try', steps: [order('a'), boom, order('x')], catch: [order('c'), setVar('code', 'error.code + ":" + error.step')], finally: [order('f')] }, order('z')]) }, 'main', vars);
        expect(caught.current.vars).toMatchObject({ trail: 'acfz', code: 'nope:raise_error' });
        expect(toast.error).not.toHaveBeenCalled();
        const uncaught = await run({ main: seq([{ kind: 'try', steps: [order('a'), boom], finally: [order('f')] }, order('z')]) }, 'main', vars);
        expect(uncaught.current.vars.trail).toBe('af');
        expect(toast.error).toHaveBeenCalledWith('Nope');
    });

    it('try: an empty catch handles the failure; return and break pass through and finally runs first', async () => {
        const boom: Step = { kind: 'raise_error', message: { kind: 'static', value: 'Nope' } };
        const empty = await run({ main: seq([{ kind: 'try', steps: [boom], catch: [] }, setVar('after', 'true')]) });
        expect(empty.current.vars.after).toBe(true);
        expect(toast.error).not.toHaveBeenCalled();
        const ret = await run({ main: seq([{ kind: 'try', steps: [{ kind: 'return', value: { kind: 'static', value: 'r' } }], catch: [setVar('caught', 'true')], finally: [write('f')] }, setVar('after', 'true')]) });
        expect(ret.current.vars.caught).toBeUndefined();
        expect(ret.current.vars.after).toBeUndefined();
        expect(posted()).toEqual(['3:create_record']);
        expect(ret.current.actionState.main).toMatchObject({ status: 'success', result: 'r' });
        const brk = await run({ main: seq([{ kind: 'loop', source: list([1, 2, 3]), steps: [{ kind: 'try', steps: [when('item == 2', [{ kind: 'break' }]), setVar('rows', 'vars.rows + 1')], finally: [setVar('fin', 'vars.fin + 1')] }] }]) }, 'main', [{ name: 'rows', type: 'number', default: 0 }, { name: 'fin', type: 'number', default: 0 }]);
        expect(brk.current.vars).toMatchObject({ rows: 1, fin: 2 });
    });

    it('try composes with a step\'s own onError and retry: both come first', async () => {
        asMock(authFetch).mockResolvedValueOnce(resp(200, { ok: false, error: 'first', retryable: true })).mockResolvedValue(resp(200, { ok: true, result: 1 }));
        const retried = await run({ main: seq([{ kind: 'try', steps: [{ ...write('a'), retry: { times: 1, delayMs: 0 } }], catch: [setVar('caught', 'true')] }]) });
        expect(stepPosts(authFetch)).toHaveLength(2);
        expect(retried.current.vars.caught).toBeUndefined();

        asMock(authFetch).mockReset();
        asMock(authFetch).mockResolvedValueOnce(resp(200, { ok: false, error: 'x', retryable: false })).mockResolvedValue(resp(200, { ok: true, result: 1 }));
        const own = await run({ main: seq([{ kind: 'try', steps: [{ ...write('a'), onError: { steps: [setVar('own', 'true')] } }, write('b')], catch: [setVar('caught', 'true')] }]) });
        expect(own.current.vars.own).toBe(true);
        expect(own.current.vars.caught).toBeUndefined();
        expect(stepPosts(authFetch)).toHaveLength(2);
    });

    it('a failure inside a called action reaches the caller\'s catch with the inner kind and the call\'s position', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, { ok: false, error: 'inner failed', retryable: false }));
        const result = await run({
            main: seq([{ kind: 'try', steps: [{ kind: 'call_action', actionId: 'sub' }], catch: [setVar('why', 'error.step + "@" + error.stepIndex')] }, setVar('after', 'true')]),
            sub: seq([{ kind: 'kb_query', query: { kind: 'static', value: 'q' }, knowledgeBaseIds: [], resultVar: 'r' }]),
        });
        expect(result.current.vars).toMatchObject({ why: 'kb_query@1', after: true });
        // The called action holds no registry kind, but the clicked one does: the kind is sent.
        expect(posted()).toEqual(['0:kb_query']);
    });

    it('the kind rides along only where an action on the call chain holds a registry kind', async () => {
        await run({ main: seq([write('a'), { kind: 'loop', source: list([1]), steps: [write('b')] }]) });
        expect(posted()).toEqual(['0:-', '2:-']);
        const first = JSON.parse((stepPosts(authFetch)[0][1] as { body: string }).body) as Record<string, unknown>;
        expect(Object.keys(first).filter((k) => k !== 'runKey')).toEqual(['stepIndex', 'formValues', 'vars']);

        asMock(authFetch).mockClear();
        await run({ main: seq([write('a'), { kind: 'while', expr: 'vars.go', steps: [write('b'), setVar('go', 'false')] }, write('c')]) }, 'main', [{ name: 'go', type: 'yesno', default: true }]);
        expect(posted()).toEqual(['0:create_record', '2:create_record', '4:create_record']);

        asMock(authFetch).mockClear();
        await run({ main: seq([{ kind: 'call_action', actionId: 'sub' }, write('own')]), sub: seq([when('false', [{ kind: 'return' }]), write('inner')]) });
        expect(posted()).toEqual(['2:create_record', '1:-']);
    });
});
