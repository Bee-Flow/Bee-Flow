/**
 * The Tests tab: the list with statuses, running the editor's code, the
 * results in plain words, making a test (typed or from a run) and the server's
 * refusals at their field. The network is a stubbed fetch (no module mock);
 * the data layer is a real query client.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeParam } from '@/api/queries/automation/codeStep';
import { withQueryClient } from '@/test/queryWrapper';
import CodeTestsPanel from './CodeTestsPanel';

interface Call { url: string; method: string; body: any }
type Answer = { status?: number; body: unknown };
type Handler = (call: Call) => Answer | undefined;

const TYPED = { id: 'tc_1', stepId: 's1', name: 'Small order', expect: 'success', lastStatus: 'pass', lastRunAt: null,
    assertions: [{ id: 'a1', op: 'count_is', path: 'items', value: { cmp: 'eq', n: 3 } }], input: { kind: 'typed', values: { amount: 5 } } };
const RECORDED = { id: 'tc_2', stepId: 's1', name: 'Real order', expect: 'success', lastStatus: 'fail', lastRunAt: null,
    assertions: [], input: { kind: 'run', runId: 'run_1', fixtureId: 'tfx_1', available: true } };
const LOST = { id: 'tc_3', stepId: 's1', name: 'Old order', expect: 'success', lastStatus: null, lastRunAt: null,
    assertions: [], input: { kind: 'run', runId: null, fixtureId: null, available: false } };

const RUNS = [
    { id: 'run_old', status: 'success', startedAt: '2026-10-01T09:00:00Z', mode: 'live' },
    { id: 'run_new', status: 'error', startedAt: '2026-10-02T09:00:00Z', mode: 'live' },
    { id: 'run_busy', status: 'running', startedAt: '2026-10-03T09:00:00Z', mode: 'live' },
];

const PARAMS: CodeParam[] = [
    { name: 'amount', label: 'Amount', description: null, type: 'number', required: true, line: 1 },
    { name: 'rate', label: 'Rate', description: null, type: 'number', required: false, default: 21, line: 2 },
];

function stub(cases: unknown[], handler: Handler = () => undefined) {
    const calls: Call[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        const call = { url, method, body };
        calls.push(call);
        const custom = handler(call);
        if (custom) return json(custom.status ?? 200, custom.body);
        if (method === 'GET' && url.includes('/runs')) return json(200, { runs: RUNS });
        if (method === 'GET' && /test-cases\/tc_2$/.test(url)) {
            return json(200, { testCase: RECORDED, input: { kind: 'run', available: true, values: { amount: 999 }, runId: 'run_1' } });
        }
        if (method === 'GET') return json(200, { testCases: cases, limits: { perStep: 50, assertions: 50 } });
        if (method === 'POST' && url.endsWith('/test-cases')) return json(201, { testCase: { ...TYPED, id: 'tc_new' } });
        return json(200, {});
    }));
    return calls;
}

const mount = (code = 'return { items: [1, 2] };') => render(withQueryClient(
    <CodeTestsPanel automationId="a1" stepId="s1" code={code} params={PARAMS} />,
));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the list', () => {
    it('shows each test with its last status and where its input comes from', async () => {
        stub([TYPED, RECORDED, LOST]);
        mount();
        const rows = await screen.findAllByTestId('test-case-row');
        expect(rows).toHaveLength(3);
        expect(within(rows[0]).getByText('Small order')).toBeTruthy();
        expect(within(rows[0]).getByTestId('test-status').textContent).toBe('Passed');
        expect(within(rows[0]).getByText('Typed values')).toBeTruthy();
        expect(within(rows[1]).getByTestId('test-status').textContent).toBe('Failed');
        expect(within(rows[1]).getByText('Captured from a run')).toBeTruthy();
        expect(within(rows[2]).getByTestId('test-status').textContent).toBe('Not run yet');
        expect(within(rows[2]).getByText('The run this input came from was deleted')).toBeTruthy();
    });

    it('explains an empty step', async () => {
        stub([]);
        mount();
        expect(await screen.findByText(/No tests yet/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Run all tests' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('asks to save first when there is no saved automation', () => {
        render(withQueryClient(<CodeTestsPanel automationId={null} stepId="s1" code="" params={[]} />));
        expect(screen.getByText(/Save the automation first/)).toBeTruthy();
    });
});

describe('running', () => {
    it('sends the code as it is in the editor and words every check', async () => {
        const user = userEvent.setup();
        const calls = stub([TYPED, LOST], ({ url, method }) => (method === 'POST' && url.endsWith('/test-cases/run') ? { body: {
            stepId: 's1',
            results: [{
                caseId: 'tc_1', name: 'Small order', status: 'fail', reason: null, expectation: { expected: 'success', got: 'success' },
                assertions: [{ id: 'a1', ok: false, code: 'wrong_count', params: { path: 'items', expected: '{"cmp":"eq","n":3}', actual: '2' } }],
                result: { items: [1, 2] }, logs: ['hello log'], calls: [{ kind: 'http', name: 'GET api.example.com', args: null }], durationMs: 4,
            }, {
                caseId: 'tc_3', name: 'Old order', status: 'unusable', reason: 'fixture_expired', expectation: { expected: 'success', got: null },
                assertions: [], logs: [], calls: [], durationMs: 0,
            }],
            summary: { passed: 0, failed: 1, errored: 0, unusable: 1 },
        } } : undefined));
        mount('return { items: [1, 2] }; // not saved yet');
        await screen.findAllByTestId('test-case-row');
        await user.click(screen.getByRole('button', { name: 'Run all tests' }));

        await screen.findByText('Expected items to have exactly 3 entries, got 2.');
        const run = calls.find((c) => c.method === 'POST' && c.url.endsWith('/test-cases/run'))!;
        expect(run.body).toEqual({ stepId: 's1', code: 'return { items: [1, 2] }; // not saved yet' });
        expect(screen.getByText('Expected: it succeeded. Got: it succeeded.')).toBeTruthy();
        expect(screen.getByText('hello log')).toBeTruthy();
        expect(screen.getByText('http · GET api.example.com')).toBeTruthy();
        expect(screen.getByText(/The run this input came from was deleted, so the test cannot run/)).toBeTruthy();
        expect(screen.getByTestId('test-summary').textContent).toBe('0 passed, 1 failed, 0 with an error, 1 could not run');
        const rows = screen.getAllByTestId('test-case-row');
        expect(within(rows[0]).getByTestId('test-status').textContent).toBe('Failed');
        expect(within(rows[1]).getByTestId('test-status').textContent).toBe('Cannot run');
    });

    it('runs one test by its id', async () => {
        const user = userEvent.setup();
        const calls = stub([TYPED, RECORDED], ({ url, method }) => (method === 'POST' && url.endsWith('/test-cases/run')
            ? { body: { stepId: 's1', results: [], summary: { passed: 0, failed: 0, errored: 0, unusable: 0 } } } : undefined));
        mount('return 1;');
        await screen.findAllByTestId('test-case-row');
        await user.click(screen.getByRole('button', { name: 'Run Real order' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/run'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/run'))!.body).toEqual({ stepId: 's1', caseIds: ['tc_2'], code: 'return 1;' });
    });

    it('words a passed check from its definition and an expected error', async () => {
        const user = userEvent.setup();
        stub([TYPED], ({ url, method }) => (method === 'POST' && url.endsWith('/test-cases/run') ? { body: {
            stepId: 's1',
            results: [{
                caseId: 'tc_1', name: 'Small order', status: 'pass', reason: null, expectation: { expected: 'success', got: 'success' },
                assertions: [{ id: 'a1', ok: true, code: 'ok', params: { path: 'items' } }], result: { items: [1, 2, 3] }, logs: [], calls: [], durationMs: 1,
            }],
            summary: { passed: 1, failed: 0, errored: 0, unusable: 0 },
        } } : undefined));
        mount();
        await screen.findAllByTestId('test-case-row');
        await user.click(screen.getByRole('button', { name: 'Run all tests' }));
        expect(await screen.findByText('items has exactly 3 entries')).toBeTruthy();
    });
});

describe('making a test', () => {
    it('creates a test from typed values and a check', async () => {
        const user = userEvent.setup();
        const calls = stub([]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'New test' }));
        await user.type(screen.getByLabelText('Name'), 'Big order');
        // The boxes start from the parameters' defaults.
        expect((screen.getByLabelText('Rate') as HTMLInputElement).value).toBe('21');
        await user.type(screen.getByLabelText('Amount'), '1000');
        await user.click(screen.getByRole('button', { name: 'Add a check' }));
        await user.type(screen.getByLabelText('Where in the result'), 'total');
        await user.selectOptions(screen.getByLabelText('Check'), 'is of type');
        await user.selectOptions(screen.getByLabelText('Type'), 'a number');
        await user.click(screen.getByRole('button', { name: 'Save test' }));

        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/test-cases'))).toBe(true));
        const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/test-cases'))!;
        expect(post.body).toMatchObject({
            stepId: 's1', name: 'Big order', expect: 'success',
            input: { kind: 'typed', values: { amount: '1000', rate: '21' } },
            assertions: [{ op: 'type_is', path: 'total', value: 'number' }],
        });
        // Back to the list afterwards.
        expect(await screen.findByRole('button', { name: 'New test' })).toBeTruthy();
    });

    it('does not send a form that is not whole, and says what is missing', async () => {
        const user = userEvent.setup();
        const calls = stub([]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'New test' }));
        await user.click(screen.getByRole('button', { name: 'Add a check' }));
        await user.type(screen.getByLabelText('Where in the result'), 'a..b');
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        expect(screen.getByText('Give the test a name.')).toBeTruthy();
        expect(screen.getByText(/not a path the checker can read/)).toBeTruthy();
        expect(screen.getByText('Fill in the value this check compares with.')).toBeTruthy();
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('creates a test from a recorded run chosen in the picker, newest first, finished runs only', async () => {
        const user = userEvent.setup();
        const calls = stub([]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'New test' }));
        await user.type(screen.getByLabelText('Name'), 'From a run');
        await user.click(screen.getByLabelText('Use the input of a recorded run'));
        const picker = await screen.findByLabelText('Run to take the input from') as HTMLSelectElement;
        await waitFor(() => expect(picker.options.length).toBe(3));
        expect(Array.from(picker.options).map((o) => o.value)).toEqual(['', 'run_new', 'run_old']);
        await user.selectOptions(picker, 'run_old');
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/test-cases'))).toBe(true));
        expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/test-cases'))!.body.input).toEqual({ kind: 'run', runId: 'run_old' });
    });

    it('asks for a run when none is chosen', async () => {
        const user = userEvent.setup();
        stub([]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'New test' }));
        await user.type(screen.getByLabelText('Name'), 'x');
        await user.click(screen.getByLabelText('Use the input of a recorded run'));
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        expect(screen.getByText('Choose the run to take the input from.')).toBeTruthy();
    });

    it('shows a server refusal at the input, not as a generic failure', async () => {
        const user = userEvent.setup();
        stub([], ({ url, method }) => (method === 'POST' && url.endsWith('/test-cases')
            ? { status: 422, body: { error: 'This step has no recorded input in that run.', code: 'step_not_in_run' } } : undefined));
        mount();
        await user.click(await screen.findByRole('button', { name: 'New test' }));
        await user.type(screen.getByLabelText('Name'), 'From a run');
        await user.click(screen.getByLabelText('Use the input of a recorded run'));
        await user.selectOptions(await screen.findByLabelText('Run to take the input from'), 'run_new');
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        const alert = await screen.findByTestId('test-error-input');
        expect(alert.textContent).toContain('no recorded input in that run');
        expect(screen.queryByTestId('test-error-general')).toBeNull();
    });

    it.each([
        ['test_case_limit', 'general', /reached the number of tests/],
        ['test_data_not_on_prd', 'general', /not kept for automations in a production stage/],
        ['caller_run_not_capturable', 'input', /connections of the person who started it/],
        ['fixture_too_large', 'input', /too large to keep as test data/],
        ['fixture_truncated', 'input', /too large to be recorded in full/],
    ])('words the refusal %s at the %s field', async (code, field, text) => {
        const user = userEvent.setup();
        stub([], ({ url, method }) => (method === 'POST' && url.endsWith('/test-cases') ? { status: 409, body: { error: 'x', code } } : undefined));
        mount();
        await user.click(await screen.findByRole('button', { name: 'New test' }));
        await user.type(screen.getByLabelText('Name'), 'x');
        if (field === 'input') {
            await user.click(screen.getByLabelText('Use the input of a recorded run'));
            await user.selectOptions(await screen.findByLabelText('Run to take the input from'), 'run_new');
        }
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        expect((await screen.findByTestId(`test-error-${field}`)).textContent).toMatch(text);
    });
});

describe('changing a test', () => {
    it('keeps a recorded input read-only and does not send it again', async () => {
        const user = userEvent.setup();
        const calls = stub([RECORDED], ({ method }) => (method === 'PUT' ? { body: { testCase: RECORDED } } : undefined));
        mount();
        await user.click(await screen.findByRole('button', { name: 'Edit Real order' }));
        expect(screen.getByText(/cannot be edited here/)).toBeTruthy();
        expect(await screen.findByText(/999/)).toBeTruthy();
        expect(screen.queryByLabelText('Amount')).toBeNull();
        await user.clear(screen.getByLabelText('Name'));
        await user.type(screen.getByLabelText('Name'), 'Renamed');
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
        const put = calls.find((c) => c.method === 'PUT')!;
        expect(put.url).toMatch(/test-cases\/tc_2$/);
        expect(put.body).toEqual({ name: 'Renamed', expect: 'success', assertions: [] });
    });

    it('starts typed values from the parameter defaults, never from the recorded run', async () => {
        const user = userEvent.setup();
        stub([RECORDED]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'Edit Real order' }));
        await user.click(screen.getByLabelText('Type values'));
        expect((screen.getByLabelText('Rate') as HTMLInputElement).value).toBe('21');
        expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('');
        expect(screen.queryByText(/999/)).toBeNull();
    });

    it('asks for another run when the recorded one was deleted', async () => {
        const user = userEvent.setup();
        stub([LOST]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'Edit Old order' }));
        expect(screen.getByText(/was deleted\. Pick another run/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        expect(screen.getByText('Choose the run to take the input from.')).toBeTruthy();
    });

    it('deletes a test after a second click', async () => {
        const user = userEvent.setup();
        const calls = stub([TYPED]);
        mount();
        await user.click(await screen.findByRole('button', { name: 'Delete Small order' }));
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Delete it' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/test-cases/tc_1'))).toBe(true));
    });
});

describe('the path suggestions', () => {
    it('offer the fields of the last result', async () => {
        const user = userEvent.setup();
        stub([TYPED], ({ url, method }) => (method === 'POST' && url.endsWith('/test-cases/run') ? { body: {
            stepId: 's1',
            results: [{ caseId: 'tc_1', name: 'Small order', status: 'pass', expectation: { expected: 'success', got: 'success' }, assertions: [], result: { total: 3, order: { id: 'x' } }, logs: [], calls: [], durationMs: 1 }],
            summary: { passed: 1, failed: 0, errored: 0, unusable: 0 },
        } } : undefined));
        mount();
        await screen.findAllByTestId('test-case-row');
        await user.click(screen.getByRole('button', { name: 'Run all tests' }));
        await screen.findByTestId('test-case-result');
        await user.click(screen.getByRole('button', { name: 'New test' }));
        await user.click(screen.getByRole('button', { name: 'Add a check' }));
        const list = screen.getByLabelText('Where in the result').getAttribute('list')!;
        const options = Array.from(document.getElementById(list)!.querySelectorAll('option')).map((o) => o.getAttribute('value'));
        expect(options).toEqual(['total', 'order', 'order.id']);
    });
});
