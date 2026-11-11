import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `parallel` step in the browser coordinator (runtime/actionRunner/parallelStep.ts).
 * Real @shared/expr, resolveBinding, buildScope and authFetch: the requests are answered
 * through authFetch's own transport seam (the one a public page uses), so no module is
 * swapped. The server walker runs the same cases in
 * server/appStudio/sequenceWalkParallel.test.js.
 */

import useActionRunner from './useActionRunner';
import { BROWSER_PARALLEL_MAX } from './actionRunner/parallelStep';
import { setPublicAppTransport } from '@/utils/helpers';
import toast from '@/components/shared/Toast';
import { stub } from '@/test/mocks';

type Step = Record<string, unknown>;
type Answer = { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean };

const seq = (steps: Step[]) => ({ kind: 'sequence', steps });
const setVar = (name: string, expr: string): Step => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const write = (tag: string, extra: Step = {}): Step => ({ kind: 'create_record', tableId: tag, values: {}, ...extra });
const parallel = (branches: Step[][], extra: Step = {}): Step => ({ kind: 'parallel', branches: branches.map((steps) => ({ steps })), ...extra });

/** One step POST the app made and has not been answered yet. */
interface Pending { stepIndex: number; kind?: string; vars: Record<string, unknown>; answer: (a: Answer) => void }

let pending: Pending[];
let posts: Array<{ stepIndex: number; kind?: string; vars: Record<string, unknown> }>;
/** Answers a POST by itself (the default), or leaves it in `pending` for the test to answer. */
let auto: ((stepIndex: number) => Answer) | null;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }); };

function start(actions: Record<string, unknown>, variables: Array<Record<string, unknown>> = []) {
    const definition = { schemaVersion: 3, actions, variables };
    const { result } = renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>(definition), {}));
    let done: Promise<unknown> = Promise.resolve();
    act(() => { done = result.current.runAction('main'); });
    return { result, done };
}

async function run(actions: Record<string, unknown>, variables: Array<Record<string, unknown>> = []) {
    const { result, done } = start(actions, variables);
    await act(async () => { await done; });
    return result;
}

const answer = async (stepIndex: number, a: Answer) => {
    const at = pending.findIndex((p) => p.stepIndex === stepIndex);
    expect(at, `step ${stepIndex} was posted`).toBeGreaterThanOrEqual(0);
    const [p] = pending.splice(at, 1);
    await act(async () => { p.answer(a); });
    await flush();
};

describe('useActionRunner: parallel', () => {
    beforeEach(() => {
        pending = [];
        posts = [];
        auto = (stepIndex) => ({ ok: true, result: { step: stepIndex } });
        setPublicAppTransport(async (url, options) => {
            if (String(url).includes('/runs/end')) return json({ ok: true });
            const body = JSON.parse(String((options as { body?: string } | undefined)?.body ?? '{}')) as { stepIndex: number; kind?: string; vars: Record<string, unknown> };
            posts.push({ stepIndex: body.stepIndex, kind: body.kind, vars: body.vars });
            if (auto) return json(auto(body.stepIndex));
            return new Promise<Response>((resolve) => { pending.push({ ...body, answer: (a) => resolve(json(a)) }); });
        });
        vi.spyOn(toast, 'error').mockImplementation(() => 0);
        vi.spyOn(toast, 'info').mockImplementation(() => 0);
    });
    afterEach(() => {
        setPublicAppTransport(null);
        vi.restoreAllMocks();
    });

    it('posts the server steps of both branches before either is answered, each by its own ordinal and kind', async () => {
        auto = null;
        // Ordinals: 0 parallel, 1 a, 2 b, 3 after.
        const { result, done } = start({ main: seq([parallel([[write('a', { resultVar: 'ra' })], [write('b', { resultVar: 'rb' })]]), write('after')]) });
        await flush();
        expect(pending.map((p) => `${p.stepIndex}:${p.kind}`)).toEqual(['1:create_record', '2:create_record']);
        await answer(2, { ok: true, result: 'B' });
        expect(pending.map((p) => p.stepIndex)).toEqual([1]);
        await answer(1, { ok: true, result: 'A' });
        expect(pending.map((p) => p.stepIndex)).toEqual([3]);
        await answer(3, { ok: true, result: 'done' });
        await act(async () => { await done; });
        expect(result.current.vars).toMatchObject({ ra: 'A', rb: 'B' });
        expect(result.current.actionState.main).toMatchObject({ status: 'success', result: 'done' });
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('a branch starts with the variables from before the step and does not see another branch write', async () => {
        auto = null;
        const { result, done } = start({
            main: seq([parallel([
                [write('slow'), setVar('seenByA', 'vars.n'), setVar('a', '10')],
                [setVar('n', '99'), write('probe')],
            ])]),
        }, [{ name: 'n', type: 'number', default: 1 }]);
        await flush();
        // Ordinals: 0 parallel, 1 slow, 2 seenByA, 3 a, 4 n, 5 probe.
        expect(pending.find((p) => p.stepIndex === 5)?.vars.n, 'branch 2 posts its own n').toBe(99);
        expect(pending.find((p) => p.stepIndex === 1)?.vars.n, 'branch 1 posts n as it was').toBe(1);
        await answer(5, { ok: true, result: 1 });
        await answer(1, { ok: true, result: 1 });
        await act(async () => { await done; });
        expect(result.current.vars).toMatchObject({ seenByA: 1, n: 99, a: 10 });
    });

    it('joins the writes in branch order, whichever branch finished first', async () => {
        auto = null;
        const { result, done } = start({
            main: seq([parallel([
                [write('slow', { resultVar: 'r' }), setVar('who', '"first"')],
                [write('quick', { resultVar: 'r' }), setVar('who', '"second"')],
            ]), setVar('after', 'vars.who')]),
        });
        await flush();
        // Ordinals: 0 parallel, 1 slow, 2 who, 3 quick, 4 who.
        await answer(3, { ok: true, result: 'Q' });
        await answer(1, { ok: true, result: 'S' });
        await act(async () => { await done; });
        expect(result.current.vars).toMatchObject({ who: 'second', r: 'Q', after: 'second' });
        expect(result.current.actionState.main).toMatchObject({ status: 'success', result: 'Q' });
    });

    it('a failing branch fails the action after the other branch ran to its end', async () => {
        auto = (stepIndex) => (stepIndex === 1 ? { ok: false, error: 'a failed', code: 'boom', retryable: false } : { ok: true, result: 1 });
        // Ordinals: 0 parallel, 1 bad, 2 one, 3 two, 4 never.
        const result = await run({ main: seq([parallel([[write('bad')], [write('one'), write('two'), setVar('done', 'true')]]), write('never')]) });
        expect(posts.map((p) => p.stepIndex).sort()).toEqual([1, 2, 3]);
        expect(toast.error).toHaveBeenCalledWith('a failed');
        expect(result.current.actionState.main).toMatchObject({ status: 'error', error: 'a failed' });
        expect(result.current.vars.done).toBe(true);
    });

    it('failFast ends the other branches before their next step', async () => {
        auto = null;
        const { result, done } = start({ main: seq([parallel([[write('bad')], [write('one'), write('two')]], { failFast: true })]) });
        await flush();
        await answer(1, { ok: false, error: 'a failed', retryable: false });
        await answer(2, { ok: true, result: 1 });
        await act(async () => { await done; });
        expect(posts.map((p) => p.stepIndex).sort()).toEqual([1, 2]);
        expect(result.current.actionState.main).toMatchObject({ status: 'error', error: 'a failed' });
    });

    it('a try around the step catches the failure of a branch with the failing kind in scope', async () => {
        auto = (stepIndex) => (stepIndex === 2 ? { ok: false, error: 'kb down', code: 'kb', retryable: false } : { ok: true, result: 1 });
        // Ordinals: 0 try, 1 parallel, 2 kb_query, 3 create_record, 4 set (catch), 5 set (after).
        const result = await run({ main: seq([
            { kind: 'try', steps: [parallel([[{ kind: 'kb_query', query: { kind: 'static', value: 'q' }, knowledgeBaseIds: [], resultVar: 'hits' }], [write('fine')]])], catch: [setVar('why', 'error.step + ":" + error.code')] },
            setVar('after', 'true'),
        ]) });
        expect(result.current.vars).toMatchObject({ why: 'kb_query:kb', after: true });
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('a handler inside a branch keeps the failure there, and one with stop ends the action quietly', async () => {
        auto = (stepIndex) => (stepIndex === 1 ? { ok: false, error: 'x', retryable: false } : { ok: true, result: 1 });
        const handled = await run({ main: seq([parallel([[write('bad', { onError: { steps: [setVar('fallback', '"used"')] } })], [write('fine')]]), setVar('after', 'true')]) });
        expect(handled.current.vars).toMatchObject({ fallback: 'used', after: true });
        const stopped = await run({ main: seq([parallel([[write('bad', { onError: { steps: [], stop: true } })], [write('fine')]]), setVar('after', 'true')]) });
        expect(stopped.current.vars.after).toBeUndefined();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('runs at most BROWSER_PARALLEL_MAX branches at once', async () => {
        auto = null;
        const { done } = start({ main: seq([parallel([1, 2, 3, 4, 5, 6].map((n) => [write(`b${n}`)]))]) });
        await flush();
        expect(pending).toHaveLength(BROWSER_PARALLEL_MAX);
        await answer(1, { ok: true, result: 1 });
        expect(pending).toHaveLength(BROWSER_PARALLEL_MAX);
        while (pending.length) await answer(pending[0].stepIndex, { ok: true, result: 1 });
        await act(async () => { await done; });
        expect(posts).toHaveLength(6);
    });

    it('refuses the kinds that may not run inside a branch, also in an action the branch calls', async () => {
        for (const step of [{ kind: 'navigate', screenId: 's' }, { kind: 'confirm', message: 'Sure?' }, { kind: 'open_modal', modalId: 'm' }, { kind: 'send_email' }, { kind: 'transaction', steps: [] }, parallel([[setVar('x', '1')]]), { kind: 'return' }] as Step[]) {
            vi.mocked(toast.error).mockClear();
            posts = [];
            const result = await run({ main: seq([parallel([[step], [setVar('other', 'true')]])]) });
            expect(vi.mocked(toast.error).mock.calls[0]?.[0], String(step.kind)).toMatch(/cannot run inside a branch of a parallel step/);
            expect(posts, String(step.kind)).toHaveLength(0);
            expect(result.current.vars.other, 'the other branch still ran').toBe(true);
        }
        vi.mocked(toast.error).mockClear();
        await run({ main: seq([parallel([[{ kind: 'call_action', actionId: 'sub' }]])]), sub: seq([{ kind: 'navigate', screenId: 's' }]) });
        expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/cannot run inside a branch/);
    });

    it('a return in an action a branch calls ends that action only; a break cannot leave a loop around the step', async () => {
        const called = await run({
            main: seq([parallel([[{ kind: 'call_action', actionId: 'sub', resultVar: 'got' }], [setVar('b', '2')]]), setVar('after', 'vars.got + vars.b')]),
            sub: seq([{ kind: 'return', value: { kind: 'static', value: 5 } }, write('never')]),
        });
        expect(called.current.vars).toMatchObject({ got: 5, b: 2, after: 7 });
        expect(posts).toHaveLength(0);
        await run({ main: seq([{ kind: 'loop', source: { kind: 'static', value: [1, 2] }, steps: [parallel([[{ kind: 'break' }]])] }]) });
        expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/only works inside a loop or while/);
    });

    it('more branches than the limit fail the step before anything runs', async () => {
        await run({ main: seq([parallel(Array.from({ length: 9 }, (_, n) => [write(`b${n}`)]))]) });
        expect(posts).toHaveLength(0);
        expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/at most 8 branches/);
    });
});
