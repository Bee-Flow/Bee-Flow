import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { queryWrapper } from '../../test/queryWrapper';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import {
    CustomDataError, parseAssist, parsePreview, parseTest, parseTune,
    useAssistMutation, useAssistPreviewQuery, useTestMutation, useTuneMutation,
} from './customData';
import { authFetch } from '../../utils/helpers';

/**
 * The /custom-data wire contract, in one place. The parsers are allow-lists:
 * what the server did not promise never reaches a component. Errors travel as
 * the server's `code`, and a 429 (which the rate limiter sends without one)
 * is still recognised.
 */

const mocked = vi.mocked(authFetch);
const respond = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const TYPE = { id: 'cdt_0123456789', name: 'Codes', description: 'Customer codes', method: 'pattern' as const };

// No mockReset/mockClear between tests: under vitest 4 a spy that was reset
// and then throws has that error reported against the test even though the
// code under test caught it. Every test sets its own implementation and
// reads its own call with `.at(-1)` instead.

describe('parsers', () => {
    it('keep only what the contract promises', () => {
        expect(parsePreview({ outbound: { name: 'N', description: 'D', lookalikes: ['KL-83920', 7], extra: 1 }, keepFixedProposal: ['KL-'], secret: 'x' }))
            .toEqual({ outbound: { name: 'N', description: 'D', lookalikes: ['KL-83920'] }, keepFixedProposal: ['KL-'] });
        expect(parsePreview(null)).toEqual({ outbound: { name: '', description: '', lookalikes: [] }, keepFixedProposal: [] });
    });

    it('keep "not marked" and "nothing should be hidden" apart', () => {
        const a = parseAssist({
            sentences: [{ id: 's1', text: 'KL-12345 due', gold: [{ start: 0, end: 8 }] }],
            nearMisses: [{ id: 's2', text: 'KL-1 is short', gold: [] }],
            suggestedMethod: 'nonsense',
            candidates: { patterns: [{ source: 'KL-\\d{5}', describe: 'KL- and 5 digits' }, { describe: 'no source' }], aiLabels: ['code'] },
        });
        expect(a.sentences[0]).toEqual({ id: 's1', text: 'KL-12345 due', gold: [{ start: 0, end: 8 }], origin: 'assistant' });
        expect(a.nearMisses[0].gold).toEqual([]);
        expect(a.nearMisses[0].origin).toBe('nearmiss');
        expect(a.suggestedMethod).toBeNull();
        expect(a.candidates.patterns).toEqual([{ source: 'KL-\\d{5}', describe: 'KL- and 5 digits' }]);
        const unmarked = parseAssist({ sentences: [{ id: 's3', text: 'x' }] }).sentences[0];
        expect(unmarked).not.toHaveProperty('gold');
    });

    it('drop unknown mark kinds and empty spans, and pass on "degraded"', () => {
        const r = parseTest({
            results: [{ id: 's1', marks: [{ start: 0, end: 4, kind: 'hit' }, { start: 5, end: 5, kind: 'hit' }, { start: 6, end: 8, kind: 'weird' }], verdict: 'correct' }],
            summary: { found: 1, total: 1, falseAlarms: 0, sentences: 1 },
            engine: 'guard',
            degraded: true,
        });
        expect(r.results[0].marks).toEqual([{ start: 0, end: 4, kind: 'hit' }]);
        expect(r.engine).toBe('guard');
        expect(r.degraded).toBe(true);
        expect(parseTest({}).degraded).toBe(false);
    });

    it('never let a flags-only tune answer empty a word list', () => {
        const r = parseTune({
            best: { config: { words: { caseSensitive: true, wholeWord: false } }, summary: { found: 3, total: 3 }, describe: { flags: ['whole_word'] } },
            before: { summary: { found: 2, total: 3 } },
            improved: true,
            tried: 4,
        });
        expect(r.best.config.words).toEqual({ caseSensitive: true, wholeWord: false });
        expect(r.best.describe.wholeWord).toBe(true);
        expect(r.best.describe.caseSensitive).toBe(false);
        expect(r.before.summary.found).toBe(2);
        expect(r.improved).toBe(true);
    });
});

describe('hooks', () => {
    it('asks for the preview with exactly the card\'s input, and no LLM route', async () => {
        mocked.mockResolvedValue(respond(200, { outbound: { name: 'Codes', description: 'Customer codes', lookalikes: ['KL-83920'] }, keepFixedProposal: [] }));
        const { result } = renderHook(
            () => useAssistPreviewQuery('org-1', { type: TYPE, examples: ['KL-12345'] }),
            { wrapper: queryWrapper() },
        );
        await waitFor(() => expect(result.current.data).toBeDefined());
        const [url, init] = mocked.mock.calls.at(-1)!;
        // authFetch is plain JS, so its options argument types as `{}`.
        const opts = init as RequestInit | undefined;
        expect(url).toBe('/api/org-privacy-shield/org-1/custom-data/assist/preview');
        expect(JSON.parse(String(opts?.body))).toEqual({ type: TYPE, examples: ['KL-12345'] });
        expect(result.current.data?.outbound.lookalikes).toEqual(['KL-83920']);
    });

    it('does not ask for a preview before the type has a name', () => {
        const before = mocked.mock.calls.length;
        renderHook(
            () => useAssistPreviewQuery('org-1', { type: { ...TYPE, name: ' ' }, examples: [] }),
            { wrapper: queryWrapper() },
        );
        expect(mocked.mock.calls.length).toBe(before);
    });

    it('sends the look-alikes it showed, and reads a 409 as preview_stale', async () => {
        mocked.mockResolvedValue(respond(409, { error: 'The preview is out of date.', code: 'preview_stale', correlationId: 'c1' }));
        const { result } = renderHook(() => useAssistMutation('org-1'), { wrapper: queryWrapper() });
        await expect(result.current.mutateAsync({ type: TYPE, examples: ['KL-12345'], expectLookalikes: ['KL-83920'] }))
            .rejects.toMatchObject({ code: 'preview_stale', status: 409 });
        expect(JSON.parse(String((mocked.mock.calls.at(-1)![1] as RequestInit).body)).expectLookalikes).toEqual(['KL-83920']);
    });

    it('reads nested details: the personal-data findings and a pattern refusal', async () => {
        mocked.mockResolvedValueOnce(respond(422, {
            error: 'x', code: 'assist_personal_data', details: { findings: [{ field: 'description', start: 0, end: 4, category: 'Person' }] },
        }));
        const { result } = renderHook(() => useAssistMutation('org-1'), { wrapper: queryWrapper() });
        const err = await result.current.mutateAsync({ type: TYPE, examples: [], expectLookalikes: [] }).catch(e => e);
        expect(err).toBeInstanceOf(CustomDataError);
        expect(err.findings).toEqual([{ field: 'description', start: 0, end: 4, category: 'Person' }]);

        mocked.mockResolvedValueOnce(respond(422, { error: 'x', code: 'pattern_unsafe', details: { reason: 'nested_quantifier' } }));
        const test = renderHook(() => useTestMutation('org-1'), { wrapper: queryWrapper() });
        const err2 = await test.result.current.mutateAsync({ type: { ...TYPE, tokenKey: 'code', origin: 'created' }, sentences: [] }).catch(e => e);
        expect(err2.code).toBe('pattern_unsafe');
        expect(err2.reason).toBe('nested_quantifier');
    });

    it('recognises a rate limit by its status, since the limiter sends no code', async () => {
        mocked.mockResolvedValue(respond(429, { error: 'Too many requests' }));
        const { result } = renderHook(() => useTuneMutation('org-1'), { wrapper: queryWrapper() });
        await expect(result.current.mutateAsync({ type: { ...TYPE, tokenKey: 'code', origin: 'created' }, sentences: [], examples: [] }))
            .rejects.toMatchObject({ code: 'rate_limited' });
    });

    it('turns a network failure into a code too', async () => {
        mocked.mockImplementation(() => { throw new TypeError('offline'); });
        const { result } = renderHook(() => useTestMutation('org-1'), { wrapper: queryWrapper() });
        const err = await result.current.mutateAsync({ type: { ...TYPE, tokenKey: 'code', origin: 'created' }, sentences: [] }).catch(e => e);
        expect(err).toBeInstanceOf(CustomDataError);
        expect(err.code).toBe('network');
    });
});
