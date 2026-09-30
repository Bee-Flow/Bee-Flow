/**
 * The Test tab's wire: the named SSE frames become the four events the tab
 * acts on, anything else (pings, unknown notices) is dropped, and the side
 * reads keep only rows with an id.
 */

import { api } from '@/core/api/client';
import { streamSse } from '@/core/api/sse';

import { listTestAgents, listTestRuns, runSkillTest, toTestEvent } from './testEndpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { ...actual.api, get: jest.fn() } };
});
jest.mock('@/core/api/sse', () => ({ streamSse: jest.fn() }));

const get = api.get as jest.Mock;

describe('toTestEvent', () => {
    it('reads the four frames the route sends', () => {
        expect(toTestEvent('answer', { text: 'Hi' })).toEqual({ type: 'answer', text: 'Hi' });
        expect(toTestEvent('notice', { code: 'kb_dropped', declared: '3', used: 1 })).toEqual({ type: 'kb_dropped', declared: 3, used: 1 });
        expect(toTestEvent('error', { error: 'No', code: 'no_answer' })).toEqual({ type: 'error', code: 'no_answer', message: 'No' });
        const done = toTestEvent('done', { run: { id: 'r1', question: 'q', results: [{ stepId: 's1', title: 'T' }], status: 'ok' } });
        expect(done).toEqual({
            type: 'done',
            run: { id: 'r1', question: 'q', results: [{ stepId: 's1', title: 'T', evidence: '', status: 'warning' }], status: 'ok', advice: null, ranAt: null },
        });
    });

    it('keeps a done without a run as a done without a verdict', () => {
        expect(toTestEvent('done', {})).toEqual({ type: 'done', run: null });
    });

    it('drops what the tab does not act on', () => {
        expect(toTestEvent('ping', {})).toBeNull();
        expect(toTestEvent('notice', { code: 'other' })).toBeNull();
    });
});

describe('runSkillTest', () => {
    it('POSTs the question and yields only the events', async () => {
        (streamSse as jest.Mock).mockImplementation(async function* () {
            yield { event: 'ping', data: {} };
            yield { event: 'answer', data: { text: 'A' } };
            yield { event: 'done', data: { run: { id: 'r' } } };
        });
        const events = [];
        for await (const e of runSkillTest('sk 1', { agentId: null, question: 'Q?' })) events.push(e.type);
        expect(events).toEqual(['answer', 'done']);
        expect(streamSse).toHaveBeenCalledWith('/api/skills/sk%201/test', {
            body: { agentId: null, question: 'Q?' },
            signal: undefined,
            idleTimeoutMs: 120_000,
        });
    });
});

describe('the side reads', () => {
    beforeEach(() => get.mockReset());

    it('keeps agents with an id', async () => {
        get.mockResolvedValue({ agents: [{ id: 'a1', name: 'Sales' }, { name: 'No id' }] });
        expect(await listTestAgents()).toEqual([{ id: 'a1', name: 'Sales', description: '' }]);
    });

    it('reads the runs list', async () => {
        get.mockResolvedValue({ runs: [{ id: 'r1', question: 'q', status: 'ok', advice: 'x', ranAt: '2026-09-01' }] });
        const runs = await listTestRuns('sk1');
        expect(get).toHaveBeenCalledWith('/api/skills/sk1/test-runs', { signal: undefined });
        expect(runs[0]).toMatchObject({ id: 'r1', advice: 'x', results: [] });
    });
});
