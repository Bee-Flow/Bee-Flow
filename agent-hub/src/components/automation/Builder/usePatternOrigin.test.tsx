import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repeatingApi, repeatingKeys } from '../../../api/queries/automation/repeating';
import type { RepeatingSuggestion, ScanResult } from '../../../api/queries/automation/repeating';
import { queryWrapper, testQueryClient } from '../../../test/queryWrapper';
import usePatternOrigin, { patternOriginOf } from './usePatternOrigin';

const suggestion = (id: string, signature: string | null): RepeatingSuggestion => ({
    id,
    title: `Pattern ${id}`,
    buildPrompt: 'secret build prompt',
    requiredIntegrations: ['gmail'],
    groundedIn: 'activity',
    complexity: 'simple',
    pattern: signature ? {
        kind: 'sequence', signature, cadence: { kind: 'weekly' }, occurrences: 5, windowDays: 90, distinctDays: 5,
        weekdayHistogram: [0, 5, 0, 0, 0, 0, 0], minutesPerMonth: null, basis: 'heuristic', template: null,
        apps: ['gmail'], draft: null, reasons: [], confidence: 'normal',
    } : null,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('patternOriginOf', () => {
    it('keeps the signature and only the allow-listed fields', () => {
        expect(patternOriginOf(suggestion('a', 'sig-a'))).toEqual({
            signature: 'sig-a',
            suggestion: { id: 'a', title: 'Pattern a', requiredIntegrations: ['gmail'], groundedIn: 'activity', complexity: 'simple' },
        });
    });

    it('an idea has no signature; no suggestion means no origin', () => {
        expect(patternOriginOf(suggestion('b', null))).not.toHaveProperty('signature');
        expect(patternOriginOf(null)).toBeNull();
        expect(patternOriginOf({ id: 'x', title: '' })).toBeNull();
    });
});

describe('usePatternOrigin', () => {
    it('sends `built` once with the signature, and drops the pattern from the cached last scan', async () => {
        const post = vi.spyOn(repeatingApi, 'postFeedback').mockResolvedValue(undefined);
        const client = testQueryClient();
        const last: ScanResult = {
            suggestions: [suggestion('a', 'sig-a'), suggestion('b', 'sig-b')], summary: null, reason: null,
            scannedAt: '2026-10-01T09:00:00Z', cached: false, mode: 'patterns',
        };
        client.setQueryData(repeatingKeys.last, last);
        const origin = patternOriginOf(suggestion('a', 'sig-a'));
        const { result } = renderHook(() => usePatternOrigin(origin), { wrapper: queryWrapper(client) });

        act(() => { result.current(); result.current(); });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toEqual({ action: 'built', signature: 'sig-a', suggestion: origin!.suggestion });
        expect(JSON.stringify(post.mock.calls[0][0])).not.toContain('secret build prompt');
        await waitFor(() => {
            expect(client.getQueryData<ScanResult>(repeatingKeys.last)?.suggestions.map(s => s.id)).toEqual(['b']);
        });
        act(() => { result.current(); });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('does nothing without an origin', () => {
        const post = vi.spyOn(repeatingApi, 'postFeedback').mockResolvedValue(undefined);
        const { result } = renderHook(() => usePatternOrigin(null));
        act(() => { result.current(); });
        expect(post).not.toHaveBeenCalled();
    });

    it('a failed send lets the next done path try again, also without a QueryClient', async () => {
        const post = vi.spyOn(repeatingApi, 'postFeedback')
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(undefined);
        const origin = patternOriginOf(suggestion('b', null));
        const { result } = renderHook(() => usePatternOrigin(origin));
        act(() => { result.current(); });
        await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
        await act(async () => { await Promise.resolve(); });
        act(() => { result.current(); });
        expect(post).toHaveBeenCalledTimes(2);
        // An idea is recorded by its title: no signature key at all.
        expect(post.mock.calls[1][0]).toEqual({ action: 'built', suggestion: origin!.suggestion });
    });
});
