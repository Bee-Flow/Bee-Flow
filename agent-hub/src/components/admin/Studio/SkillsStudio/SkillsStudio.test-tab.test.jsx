import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { skillsApi } from './skillsApi';
import TestTab from './TestTab';

/**
 * The Test tab (S3): run one question through the steps.
 *
 * The claims this screen makes are the reason it is tested, not the layout:
 *   - a run that FAILED shows why. An empty result list after a call that
 *     "succeeded" would read as "no problems found", which is the exact
 *     shape of a fail-open verdict;
 *   - a step the grader stayed silent about is rendered as a warning, with
 *     its sentence — the server never turns silence into `ok` and neither
 *     does the row;
 *   - the agent picker is the same list the server authorises against, and
 *     a FAILED load says so instead of showing an empty picker (which reads
 *     as "you have no agents");
 *   - the history reloads after a run, so the tab and the overview's Test
 *     column cannot disagree;
 *   - "Run" is off while the skill has no steps — a test grades one step at
 *     a time, and the reason is on screen;
 *   - a stream that ENDS without `done` or `error` is a failure on screen.
 *     The reader resolves on end-of-body, so a cut body looks exactly like a
 *     clean close — and "answer, no verdict, no error" reads as "nothing to
 *     report" while the server in fact stored nothing;
 *   - when the run searched fewer knowledge bases than the skill links, the
 *     screen says so instead of letting the verdict be read as a judgment on
 *     the skill.
 */

vi.mock('./skillsApi', () => {
    const api = {
        list: vi.fn(), usageSummary: vi.fn(), get: vi.fn(), create: vi.fn(),
        update: vi.fn(), remove: vi.fn(), improve: vi.fn(), draft: vi.fn(),
        exampleConversations: vi.fn(), exampleMessages: vi.fn(), exampleFromMessage: vi.fn(),
        test: vi.fn(), testAgents: vi.fn(), testRuns: vi.fn(),
    };
    return { skillsApi: api, default: api };
});

const STEPS = [
    { id: 'st1', text: 'Read the quote', refs: [{ kind: 'automation', id: 'a1' }] },
    { id: 'st2', text: 'Explain every line', refs: [] },
];

const RUN = {
    id: 'run1',
    question: 'What does line 4 mean?',
    status: 'warning',
    advice: 'Say which lines were skipped.',
    ranAt: '2026-09-06T10:00:00.000Z',
    results: [
        { stepId: 'st1', title: 'Read the quote', evidence: 'It quotes the request.', status: 'ok' },
        { stepId: 'st2', title: 'Explain every line', evidence: 'Not assessed — the grader did not report on this step.', status: 'warning' },
    ],
};

/** A stand-in for the SSE call: replays the frames it is given, in order. */
const streams = (frames) => vi.fn(async (id, { onEvent }) => {
    for (const [name, payload] of frames) onEvent(name, payload);
});

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    skillsApi.testRuns.mockResolvedValue({ runs: [] });
    skillsApi.testAgents.mockResolvedValue({ agents: [{ id: 'ag1', name: 'Quote assistant', description: '' }] });
});

const renderTab = (props = {}) => render(
    <TestTab skillId="s1" steps={STEPS} onNavigate={() => {}} {...props} />,
);

describe('before a run', () => {
    it('shows the earlier runs it can back up', async () => {
        skillsApi.testRuns.mockResolvedValue({ runs: [RUN] });
        renderTab();
        const row = await screen.findByTestId('skill-test-run-row');
        expect(row.getAttribute('data-status')).toBe('warning');
        expect(row.textContent).toContain('What does line 4 mean?');
    });

    it('says "not tested" when there are none', async () => {
        renderTab();
        expect(await screen.findByTestId('skill-test-none')).toBeTruthy();
    });

    it('a FAILED history read is not "not tested"', async () => {
        // `setRuns([])` on a rejected read renders "not tested" — a claim
        // about the skill made out of a broken request.
        skillsApi.testRuns.mockRejectedValue(new Error('offline'));
        renderTab();
        expect(await screen.findByTestId('skill-test-history-failed')).toBeTruthy();
        expect(screen.queryByTestId('skill-test-none')).toBeNull();
    });

    it('cannot run without a question', async () => {
        renderTab();
        await screen.findByTestId('skill-test-none');
        expect(screen.getByTestId('skill-test-run').disabled).toBe(true);
    });

    it('cannot run a skill with no steps, and says why', async () => {
        renderTab({ steps: [] });
        await screen.findByTestId('skill-test-none');
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'anything' } });
        expect(screen.getByTestId('skill-test-run').disabled).toBe(true);
        expect(screen.getByTestId('skill-test-no-steps').textContent).toMatch(/Add steps first/i);
    });
});

/**
 * A skill can be VISIBLE without being EDITABLE (skillStore.canEditSkill).
 * The server refuses `POST /:id/test` and `GET /:id/test-runs` on such a
 * skill with 403 `not_editable` — a run writes a `skill_test_runs` row and
 * spends two model calls, so it is an edit. This tab therefore may not offer
 * the button, and may not dress the refusal up as a technical failure.
 */
describe('a skill this account may not edit', () => {
    it('a skill this account may not edit cannot be run, and says why', async () => {
        renderTab({ readOnly: true });
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        // Everything else about the run is in order — only the right is missing.
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What does line 4 mean?' } });
        expect(screen.getByTestId('skill-test-run').disabled).toBe(true);
        expect(screen.getByTestId('skill-test-readonly').textContent).toMatch(/not change it/i);
        fireEvent.click(screen.getByTestId('skill-test-run'));
        expect(skillsApi.test).not.toHaveBeenCalled();
    });

    it('a 403 on the history is a read-only notice, not "not tested"', async () => {
        const err = new Error('Not editable');
        err.status = 403;
        err.code = 'not_editable';
        skillsApi.testRuns.mockRejectedValue(err);
        renderTab();
        expect(await screen.findByTestId('skill-test-readonly')).toBeTruthy();
        // Neither of the two lies: not "never tested", and not "the network
        // broke" — the server answered, and this was the answer.
        expect(screen.queryByTestId('skill-test-none')).toBeNull();
        expect(screen.queryByTestId('skill-test-history-failed')).toBeNull();
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        expect(screen.getByTestId('skill-test-run').disabled).toBe(true);
    });
});

describe('the agent picker', () => {
    it('offers the agents the server says this account may test as', async () => {
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        const select = screen.getByTestId('skill-test-agent');
        expect([...select.options].map(o => o.textContent)).toEqual(['Just this skill', 'Quote assistant']);
    });

    it('sends the chosen agent with the run', async () => {
        skillsApi.test.mockImplementation(streams([['answer', { text: 'ok' }], ['done', { run: RUN }]]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByTestId('skill-test-agent'), { target: { value: 'ag1' } });
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What does line 4 mean?' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        await waitFor(() => expect(skillsApi.test).toHaveBeenCalled());
        expect(skillsApi.test.mock.calls[0][1].agentId).toBe('ag1');
    });

    it('a FAILED load says so — it never shows an empty picker as "you have none"', async () => {
        skillsApi.testAgents.mockRejectedValue(new Error('down'));
        renderTab();
        expect(await screen.findByTestId('skill-test-agents-failed')).toBeTruthy();
        expect(screen.getByTestId('skill-test-agent').disabled).toBe(true);
    });
});

describe('a run', () => {
    it('shows the answer, a row per step, and the advice', async () => {
        skillsApi.test.mockImplementation(streams([
            ['answer', { text: 'Line 4 is the install fee.' }],
            ['done', { run: RUN }],
        ]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What does line 4 mean?' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));

        expect(await screen.findByTestId('skill-test-answer')).toBeTruthy();
        expect(screen.getByTestId('skill-test-answer').textContent).toContain('Line 4 is the install fee.');
        const rows = screen.getAllByTestId('skill-test-step-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute('data-status')).toBe('ok');
        expect(rows[1].getAttribute('data-status')).toBe('warning');
        expect(rows[1].textContent).toMatch(/Not assessed/);
        expect(screen.getByTestId('skill-test-advice').textContent).toContain('Say which lines were skipped.');
    });

    it('reloads the history, so the tab and the overview cannot disagree', async () => {
        skillsApi.test.mockImplementation(streams([['answer', { text: 'x' }], ['done', { run: RUN }]]));
        renderTab();
        await waitFor(() => expect(skillsApi.testRuns).toHaveBeenCalledTimes(1));
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        await waitFor(() => expect(skillsApi.testRuns).toHaveBeenCalledTimes(2));
    });

    it('the advice links to what the first flagged step uses, through the shared deep link', async () => {
        const onNavigate = vi.fn();
        skillsApi.test.mockImplementation(streams([
            ['answer', { text: 'x' }],
            ['done', {
                run: {
                    ...RUN,
                    results: [
                        { stepId: 'st1', title: 'Read the quote', evidence: 'skipped', status: 'error' },
                        { stepId: 'st2', title: 'Explain every line', evidence: 'fine', status: 'ok' },
                    ],
                },
            }],
        ]));
        renderTab({ onNavigate });
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        fireEvent.click(await screen.findByTestId('skill-test-advice-link'));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a1');
    });

    it('offers no link when the flagged step points at nothing', async () => {
        skillsApi.test.mockImplementation(streams([
            ['answer', { text: 'x' }],
            ['done', {
                run: { ...RUN, results: [{ stepId: 'st2', title: 'Explain every line', evidence: 'thin', status: 'warning' }] },
            }],
        ]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        await screen.findByTestId('skill-test-advice');
        expect(screen.queryByTestId('skill-test-advice-link')).toBeNull();
    });
});

describe('a run that did not produce a verdict', () => {
    it('an error frame shows the reason and NO step rows', async () => {
        skillsApi.test.mockImplementation(streams([
            ['answer', { text: 'something' }],
            ['error', { error: 'raw', code: 'grading_failed' }],
        ]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        const err = await screen.findByTestId('skill-test-error');
        expect(err.textContent).toMatch(/could not be graded/i);
        expect(screen.queryAllByTestId('skill-test-step-row')).toHaveLength(0);
        expect(screen.queryByTestId('skill-test-advice')).toBeNull();
    });

    it('a refusal BEFORE the stream keeps its reason', async () => {
        const err = new Error('Add steps first — a test grades one step at a time.');
        err.status = 400;
        err.code = 'no_steps';
        skillsApi.test.mockRejectedValue(err);
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        expect((await screen.findByTestId('skill-test-error')).textContent).toMatch(/Add steps first/i);
    });

    it('an unknown status is drawn as a warning, never as a pass', async () => {
        skillsApi.test.mockImplementation(streams([
            ['answer', { text: 'x' }],
            ['done', { run: { ...RUN, results: [{ stepId: 'st1', title: 'Read the quote', evidence: '?', status: 'excellent' }] } }],
        ]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        const rows = await screen.findAllByTestId('skill-test-step-row');
        expect(rows[0].getAttribute('data-status')).toBe('warning');
    });

    it('a stream that ENDS after the answer is a failure, not a quiet success', async () => {
        // The reader resolves on end-of-body. A close-delimited SSE response
        // (how the Nextcloud proxy frames it) cannot distinguish "cut" from
        // "finished", so a grading pass that died mid-run used to leave the
        // answer on screen with no verdict, no error, and a refreshed history
        // that has no row in it — indistinguishable from "nothing to report".
        skillsApi.test.mockImplementation(streams([['answer', { text: 'the answer' }]]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        const err = await screen.findByTestId('skill-test-error');
        expect(err.textContent).toMatch(/stopped before a verdict/i);
        expect(screen.queryAllByTestId('skill-test-step-row')).toHaveLength(0);
        // And the history is NOT refreshed off a run the server never stored.
        expect(skillsApi.testRuns).toHaveBeenCalledTimes(1);
    });

    it('a done frame carrying no run is the same hole one frame later', async () => {
        skillsApi.test.mockImplementation(streams([['answer', { text: 'x' }], ['done', { run: null }]]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        expect((await screen.findByTestId('skill-test-error')).textContent).toMatch(/stopped before a verdict/i);
    });

    it('a knowledge-base check the server could not run says so', async () => {
        const err = new Error('Could not check which knowledge bases this skill may use. Try again.');
        err.status = 503;
        err.code = 'kb_check_failed';
        skillsApi.test.mockRejectedValue(err);
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        expect((await screen.findByTestId('skill-test-error')).textContent).toMatch(/knowledge bases/i);
    });
});

describe('what the run actually searched', () => {
    it('says when the run searched fewer knowledge bases than the skill links', async () => {
        // The answer AND the verdict below it were built on fewer sources
        // than the skill declares. Silence would let a warning read as a
        // problem with the skill rather than with this account's access.
        skillsApi.test.mockImplementation(streams([
            ['notice', { code: 'kb_dropped', declared: 3, used: 1 }],
            ['answer', { text: 'x' }],
            ['done', { run: RUN }],
        ]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        const line = await screen.findByTestId('skill-test-kb-dropped');
        expect(line.textContent).toMatch(/1 of 3/);
    });

    it('says nothing when every linked base was searched', async () => {
        skillsApi.test.mockImplementation(streams([['answer', { text: 'x' }], ['done', { run: RUN }]]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        await screen.findByTestId('skill-test-answer');
        expect(screen.queryByTestId('skill-test-kb-dropped')).toBeNull();
    });

    it('a new run clears the previous run\'s notice', async () => {
        skillsApi.test.mockImplementation(streams([
            ['notice', { code: 'kb_dropped', declared: 2, used: 0 }],
            ['answer', { text: 'x' }],
            ['done', { run: RUN }],
        ]));
        renderTab();
        await waitFor(() => expect(skillsApi.testAgents).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'q' } });
        fireEvent.click(screen.getByTestId('skill-test-run'));
        await screen.findByTestId('skill-test-kb-dropped');
        skillsApi.test.mockImplementation(streams([['answer', { text: 'y' }], ['done', { run: RUN }]]));
        fireEvent.click(screen.getByTestId('skill-test-run'));
        await waitFor(() => expect(screen.queryByTestId('skill-test-kb-dropped')).toBeNull());
    });
});
