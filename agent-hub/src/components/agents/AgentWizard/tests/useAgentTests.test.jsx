/**
 * De lezingen achter de testset-kaart (A4 deel D).
 *
 * De kaart kan nog zo eerlijk zijn — als de hook een mislukte lezing als een
 * lege lijst doorgeeft, staat er alsnog "nog niet gedraaid" boven een agent
 * met twaalf groene tests. Wat hier vastligt:
 *
 *   • een mislukte `GET /tests` levert `lastRunUnknown`, niet "nooit";
 *   • een weigering van `POST /tests/run` raakt de vorige uitslag niet aan;
 *   • alleen `done` maakt van een stroom resultaten een uitslag, en alleen een
 *     BEWAARDE uitslag wordt de nieuwe laatste run.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/tests/useAgentTests.test.jsx
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PROGRESS, REFUSAL } from './testSetFacts';
import useAgentTests from './useAgentTests';
import { authFetch } from '../../../../utils/helpers';
import { READ } from '../canUse/canUseFacts';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));

const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const stream = (chunks) => {
    const encoded = chunks.map(c => new TextEncoder().encode(c));
    let i = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () => (i < encoded.length
                    ? Promise.resolve({ done: false, value: encoded[i++] })
                    : Promise.resolve({ done: true, value: undefined })),
                cancel: () => Promise.resolve(),
            }),
        },
    };
};

const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const TESTS_BODY = {
    tests: [{ id: 't1', name: 'One', question: 'q1' }],
    lastRun: { id: 'r1', passed: 1, total: 1, ranAt: '2026-09-07T12:00:00.000Z', results: { items: [{ testId: 't1', status: 'pass' }] } },
    lastRunUnknown: false,
    limits: { maxTests: 100, maxPerRun: 25 },
};

beforeEach(() => {
    authFetch.mockReset();
});

/** Standaard: de eerste lezing lukt. */
function withTests(body = TESTS_BODY) {
    authFetch.mockImplementation(async (url) => {
        if (String(url).endsWith('/tests')) return json(body);
        throw new Error(`unexpected fetch: ${url}`);
    });
}

describe('useAgentTests — de eerste lezing', () => {
    it('leest de vragen, de laatste run en de grenzen', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));
        expect(result.current.tests).toHaveLength(1);
        expect(result.current.lastRun.id).toBe('r1');
        expect(result.current.limits.maxPerRun).toBe(25);
    });

    it('BIJT — een mislukte lezing is NIET "nog nooit gedraaid"', async () => {
        authFetch.mockImplementation(async () => json({ error: 'boom' }, 500));
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.ERROR));
        expect(result.current.lastRun).toBeNull();
        expect(result.current.lastRunUnknown).toBe(true);
    });

    it('neemt het "onbekend" van de server over', async () => {
        withTests({ ...TESTS_BODY, lastRun: null, lastRunUnknown: true });
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));
        expect(result.current.lastRunUnknown).toBe(true);
    });
});

describe('useAgentTests — de historie', () => {
    it('haalt de historie pas op als erom gevraagd wordt', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));
        expect(authFetch.mock.calls.some(c => String(c[0]).endsWith('/tests/runs'))).toBe(false);

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/runs')) return json({ runs: [{ id: 'r1' }], runsUnknown: false, keep: 20 });
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.loadRuns(); });
        expect(result.current.runs).toHaveLength(1);
        expect(result.current.runsKeep).toBe(20);
    });

    it('BIJT — een historie die niet gelezen kon worden is geen lege historie', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));
        authFetch.mockImplementation(async () => json({ error: 'nope' }, 500));
        await act(async () => { await result.current.loadRuns(); });
        expect(result.current.runsState).toBe(READ.ERROR);
        expect(result.current.runsUnknown).toBe(true);
    });
});

describe('useAgentTests — de run', () => {
    it('BIJT — een weigering laat de vorige uitslag met rust', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/run')) return json({ error: 'No AI model is configured to grade these answers.', code: 'no_grading_model' }, 503);
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.runTests(); });

        expect(result.current.refusal.kind).toBe(REFUSAL.NO_GRADER);
        expect(result.current.progress).toBeNull();
        expect(result.current.lastRun.id).toBe('r1');
        expect(result.current.running).toBe(false);
    });

    it('een afgeronde run wordt de nieuwe laatste run', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/run')) {
                return stream([
                    ev('start', { total: 2 }),
                    ev('test_result', { testId: 't1', status: 'pass' }),
                    ev('test_result', { testId: 't2', status: 'fail' }),
                    ev('done', { passed: 1, total: 2, run: { id: 'r2', passed: 1, total: 2 } }),
                ]);
            }
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.runTests(); });

        expect(result.current.progress.status).toBe(PROGRESS.COMPLETE);
        expect(result.current.lastRun.id).toBe('r2');
    });

    it('BIJT — een stream die zonder "done" ophoudt wordt geen laatste run', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/run')) {
                return stream([ev('start', { total: 9 }), ev('test_result', { testId: 't1', status: 'pass' })]);
            }
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.runTests(); });

        expect(result.current.progress.status).toBe(PROGRESS.UNFINISHED);
        expect(result.current.lastRun.id).toBe('r1', 'de vorige uitslag blijft de laatste');
    });

    it('een "Test als"-run wordt getoond maar niet bewaard', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/run')) {
                return stream([
                    ev('start', { total: 1 }),
                    ev('test_result', { testId: 't1', status: 'pass' }),
                    ev('done', { passed: 1, total: 1, run: null, notStored: 'test_as' }),
                ]);
            }
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.runTests(); });

        expect(result.current.progress.notStored).toBe('test_as');
        expect(result.current.lastRun.id).toBe('r1');
    });

    it('een error-event onderweg is een weigering, geen uitslag', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/run')) {
                return stream([
                    ev('start', { total: 1 }),
                    ev('test_result', { testId: 't1', status: 'pass' }),
                    ev('error', { error: 'The tests ran, but the result could not be saved.', code: 'not_saved' }),
                ]);
            }
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.runTests(); });

        expect(result.current.refusal.kind).toBe(REFUSAL.NOT_SAVED);
        expect(result.current.progress.status).toBe(PROGRESS.UNFINISHED);
        expect(result.current.lastRun.id).toBe('r1');
    });
});

describe('useAgentTests — voorstel en opslaan', () => {
    it('geeft het voorstel door zoals de server het schreef', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        const suggestion = { expect: { mustMention: ['x'] }, wrote: { mustMention: 'ai' }, suggestedBy: 'ai' };
        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/suggest')) return json({ suggestion, suggestedBy: 'ai', model: 'fast' });
            return json(TESTS_BODY);
        });
        let out;
        await act(async () => { out = await result.current.suggest({ question: 'q', answer: 'a', toolsUsed: ['kb_search'] }); });
        expect(out.suggestion).toEqual(suggestion);
        expect(out.refusal).toBeNull();
        const sent = JSON.parse(authFetch.mock.calls.find(c => String(c[0]).endsWith('/tests/suggest'))[1].body);
        expect(sent).toEqual({ question: 'q', answer: 'a', toolsUsed: ['kb_search'] });
    });

    it('BIJT — een voorstel dat niet kwam is geen leeg voorstel', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests/suggest')) return json({ code: 'no_suggestion_model' }, 503);
            return json(TESTS_BODY);
        });
        let out;
        await act(async () => { out = await result.current.suggest({ question: 'q', answer: 'a' }); });
        expect(out.suggestion).toBeNull();
        expect(out.refusal.kind).toBe(REFUSAL.NO_SUGGESTER);
    });

    it('een opgeslagen test komt in de lijst; een geweigerde niet', async () => {
        withTests();
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));

        authFetch.mockImplementation(async (url, opts) => {
            if (String(url).endsWith('/tests') && opts?.method === 'POST') {
                return json({ test: { id: 't2', name: 'Two', question: 'q2' } }, 201);
            }
            return json(TESTS_BODY);
        });
        await act(async () => { await result.current.createTest({ question: 'q2' }); });
        expect(result.current.tests.map(t => t.id)).toEqual(['t1', 't2']);

        authFetch.mockImplementation(async (url, opts) => {
            if (String(url).endsWith('/tests') && opts?.method === 'POST') {
                return json({ error: 'too many', code: 'too_many_tests' }, 409);
            }
            return json(TESTS_BODY);
        });
        let out;
        await act(async () => { out = await result.current.createTest({ question: 'q3' }); });
        expect(out.refusal.kind).toBe(REFUSAL.TOO_MANY);
        expect(result.current.tests.map(t => t.id)).toEqual(['t1', 't2']);
    });
});

describe('BIJT — een geweigerde lezing draagt zijn reden', () => {
    it('403 agent_not_editable komt terug als weigering, niet als storing', async () => {
        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests')) return json({ error: 'nope', code: 'agent_not_editable' }, 403);
            throw new Error(`unexpected fetch: ${url}`);
        });
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.ERROR));
        expect(result.current.readRefusal).toBeTruthy();
        expect(result.current.readRefusal.kind).toBe(REFUSAL.NOT_EDITABLE);
        expect(result.current.readRefusal.retryable).toBe(false);
        // En nog steeds geen bewering over of er ooit gedraaid is.
        expect(result.current.lastRunUnknown).toBe(true);
    });

    it('een netwerkfout heeft geen code en dus geen weigering', async () => {
        authFetch.mockImplementation(async () => { throw new Error('offline'); });
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.ERROR));
        expect(result.current.readRefusal).toBe(null);
        expect(result.current.lastRunUnknown).toBe(true);
    });
});

describe('BIJT — alleen een BEWAARDE run wordt de laatste run', () => {
    it('een "Test als"-run met een rij erbij wordt hem nog steeds niet', async () => {
        // De server stuurt vandaag `run: null` naast `notStored`, dus de helft
        // `state.run` blokkeert het al. Deze test oefent de ANDERE helft uit:
        // zou de route morgen een rij meesturen bij een simulatie, dan mag die
        // nog steeds niet de laatste run worden — de score van een gesimuleerde
        // groep is geen oordeel over de agent.
        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests')) return json(TESTS_BODY);
            if (String(url).endsWith('/tests/run')) {
                return stream([
                    ev('start', { total: 1, testAs: { groupName: 'Sales' } }),
                    ev('test_result', { testId: 't1', status: 'fail' }),
                    ev('done', { run: { id: 'r-simulated', passed: 0, total: 1 }, notStored: 'test_as', passed: 0, total: 1 }),
                ]);
            }
            throw new Error(`unexpected fetch: ${url}`);
        });
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));
        await act(async () => { await result.current.runTests({ asGroup: 'g1' }); });

        expect(result.current.progress.status).toBe(PROGRESS.COMPLETE);
        expect(result.current.progress.notStored).toBe('test_as');
        expect(result.current.lastRun.id).toBe('r1');
    });

    it('een gewone afgeronde run wordt hem wél', async () => {
        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/tests')) return json(TESTS_BODY);
            if (String(url).endsWith('/tests/run')) {
                return stream([
                    ev('start', { total: 1 }),
                    ev('test_result', { testId: 't1', status: 'pass' }),
                    ev('done', { run: { id: 'r2', passed: 1, total: 1 }, passed: 1, total: 1 }),
                ]);
            }
            throw new Error(`unexpected fetch: ${url}`);
        });
        const { result } = renderHook(() => useAgentTests({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.testsState).toBe(READ.OK));
        await act(async () => { await result.current.runTests(); });
        expect(result.current.lastRun.id).toBe('r2');
    });
});
