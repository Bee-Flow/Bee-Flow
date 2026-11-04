import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import useActionRunner from './useActionRunner';
import { setDemoTransport } from '@/utils/helpers';
import type { AuthFetchOptions } from '@/utils/helpers.types';
import { stub } from '@/test/mocks';

/**
 * The run log of a browser run (runtime/actionRunner/runEnd.ts): every server step of one click
 * carries the same runKey (a called action's step too, posted to the ROOT), exactly one end
 * report goes out when the sequence settles, a client-only sequence sends none, and a failing
 * end report never fails the run. The network is authFetch's transport seam (no module mock).
 */

type Call = { url: string; init: AuthFetchOptions; body: Record<string, unknown> };
let calls: Call[];
let answers: Array<Record<string, unknown> | Error>;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const steps = () => calls.filter((c) => !c.url.includes('/runs/end'));
const ends = () => calls.filter((c) => c.url.includes('/runs/end'));
const runner = (actions: Record<string, unknown>) => renderHook(() => useActionRunner('app1', stub<Parameters<typeof useActionRunner>[1]>({ schemaVersion: 2, actions })));

beforeEach(() => {
    calls = [];
    answers = [];
    setDemoTransport(async (url: string, init: AuthFetchOptions) => {
        calls.push({ url, init, body: JSON.parse(String(init.body ?? '{}')) });
        if (url.includes('/runs/end')) {
            const next = answers.find((a) => a instanceof Error);
            if (next instanceof Error) throw next;
            return json({ ok: true, recorded: true });
        }
        const a = answers.shift();
        return json(a && !(a instanceof Error) ? a : { ok: true, result: { id: 'r' } });
    });
});
afterEach(() => { setDemoTransport(null); });

describe('useActionRunner — run log', () => {
    it('spec: both server steps carry the same runKey and one keepalive end reports the error', async () => {
        answers = [{ ok: true, result: { id: 'r1' } }, { ok: false, error: 'Record r1 was not found' }];
        const { result } = runner({
            seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {} }, { kind: 'update_record', tableId: 't', recordId: 'r1', values: {} }] },
        });
        await act(async () => { await result.current.runAction('seq'); });

        expect(steps()).toHaveLength(2);
        const keys = steps().map((c) => c.body.runKey);
        expect(keys[0]).toMatch(/^rk_[A-Za-z0-9_-]{24}$/);
        expect(keys[1]).toBe(keys[0]);
        expect(ends()).toHaveLength(1);
        expect(ends()[0].url).toMatch(/\/api\/studio-apps\/app1\/actions\/seq\/runs\/end$/);
        expect(ends()[0].init.keepalive).toBe(true);
        expect(ends()[0].body).toEqual({ runKey: keys[0], status: 'error', error: 'Record r1 was not found' });
        expect(result.current.actionState.seq?.status).toBe('error');
    });

    it('a called action\'s step posts to the ROOT with the same runKey; success ends once', async () => {
        const { result } = runner({
            seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {} }, { kind: 'call_action', actionId: 'helper' }] },
            helper: { kind: 'sequence', steps: [{ kind: 'delete_record', tableId: 't', recordId: 'x' }] },
        });
        await act(async () => { await result.current.runAction('seq'); });
        expect(steps()).toHaveLength(2);
        expect(steps()[1].url).toContain('/actions/seq/step');
        expect(steps()[1].body.runKey).toBe(steps()[0].body.runKey);
        expect(ends()).toHaveLength(1);
        expect(ends()[0].body).toEqual({ runKey: steps()[0].body.runKey, status: 'success' });
    });

    it('a failure handled by onError ends as success with handled: true', async () => {
        answers = [{ ok: false, error: 'nope', retryable: false }];
        const { result } = runner({
            seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {}, onError: { steps: [{ kind: 'set_variable', name: 'failed', value: { kind: 'static', value: true } }] } }] },
        });
        await act(async () => { await result.current.runAction('seq'); });
        expect(ends()).toHaveLength(1);
        expect(ends()[0].body).toMatchObject({ status: 'success', handled: true });
    });

    it('a client-only sequence sends no run key and no end report', async () => {
        const { result } = runner({ seq: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'x', value: { kind: 'static', value: 1 } }] } });
        await act(async () => { await result.current.runAction('seq'); });
        expect(calls).toHaveLength(0);
    });

    it('a failing end report does not fail the run', async () => {
        answers = [{ ok: true, result: { id: 'r' } }, new Error('network down')];
        const { result } = runner({ seq: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {} }] } });
        await act(async () => { await result.current.runAction('seq'); });
        expect(ends()).toHaveLength(1);
        expect(result.current.actionState.seq?.status).toBe('success');
    });
});
