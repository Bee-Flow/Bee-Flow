import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

import {
    useShieldStatus,
    parseShieldStatus,
    deriveShieldClaims,
    invalidateShieldStatus,
    SHIELD_STATUS_POLL_MS,
} from './useShieldStatus';
import { notifyManager } from '@tanstack/react-query';
import { queryClient } from '../api/queryClient';
import { queryWrapper } from '../test/queryWrapper';

// The app's own client: the invalidator acts on that singleton, and
// clearing it before each case keeps one case's answer out of the next.
const wrapper = queryWrapper(queryClient);

// React Query hands its updates over through setTimeout(0), which a fake
// clock never fires by itself. A microtask keeps them flowing under
// vi.useFakeTimers without advancing the clock the test is reasoning about.
notifyManager.setScheduler(queueMicrotask);

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Chat signals are off in both: an older server sends no such block, and
// that reads exactly like an explicit off (api/queries/shieldStatus.test.ts).
const CHAT_SIGNALS_OFF = { state: 'off', from: null, version: null, surfaces: [], signals: [], noticeUrl: null };
const ON = {
    enabled: true, source: 'org', action: 'redact', failMode: 'fail_closed',
    guardReachable: true, euMode: false, coworkEnabled: true, chatMonitoring: CHAT_SIGNALS_OFF,
};
const OFF = {
    enabled: false, source: 'off', action: null, failMode: 'fail_closed',
    guardReachable: false, euMode: false, coworkEnabled: false, chatMonitoring: CHAT_SIGNALS_OFF,
};

const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('parseShieldStatus', () => {
    it('allow-lists the keys and reads anything unexpected as the negative state', () => {
        expect(parseShieldStatus({
            ...ON,
            userEmail: 'ada@example.org', rules: ['IBAN'], degradedReason: 'guard_unreachable: ECONNREFUSED',
        })).toEqual(ON);
        expect(parseShieldStatus({ enabled: 'yes', source: 'admin', action: 'allow', failMode: 'open', guardReachable: 1 }))
            .toEqual(OFF);
        expect(parseShieldStatus({})).toEqual(OFF);
    });

    it('is null for a body that is not an object — unknown, so nothing is claimed', () => {
        expect(parseShieldStatus(null)).toBeNull();
        expect(parseShieldStatus('ok')).toBeNull();
        expect(parseShieldStatus([ON])).toBeNull();
    });
});

describe('deriveShieldClaims — the one rule', () => {
    it('claims nothing while the status is unknown', () => {
        expect(deriveShieldClaims(null)).toEqual({ shieldActive: false, replacesPersonalData: false, coworkShieldActive: false });
    });

    it('a shield that is on without a reachable detector is NOT active (no green lock)', () => {
        expect(deriveShieldClaims({ ...ON, guardReachable: false }))
            .toEqual({ shieldActive: false, replacesPersonalData: false, coworkShieldActive: false });
    });

    it('only a masking action may be worded as "replaced"', () => {
        expect(deriveShieldClaims(ON)).toEqual({ shieldActive: true, replacesPersonalData: true, coworkShieldActive: true });
        expect(deriveShieldClaims({ ...ON, action: 'block' })).toMatchObject({ shieldActive: true, replacesPersonalData: false });
        expect(deriveShieldClaims({ ...ON, action: 'ask' })).toMatchObject({ shieldActive: true, replacesPersonalData: false });
    });

    it('the Cowork claim has its own gate but the same detector rule', () => {
        expect(deriveShieldClaims({ ...ON, coworkEnabled: false })).toMatchObject({ shieldActive: true, coworkShieldActive: false });
        expect(deriveShieldClaims({ ...OFF, coworkEnabled: true, guardReachable: true }))
            .toMatchObject({ shieldActive: false, coworkShieldActive: true });
    });
});

beforeEach(() => {
    vi.useFakeTimers();
    queryClient.clear();
    fetchMock.mockReset();
    invalidateShieldStatus();
    setVisibility('visible');
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useShieldStatus — one request, shared', () => {
    it('fetches once on mount and exposes the parsed status', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        const { result } = renderHook(() => useShieldStatus(), { wrapper });
        expect(result.current).toEqual({ data: null, loading: true, error: null });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/privacy/shield-status');
        expect(result.current).toEqual({ data: ON, loading: false, error: null });
    });

    it('two consumers on one screen share a single request and the same answer', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        const pill = renderHook(() => useShieldStatus(), { wrapper });
        const composer = renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(pill.result.current.data).toEqual(ON);
        expect(composer.result.current.data).toEqual(ON);

        // A third consumer mounting later starts from the memo — no flash of
        // "unknown" and no extra request.
        const cowork = renderHook(() => useShieldStatus(), { wrapper });
        expect(cowork.result.current).toEqual({ data: ON, loading: false, error: null });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a failed response yields data null with a code — nothing is claimed, nothing throws', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401 });
        const { result } = renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        expect(result.current).toEqual({ data: null, loading: false, error: 'unauthorized' });

        fetchMock.mockResolvedValue({ ok: false, status: 503 });
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS); });
        await flush();
        expect(result.current).toEqual({ data: null, loading: false, error: 'unavailable' });

        fetchMock.mockRejectedValue(new Error('offline'));
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS); });
        await flush();
        expect(result.current).toEqual({ data: null, loading: false, error: 'network' });

        fetchMock.mockResolvedValue(ok('not-json-object'));
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS); });
        await flush();
        expect(result.current).toEqual({ data: null, loading: false, error: 'invalid' });
    });

    it('a failure after a good answer drops the memo — a stale claim never survives an outage', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        const { result } = renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        expect(result.current.data).toEqual(ON);
        fetchMock.mockRejectedValue(new Error('offline'));
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS); });
        await flush();
        expect(result.current.data).toBeNull();
        expect(deriveShieldClaims(result.current.data).shieldActive).toBe(false);
    });
});

describe('useShieldStatus — polling discipline', () => {
    it('polls every 30s and the memo expires between polls', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS); });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('skips the fetch while the tab is hidden and catches up on visibilitychange', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        setVisibility('hidden');
        const { result } = renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS); });
        expect(fetchMock).not.toHaveBeenCalled();
        setVisibility('visible');
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
            await Promise.resolve();
        });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.data).toEqual(ON);
    });

    it('enabled: false polls nothing and claims nothing', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        const { result, rerender } = renderHook(({ enabled }) => useShieldStatus({ enabled }), { wrapper, initialProps: { enabled: true } });
        await flush();
        expect(result.current.data).toEqual(ON);
        rerender({ enabled: false });
        expect(result.current).toEqual({ data: null, loading: false, error: null });
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS * 2); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('invalidateShieldStatus makes the next load fetch again', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        const first = renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // Its caller is logout, which runs while the old screens are still up;
        // what it promises is that the NEXT mount reads fresh, not that the
        // departing one refetches on its way out.
        first.unmount();
        fetchMock.mockResolvedValue(ok(OFF));
        invalidateShieldStatus();
        const { result } = renderHook(() => useShieldStatus(), { wrapper });
        expect(result.current.data, 'the next mount must not start from the dropped answer').toBeNull();
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.current.data).toEqual(OFF);
    });

    it('stops polling on unmount', async () => {
        fetchMock.mockResolvedValue(ok(ON));
        const { unmount } = renderHook(() => useShieldStatus(), { wrapper });
        await flush();
        unmount();
        await act(async () => { vi.advanceTimersByTime(SHIELD_STATUS_POLL_MS * 2); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
