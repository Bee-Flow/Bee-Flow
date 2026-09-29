import { describe, it, expect, vi, beforeEach } from 'vitest';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch }));

import { parseAutomationCounts, publishAutomation, isAiActRefusal } from './meta';

beforeEach(() => authFetch.mockReset());

describe('parseAutomationCounts', () => {
    it('keeps numbers and turns anything else into null, never 0', () => {
        expect(parseAutomationCounts({ runs7d: 38, runsFailed7d: 'x', versions: 5 }))
            .toEqual({ runs7d: 38, runsFailed7d: null, versions: 5, pendingChanges: null });
        expect(parseAutomationCounts(null)).toEqual({ runs7d: null, runsFailed7d: null, versions: null, pendingChanges: null });
    });
});

describe('publishAutomation', () => {
    it('posts the version the person saw and returns the row', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ automation: { id: 'a1', liveVersion: 5 } }) });
        const r = await publishAutomation('a1', 5);
        expect(r.automation).toEqual({ id: 'a1', liveVersion: 5 });
        expect(authFetch).toHaveBeenCalledWith('/api/automation/a1/publish', expect.objectContaining({ method: 'POST', body: '{"version":5}' }));
    });

    it('carries the refusal code, so the AI Act refusal can open Settings', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Do the AI Act check first.', code: 'ai_act_check_required' }) });
        const e = await publishAutomation('a1', 5).catch((err: unknown) => err);
        expect(isAiActRefusal(e)).toBe(true);
        expect((e as Error).message).toBe('Do the AI Act check first.');
        expect(isAiActRefusal(new Error('x'))).toBe(false);
    });

    it('treats a prohibited-practice refusal as an AI Act refusal too', () => {
        expect(isAiActRefusal(Object.assign(new Error('x'), { code: 'ai_act_prohibited' }))).toBe(true);
        expect(isAiActRefusal(Object.assign(new Error('x'), { code: 'version_changed' }))).toBe(false);
    });

    it('names the incomplete step when the definition is refused', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Invalid definition', details: [{ code: 'x', message: 'Step 2 has no folder' }] }) });
        const e = await publishAutomation('a1', 5).catch((err: unknown) => err);
        expect((e as Error).message).toBe('Invalid definition: Step 2 has no folder');
    });
});
