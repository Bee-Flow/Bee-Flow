import { describe, expect, it, vi } from 'vitest';
import { runWithCallerNotice } from './callerNotice';
import type { CallerNoticeApi } from './callerNotice';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));

function noticeRequired(): Error & { code: string } {
    return Object.assign(new Error('held'), { code: 'caller_notice_required' });
}

function makeApi(runImpl: CallerNoticeApi<{ ok: boolean }>['run']): CallerNoticeApi<{ ok: boolean }> & { ack: ReturnType<typeof vi.fn> } {
    const ack = vi.fn().mockResolvedValue({ ok: true });
    return {
        run: vi.fn(runImpl),
        getCallerNotice: vi.fn().mockResolvedValue({ applies: true, seen: false, providers: ['Google', 'Microsoft'], destinations: ['knowledge_base', 'generated_files'], items: ['app:google', 'app:microsoft', 'dest:generated_files', 'dest:knowledge_base'] }),
        ackCallerNotice: ack,
        ack,
    };
}

describe('runWithCallerNotice', () => {
    it('runs straight away when the server does not hold the run', async () => {
        const api = makeApi(async () => ({ ok: true }));
        const confirm = vi.fn();
        const out = await runWithCallerNotice(api, 'a1', { test: true }, confirm, t);
        expect(out).toEqual({ declined: false, result: { ok: true } });
        expect(confirm).not.toHaveBeenCalled();
        expect(api.ack).not.toHaveBeenCalled();
    });

    it('shows the notice with the apps, remembers the answer once, then runs', async () => {
        const run = vi.fn().mockRejectedValueOnce(noticeRequired()).mockResolvedValueOnce({ ok: true });
        const api = makeApi(run);
        const confirm = vi.fn().mockResolvedValue(true);
        const out = await runWithCallerNotice(api, 'a1', { test: true }, confirm, t);
        expect(confirm).toHaveBeenCalledTimes(1);
        const shown = confirm.mock.calls[0][0] as { title: string; description: string };
        expect(shown.title).toBe('This automation runs with your own connections');
        expect(shown.description).toContain('Google, Microsoft');
        expect(shown.description).toContain('the owner\'s knowledge base; files kept under the owner\'s account');
        expect(api.ack).toHaveBeenCalledWith('a1', ['app:google', 'app:microsoft', 'dest:generated_files', 'dest:knowledge_base']);
        expect(run).toHaveBeenCalledTimes(2);
        expect(out).toEqual({ declined: false, result: { ok: true } });
    });

    it('declining starts nothing and remembers nothing', async () => {
        const run = vi.fn().mockRejectedValueOnce(noticeRequired());
        const api = makeApi(run);
        const out = await runWithCallerNotice(api, 'a1', {}, vi.fn().mockResolvedValue(false), t);
        expect(out).toEqual({ declined: true, result: null });
        expect(api.ack).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('any other failure passes through untouched', async () => {
        const api = makeApi(async () => { throw Object.assign(new Error('boom'), { code: 'automation_forbidden' }); });
        await expect(runWithCallerNotice(api, 'a1', {}, vi.fn(), t)).rejects.toThrow('boom');
    });
});
