/**
 * The Testen tab's routes.
 *
 * The store and the runtime are faked; `core/agentRuntime/testSandbox` is NOT
 * — every verdict below travels through the real rules, because a test that
 * could switch off the "the grader does not overrule a fact" rule would prove
 * nothing about it.
 *
 * Four properties, and the last three are the ones a reassuring implementation
 * gets wrong:
 *
 *   • Every route asks for the EDIT right, and answers 404 before 403 so an
 *     agent's existence does not leak to someone who may not read it.
 *   • The flags that MAKE it a sandbox are asserted on the metadata the
 *     runtime actually receives. `ephemeral`, `testSandbox`, `unattended` and
 *     an explicit `autoSend: false` are the difference between a test and an
 *     agent mailing a customer, and nothing else in this file would notice
 *     them going missing.
 *   • An unknown never lands on green: a grading call that throws is `error`,
 *     a turn that throws is `error`, a withheld tool is `blocked`, and none of
 *     them counts towards `passed`.
 *   • A run that did not finish is not stored at all, and no answer text ever
 *     enters the stored row.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/tests.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    userId: 'me',
    views: null,
    canRead: true,
    canModify: true,
    tests: [],
    count: 0,
    lastRun: null,
    lastRunThrows: false,
    createThrows: false,
    updateResult: undefined,
    deleteResult: true,
    recorded: [],
    recordThrows: false,
    convAccess: { canRead: true },
    convThrows: false,
    turns: [],
    grades: [],
    gradeThrows: false,
    limitError: null,
    limitThrows: false,
    orgThrows: false,
    modelId: 'fast-model',
    modelResolveThrows: false,
    modelResolveCalls: [],
    gradeCalls: [],
    metadata: [],
    questions: [],
    ranAs: [],
    controller: null,
    abortAfter: null,
    usageRows: [],
    groups: {},
    ownGroups: [],
    groupThrows: false,
};

const MOCKS = {
    '../../stores/agentStore': {
        getAgentViews: async () => (fx.views ? JSON.parse(JSON.stringify(fx.views)) : null),
        listAgentTests: async () => fx.tests.map(t => ({ ...t })),
        countAgentTests: async () => fx.count,
        createAgentTest: async (agentId, test) => {
            if (fx.createThrows) throw new Error('insert failed');
            fx.created = { agentId, ...test };
            return { id: 'new-test', agentId, ...test };
        },
        updateAgentTest: async (agentId, testId, patch) => {
            fx.updated = { agentId, testId, patch };
            return fx.updateResult === undefined ? { id: testId, agentId, ...patch } : fx.updateResult;
        },
        deleteAgentTest: async () => fx.deleteResult,
        recordAgentTestRun: async (run) => {
            if (fx.recordThrows) throw new Error('disk full');
            fx.recorded.push(run);
            return { id: 'run-1', ...run, ranAt: '2026-09-07T00:00:00.000Z' };
        },
        getLastAgentTestRun: async () => {
            if (fx.lastRunThrows) throw new Error('unreadable');
            return fx.lastRun;
        },
    },
    '../../auth': {
        requirePermission: () => (req, res, next) => next(),
        resolveUserOrgIds: async () => {
            if (fx.orgThrows) throw new Error('org lookup down');
            return new Set(['org1']);
        },
    },
    '../../utils/routeHelpers': {
        getEffectiveUserId: () => fx.userId,
        getUserAuth: async () => ({ userId: fx.userId, userOrgId: 'org1', session: {} }),
    },
    '../../utils/perUserRateLimit': {
        perUserRateLimit: () => (req, res, next) => next(),
    },
    '../../core/http/sseHelpers': {
        setupSSE: (res) => {
            res.events = [];
            const abortController = new AbortController();
            fx.controller = abortController;
            return {
                abortController,
                markEnded: () => {},
                sendEvent: (event, data) => { res.events.push({ event, data }); },
            };
        },
        startSseHeartbeat: () => () => {},
    },
    './crud': {
        canReadAgent: async () => fx.canRead,
        canModifyAgent: async () => fx.canModify,
    },
    '../../core/agentRuntime': {
        chatWithAgentStream: async (agentId, userId, message, userAuth, onEvent, history, metadata) => {
            fx.metadata.push(metadata);
            fx.questions.push(message);
            fx.ranAs.push(userId);
            const turn = fx.turns.shift() || { content: 'ok' };
            if (turn.abortNow && fx.controller) fx.controller.abort();
            for (const name of (turn.tools || [])) onEvent('tool_start', { name });
            if (turn.withheld) onEvent('test_sandbox', { withheld: turn.withheld });
            if (turn.throws) throw new Error(turn.throws);
            if (turn.streamed) onEvent('content', { text: turn.streamed });
            return { message: turn.content === undefined ? '' : turn.content };
        },
    },
    '../../core/llm/llmClient': {
        chatForcedTool: async (modelId, messages, toolDef, opts) => {
            fx.gradeCalls.push({ modelId, messages, toolDef, opts });
            if (fx.gradeThrows) throw new Error('provider down');
            const next = fx.grades.shift();
            return { structured: next === undefined ? { pass: true, reason: 'fine' } : next, usage: {} };
        },
    },
    '../../core/llm/modelResolver': {
        resolveModelForTierName: async (tierName, opts) => {
            fx.modelResolveCalls.push({ tierName, opts });
            // Onleesbaar ≠ niet ingericht: dit is de eerste van de twee.
            if (fx.modelResolveThrows) throw new Error('config store unreachable');
            return fx.modelId;
        },
    },
    '../../core/entitlements/limits': {
        checkSubscriptionLimits: async () => {
            if (fx.limitThrows) throw new Error('billing unreachable');
            return fx.limitError;
        },
    },
    '../../stores/usageStore': {
        logUsage: async (row) => { fx.usageRows.push(row); },
    },
    '../../stores/agent/conversationAccess': {
        resolveConversationAccess: async () => {
            if (fx.convThrows) throw new Error('conversation store down');
            return fx.convAccess;
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-tests:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

/**
 * `core/agentRuntime/testAs` is NOT faked — the whole point of the "Test als"
 * cases below is that a group nobody could read refuses instead of running.
 * Only the two reads it makes are replaced, and `canSeePublished` stays the
 * real audience rule.
 */
const realAudience = require('../../auth/audience');
const TEST_AS_MOCKS = {
    '../../stores/userStore': {
        getGroup: async (id) => {
            if (fx.groupThrows) throw new Error('groups table unreachable');
            return fx.groups[id] || null;
        },
        getAllGroups: async () => {
            if (fx.groupThrows) throw new Error('groups table unreachable');
            return Object.values(fx.groups);
        },
    },
    '../../auth/audience': {
        resolveUserGroups: async () => fx.ownGroups,
        canSeePublished: realAudience.canSeePublished,
    },
};
const TEST_AS_IDS = {};
for (const [request, exportsObj] of Object.entries(TEST_AS_MOCKS)) {
    const mockId = `mock:agent-tests:testAs:${request}`;
    TEST_AS_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]tests\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    if (parent && /agentRuntime[\\/]testAs\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(TEST_AS_IDS, request)) {
        return TEST_AS_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./tests');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method = 'GET', url, body = {} }) {
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: fx.userId } },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            events: [],
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setHeader() {}, flushHeaders() {}, write() {}, on() {},
        };
        router(request, res, (err) => {
            // A schema refusal travels as an error to the terminal handler,
            // so the harness has to answer one the way index.js does.
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            terminalErrorHandler(err, request, res, (e) => reject(e));
        });
    });
}

const VIEWS = (over = {}) => ({
    draft: {
        id: 'a1', owner_id: 'me', organization_id: 'org1',
        rev: 12, published_version: 3, published_rev: 7, ...over,
    },
    runtime: { id: 'a1', runtimeSource: over.published_version === 0 ? 'live' : 'published' },
});

const TEST = (over = {}) => ({
    id: 't1', agentId: 'a1', name: 'One', question: 'Q1?',
    expect: { mustMention: [], mustNotMention: [], toolsExpected: [], rulesExpected: [], notes: '' },
    ...over,
});

/** Events of one kind from an SSE response. */
const ev = (res, name) => res.events.filter(e => e.event === name).map(e => e.data);

test.beforeEach(() => {
    Object.assign(fx, {
        userId: 'me', views: VIEWS(), canRead: true, canModify: true,
        tests: [], count: 0, lastRun: null, lastRunThrows: false, createThrows: false,
        updateResult: undefined, deleteResult: true, recorded: [], recordThrows: false,
        convAccess: { canRead: true }, convThrows: false,
        turns: [], grades: [], gradeThrows: false, limitError: null, limitThrows: false,
        orgThrows: false, modelId: 'fast-model',
        modelResolveThrows: false, modelResolveCalls: [], gradeCalls: [],
        metadata: [], questions: [], ranAs: [], controller: null, usageRows: [],
        groups: { sales: { id: 'sales', name: 'Sales', organizationId: 'org1' } },
        ownGroups: [], groupThrows: false,
    });
    delete fx.created;
    delete fx.updated;
});

// ── 1. The gate ──────────────────────────────────────────────────────

test('an agent that does not exist is 404 on every route', async () => {
    fx.views = null;
    for (const call of [
        { method: 'GET', url: '/a1/tests' },
        { method: 'POST', url: '/a1/tests', body: { question: 'q' } },
        { method: 'PUT', url: '/a1/tests/t1', body: { name: 'x' } },
        { method: 'DELETE', url: '/a1/tests/t1' },
        { method: 'POST', url: '/a1/tests/run' },
    ]) {
        const res = await dispatch(call);
        assert.strictEqual(res.statusCode, 404, `${call.method} ${call.url}`);
    }
});

test('an agent the caller may not read is 404, not 403', async () => {
    fx.canRead = false;
    fx.canModify = true;      // would pass on its own — the read gate comes first
    const res = await dispatch({ method: 'GET', url: '/a1/tests' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'Agent not found');
});

test('an agent the caller may chat with but not edit is 403', async () => {
    fx.canModify = false;
    for (const call of [
        { method: 'GET', url: '/a1/tests' },
        { method: 'POST', url: '/a1/tests', body: { question: 'q' } },
        { method: 'POST', url: '/a1/tests/run' },
    ]) {
        const res = await dispatch(call);
        assert.strictEqual(res.statusCode, 403, `${call.method} ${call.url}`);
        assert.strictEqual(res.body.code, 'agent_not_editable');
    }
});

// ── 2. The questions ─────────────────────────────────────────────────

test('GET returns the tests and the last run', async () => {
    fx.tests = [TEST()];
    fx.lastRun = { id: 'run-9', passed: 1, total: 2 };
    const res = await dispatch({ method: 'GET', url: '/a1/tests' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.tests.length, 1);
    assert.strictEqual(res.body.lastRun.id, 'run-9');
    assert.strictEqual(res.body.lastRunUnknown, false);
});

test('a last run that cannot be read is unknown, never "never tested"', async () => {
    fx.lastRunThrows = true;
    const res = await dispatch({ method: 'GET', url: '/a1/tests' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.lastRun, null);
    assert.strictEqual(res.body.lastRunUnknown, true, 'a failed read must be distinguishable from an empty one');
});

test('POST normalises what it stores', async () => {
    const res = await dispatch({
        method: 'POST', url: '/a1/tests',
        body: { question: '  When are you open?  ', expect: { mustMention: ['nine', 'nine', ''] } },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(fx.created.question, 'When are you open?');
    assert.deepStrictEqual(fx.created.expect.mustMention, ['nine']);
    assert.deepStrictEqual(fx.created.expect.mustNotMention, []);
});

test('an expectation the normaliser would drop is refused instead', async () => {
    // `normaliseExpect` is an allow-list that never throws: a phrase list
    // sent as one phrase became `[]`, and a misspelled field name vanished.
    // Either way the test was STORED CHECKING NOTHING and ran green for ever
    // after, answered 201. Both now name the field.
    for (const [expect, field] of [
        [{ mustNotMention: 'junk' }, 'body.expect.mustNotMention'],
        [{ mustMension: ['nine'] }, 'body.expect'],
    ]) {
        fx.created = null;
        const res = await dispatch({ method: 'POST', url: '/a1/tests', body: { question: 'q', expect } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(expect));
        assert.strictEqual(res.body.code, 'invalid_request');
        assert.ok(res.body.details.some((d) => d.path === field), JSON.stringify(res.body.details));
        assert.strictEqual(fx.created, null, 'and nothing is stored');
    }
});

test('a provenance nobody records is refused, not filed as "a human typed this"', async () => {
    // `normaliseWrittenBy` keeps only the four sources it knows and drops the
    // rest; nothing is exactly how this router records HUMAN. So one letter
    // off turned "a model wrote this expectation" into "a person did" — on
    // the field that decides whether a run is green or red.
    fx.created = null;
    const res = await dispatch({
        method: 'POST', url: '/a1/tests',
        body: { question: 'q', writtenBy: { mustMention: 'modl' } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.writtenBy.mustMention'), JSON.stringify(res.body.details));
    assert.strictEqual(fx.created, null);
});

test('POST without a question is 400', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/tests', body: { question: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_question');
});

test('POST past the per-agent cap is 409', async () => {
    const { MAX_TESTS_PER_AGENT } = require('../../core/agentRuntime/testSandbox');
    fx.count = MAX_TESTS_PER_AGENT;
    const res = await dispatch({ method: 'POST', url: '/a1/tests', body: { question: 'q' } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'too_many_tests');
});

test('a conversation link the caller may not read is dropped, not stored', async () => {
    fx.convAccess = null;
    await dispatch({ method: 'POST', url: '/a1/tests', body: { question: 'q', fromConversationId: 'someone-elses' } });
    assert.strictEqual(fx.created.fromConversationId, null);

    fx.convAccess = { canRead: false };
    await dispatch({ method: 'POST', url: '/a1/tests', body: { question: 'q', fromConversationId: 'c2' } });
    assert.strictEqual(fx.created.fromConversationId, null);

    fx.convThrows = true;
    await dispatch({ method: 'POST', url: '/a1/tests', body: { question: 'q', fromConversationId: 'c3' } });
    assert.strictEqual(fx.created.fromConversationId, null, 'a check that failed is not a yes');

    fx.convThrows = false;
    fx.convAccess = { canRead: true };
    await dispatch({ method: 'POST', url: '/a1/tests', body: { question: 'q', fromConversationId: 'c4' } });
    assert.strictEqual(fx.created.fromConversationId, 'c4');
});

test('PUT passes the agent id to the store, and 404s when the pair does not exist', async () => {
    await dispatch({ method: 'PUT', url: '/a1/tests/t1', body: { name: 'Renamed' } });
    assert.strictEqual(fx.updated.agentId, 'a1');
    assert.strictEqual(fx.updated.testId, 't1');

    fx.updateResult = null;              // a test id belonging to another agent
    const res = await dispatch({ method: 'PUT', url: '/a1/tests/t1', body: { name: 'x' } });
    assert.strictEqual(res.statusCode, 404);
});

test('PUT refuses to blank the question', async () => {
    const res = await dispatch({ method: 'PUT', url: '/a1/tests/t1', body: { question: '  ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_question');
});

test('DELETE of an unknown test is 404', async () => {
    fx.deleteResult = false;
    const res = await dispatch({ method: 'DELETE', url: '/a1/tests/t1' });
    assert.strictEqual(res.statusCode, 404);
});

// ── 3. The run ───────────────────────────────────────────────────────

test('a run with no tests is 400 before anything is spent', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_tests');
    assert.strictEqual(fx.metadata.length, 0);
});

test('the sandbox flags reach the runtime, and autoSend never does', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'Hello' }];
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(fx.metadata.length, 1);
    const md = fx.metadata[0];
    assert.strictEqual(md.ephemeral, true, 'a test must not write a conversation');
    assert.strictEqual(md.testSandbox, true, 'without this the stack keeps its mail tools');
    assert.strictEqual(md.unattended, true);
    assert.strictEqual(md.autoSend, false, 'autoSend turns a draft into a real send');
    assert.ok(md.signal, 'a disconnect has to be able to stop the run');
    // The turn runs as the CALLER. Running it as the agent's owner would let
    // anyone with edit rights read the owner's knowledge and connections
    // through a question they wrote themselves.
    assert.deepStrictEqual(fx.ranAs, ['me']);
});

test('the turn runs as the caller, not as the agent owner', async () => {
    fx.userId = 'colleague';
    fx.views = VIEWS({ owner_id: 'someone-else' });
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.deepStrictEqual(fx.ranAs, ['colleague']);
});

test('a green run stores the verdict and the version it describes', async () => {
    fx.tests = [TEST(), TEST({ id: 't2', name: 'Two', question: 'Q2?' })];
    fx.turns = [{ content: 'A1' }, { content: 'A2' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });

    const done = ev(res, 'done')[0];
    assert.strictEqual(done.passed, 2);
    assert.strictEqual(done.total, 2);
    assert.strictEqual(fx.recorded.length, 1);
    const run = fx.recorded[0];
    assert.strictEqual(run.passed, 2);
    assert.strictEqual(run.total, 2);
    assert.strictEqual(run.version, 3, 'the published version that actually ran');
    assert.strictEqual(run.results.source, 'published');
    assert.strictEqual(run.results.agentRev, 12);
    assert.strictEqual(run.results.unpublishedChanges, 5, 'rev 12 against published_rev 7');
});

test('an agent with no published version records version 0 and source live', async () => {
    fx.views = VIEWS({ published_version: 0, published_rev: null });
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(fx.recorded[0].version, 0);
    assert.strictEqual(fx.recorded[0].results.source, 'live');
    assert.strictEqual(fx.recorded[0].results.unpublishedChanges, 0);
});

test('a forbidden wording fails even when the grader says pass', async () => {
    fx.tests = [TEST({ expect: { mustNotMention: ['IBAN'] } })];
    fx.turns = [{ content: 'The iban is NL01BEE0123456789.' }];
    fx.grades = [{ pass: true, reason: 'reads well' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });

    const result = ev(res, 'test_result')[0];
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.pass, false);
    assert.deepStrictEqual(result.forbiddenHits, ['IBAN']);
    assert.strictEqual(fx.recorded[0].passed, 0);
});

test('a deterministic failure never spends a grading call', async () => {
    fx.tests = [TEST({ expect: { mustNotMention: ['secret'] } })];
    fx.turns = [{ content: 'the secret is out' }];
    fx.gradeThrows = true;            // would blow up if it were called
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(ev(res, 'test_result')[0].status, 'fail');
    assert.strictEqual(fx.usageRows.length, 0);
});

test('a grading call that fails is error, never pass', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'Some answer' }];
    fx.gradeThrows = true;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    const result = ev(res, 'test_result')[0];
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.pass, false);
    assert.strictEqual(fx.recorded[0].passed, 0);
    assert.strictEqual(fx.recorded[0].total, 1, 'an ungradable test still counts against the total');
});

test('a grader answer nobody can read is error, never pass', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'Some answer' }];
    fx.grades = [{ pass: 'probably', reason: 'hmm' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(ev(res, 'test_result')[0].status, 'error');
});

test('a tool the sandbox withheld makes the test blocked, not failed', async () => {
    fx.tests = [TEST({ expect: { toolsExpected: ['gmail_compose'] } })];
    fx.turns = [{ content: 'I have sent it', withheld: [{ name: 'gmail_compose', reason: 'sends' }] }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    const result = ev(res, 'test_result')[0];
    assert.strictEqual(result.status, 'blocked');
    assert.deepStrictEqual(result.toolsWithheld, ['gmail_compose']);
    assert.strictEqual(fx.recorded[0].passed, 0);
});

test('an expected tool that was offered and ignored fails', async () => {
    fx.tests = [TEST({ expect: { toolsExpected: ['datatable_query'] } })];
    fx.turns = [{ content: 'From memory: we are open at nine.', tools: ['agent_search'] }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    const result = ev(res, 'test_result')[0];
    assert.strictEqual(result.status, 'fail');
    assert.deepStrictEqual(result.toolsMissing, ['datatable_query']);
    assert.deepStrictEqual(result.toolsUsed, ['agent_search']);
});

test('a turn that throws is one error, not the end of the run', async () => {
    fx.tests = [TEST(), TEST({ id: 't2', name: 'Two' })];
    fx.turns = [{ throws: 'model unavailable' }, { content: 'second answer' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    const results = ev(res, 'test_result');
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].status, 'error');
    assert.match(results[0].reason, /model unavailable/);
    assert.strictEqual(results[1].status, 'pass');
    assert.strictEqual(fx.recorded[0].passed, 1);
    assert.strictEqual(fx.recorded[0].total, 2);
});

test('an empty answer is error, not a pass and not a silent skip', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: '' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(ev(res, 'test_result')[0].status, 'error');
    assert.strictEqual(fx.recorded[0].total, 1);
});

test('a run the client walked away from is not stored', async () => {
    fx.tests = [TEST(), TEST({ id: 't2' }), TEST({ id: 't3' })];
    fx.turns = [{ content: 'A1', abortNow: true }, { content: 'A2' }, { content: 'A3' }];
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.deepStrictEqual(fx.recorded, [], '"1 of 1 green" out of three tests is the worst row this table could hold');
});

test('the answer is streamed to the watcher and kept out of the stored row', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'Our IBAN is NL01BEE0123456789 and the customer is Jan Jansen.' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });

    assert.match(ev(res, 'test_result')[0].answer, /Jan Jansen/);
    const stored = JSON.stringify(fx.recorded[0]);
    assert.ok(!stored.includes('Jan Jansen'), 'agent_test_runs.results is not an encrypted column');
    assert.ok(!stored.includes('NL01BEE'));
});

test('a run that cannot be saved says so and still finishes', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    fx.recordThrows = true;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(ev(res, 'error')[0].code, 'not_saved');
    assert.strictEqual(ev(res, 'done')[0].run, null);
});

test('a plan that is out of chat runs refuses before the first turn', async () => {
    fx.tests = [TEST()];
    fx.limitError = 'Monthly chat limit reached';
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(fx.metadata.length, 0);
});

test('a plan check that could not run refuses the run', async () => {
    fx.tests = [TEST()];
    fx.limitThrows = true;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'limit_check_failed');
    assert.strictEqual(fx.metadata.length, 0, 'nothing may be spent on a ceiling nobody could read');
});

test('a workspace that cannot be resolved refuses — it is what the ceiling is checked against', async () => {
    fx.tests = [TEST()];
    fx.orgThrows = true;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'org_check_failed');
    assert.strictEqual(fx.metadata.length, 0);
});

test('no grading model refuses up front instead of burning a turn per test', async () => {
    fx.tests = [TEST(), TEST({ id: 't2' })];
    fx.modelId = null;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'no_grading_model');
    assert.strictEqual(fx.metadata.length, 0);
});

// ── De beoordelaar: welk model ziet dit antwoord? ─────────────────────
// De poort hierboven was in productie ONBEREIKBAAR: resolveModelForTierName
// had een default-fallback naar een hardgecodeerd Google-model en gaf dus
// nooit iets falsy terug. Er werd stilzwijgend beoordeeld op een model dat de
// organisatie nooit koos, terwijl de gradingcall het ANTWOORD van de agent
// meestuurt. De drie tests hieronder houden die poort bereikbaar.

test('een lege beoordelaar-configuratie weigert — er wordt geen model ingevuld', async () => {
    fx.tests = [TEST()];
    fx.modelId = null;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'no_grading_model');
    assert.ok(/configured/i.test(res.body.error), 'de reden hoort leesbaar te zijn');
    assert.strictEqual(fx.gradeCalls.length, 0, 'er ging geen tekst naar enig model');
    // En de route vraagt de resolver NIET om een stille terugval.
    assert.strictEqual(fx.modelResolveCalls.length, 1);
    assert.ok(!fx.modelResolveCalls[0].opts?.fallback,
        `de route vroeg om fallback ${fx.modelResolveCalls[0].opts?.fallback}`);
});

test('een beoordelaar die niet GELEZEN kon worden is een ander antwoord dan geen beoordelaar', async () => {
    fx.tests = [TEST(), TEST({ id: 't2' })];
    fx.modelResolveThrows = true;
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(res.statusCode, 503, 'onleesbaar weigert óók — het valt niet terug');
    assert.strictEqual(res.body.code, 'grading_model_unavailable');
    assert.notStrictEqual(res.body.code, 'no_grading_model',
        '"niet ingericht" en "niet te lezen" zijn twee verschillende antwoorden');
    assert.strictEqual(fx.metadata.length, 0, 'geen enkele beurt gedraaid');
    assert.strictEqual(fx.gradeCalls.length, 0);
});

test('met configuratie beoordeelt het GEKOZEN model, en niets vult stilletjes een ander in', async () => {
    fx.modelId = 'org-chosen-grader';
    fx.tests = [TEST()];
    fx.turns = [{ content: 'An answer worth grading' }];
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(fx.gradeCalls.length, 1);
    assert.strictEqual(fx.gradeCalls[0].modelId, 'org-chosen-grader');
    assert.strictEqual(fx.usageRows[0].model, 'org-chosen-grader',
        'de kostenregel noemt hetzelfde model als de call');
    assert.deepStrictEqual(fx.modelResolveCalls.map(c => c.tierName), ['fast']);
});

test('an unreadable runtime projection is reported as published, not as the concept', async () => {
    // The reassuring answer would be version 0 — "the concept ran" — which
    // tells the publish dialog these results describe what you are shipping.
    fx.views = VIEWS();
    fx.views.runtime = { id: 'a1' };            // runtimeSource missing
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(fx.recorded[0].results.source, 'published');
    assert.strictEqual(fx.recorded[0].version, 3);
});

test('only the named tests run, and never more than the per-run cap', async () => {
    const { MAX_TESTS_PER_RUN } = require('../../core/agentRuntime/testSandbox');
    fx.tests = [TEST(), TEST({ id: 't2', question: 'Q2?' }), TEST({ id: 't3', question: 'Q3?' })];
    await dispatch({ method: 'POST', url: '/a1/tests/run', body: { testIds: ['t3'] } });
    assert.deepStrictEqual(fx.questions, ['Q3?']);

    fx.metadata = [];
    fx.questions = [];
    fx.tests = Array.from({ length: MAX_TESTS_PER_RUN + 7 }, (_, i) => TEST({ id: `t${i}`, question: `Q${i}?` }));
    await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(fx.questions.length, MAX_TESTS_PER_RUN);
});

test('the start event describes the run before a single turn is spent', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    const start = ev(res, 'start')[0];
    assert.strictEqual(start.total, 1);
    assert.strictEqual(start.version, 3);
    assert.strictEqual(start.source, 'published');
    assert.strictEqual(start.unpublishedChanges, 5);
});

// ── 4. "Test als · groep X" ──────────────────────────────────────────

test('a simulated run carries the group into every turn, and says so up front', async () => {
    fx.tests = [TEST(), TEST({ id: 't2', question: 'Q2?' })];
    fx.turns = [{ content: 'A' }, { content: 'B' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: ' sales ' } });

    for (const meta of fx.metadata) {
        assert.deepStrictEqual(meta.testAs, { groupId: 'sales', groupName: 'Sales', orgId: 'org1' });
    }
    const start = ev(res, 'start')[0];
    assert.deepStrictEqual(start.testAs, { groupId: 'sales', groupName: 'Sales' });
});

test('an ordinary run carries no simulation at all', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run' });
    assert.strictEqual(fx.metadata[0].testAs, null);
    assert.strictEqual(ev(res, 'start')[0].testAs, null);
    assert.strictEqual(ev(res, 'start')[0].audience, null);
});

test('a group nobody can name refuses before a single turn is spent', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: 'marketing' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'test_as_group_not_found');
    assert.deepStrictEqual(fx.metadata, [], 'nothing may run under a label that was never verified');
});

test('a group store that is down refuses — it does not quietly run as the editor', async () => {
    // The reassuring alternative: skip the simulation, run the tests, and hand
    // back answers under a label saying they were somebody else's.
    fx.groupThrows = true;
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: 'sales' } });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'test_as_group_unreadable');
    assert.deepStrictEqual(fx.metadata, []);
});

test('a simulated run is never stored as the agent\'s test result', async () => {
    // `agent_test_runs` is what the publish dialog reads as a verdict on the
    // agent. A deliberately narrowed score is not that.
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: 'sales' } });
    assert.deepStrictEqual(fx.recorded, []);
    const done = ev(res, 'done')[0];
    assert.strictEqual(done.run, null);
    assert.strictEqual(done.notStored, 'test_as');
    assert.strictEqual(done.passed, 1);
    assert.deepStrictEqual(done.testAs, { groupId: 'sales', groupName: 'Sales' });
});

test('the run says whether that group could open the agent at all', async () => {
    fx.views = VIEWS({ shared_groups: ['other'], is_published: true });
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: 'sales' } });
    // Reported, not enforced: the run still happens.
    assert.strictEqual(ev(res, 'start')[0].audience.visible, false);
    assert.strictEqual(ev(res, 'start')[0].audience.reason, 'group_restricted');
    assert.strictEqual(fx.metadata.length, 1);

    fx.metadata = [];
    fx.views = VIEWS({ shared_groups: ['sales'], is_published: true });
    fx.turns = [{ content: 'A' }];
    const ok = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: 'sales' } });
    assert.strictEqual(ev(ok, 'start')[0].audience.visible, true);
});

test('a selection that is one id, not a list, is refused instead of running every test', async () => {
    // `Array.isArray` was false, so `wanted` became null and the route ran
    // the WHOLE set — up to 25 agent turns on somebody's plan, for a request
    // that asked for one.
    fx.tests = [TEST(), TEST({ id: 't2' })];
    fx.metadata = [];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { testIds: 't1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'testIds is a list of test ids.');
    assert.deepStrictEqual(fx.metadata, [], 'and nothing runs');
});

test('an asGroup that is not a usable group id is a 400, not a silent plain run', async () => {
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const res = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: { id: 'sales' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'test_as_invalid_group');
    assert.deepStrictEqual(fx.metadata, []);
});

// ── 5. The picker ────────────────────────────────────────────────────

test('the tab hands back the groups this editor may test as', async () => {
    fx.groups = {
        sales: { id: 'sales', name: 'Sales', organizationId: 'org1' },
        hr: { id: 'hr', name: 'HR', organizationId: 'org2' },
        users: { id: 'users', name: 'Users', organizationId: null },
    };
    fx.ownGroups = ['users'];
    const res = await dispatch({ method: 'GET', url: '/a1/tests' });
    assert.deepStrictEqual(res.body.testAsGroups, [
        { id: 'sales', name: 'Sales' },
        { id: 'users', name: 'Users' },
    ]);
    assert.strictEqual(res.body.testAsGroupsUnknown, false);
    // The picker and the resolver share one predicate; this is the assertion
    // that says so out loud. A list that offers what the run then refuses is a
    // broken feature, and the reverse is a list that leaks who is in what.
    for (const g of res.body.testAsGroups) {
        fx.tests = [TEST()];
        fx.turns = [{ content: 'A' }];
        const out = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: g.id } });
        assert.strictEqual(out.statusCode, 200, `the picker offered ${g.id}`);
    }
    fx.tests = [TEST()];
    fx.turns = [{ content: 'A' }];
    const refused = await dispatch({ method: 'POST', url: '/a1/tests/run', body: { asGroup: 'hr' } });
    assert.strictEqual(refused.statusCode, 400, 'the group it did NOT offer is the one it refuses');
});

test('groups that could not be read are unknown, never an empty workspace', async () => {
    fx.groupThrows = true;
    const res = await dispatch({ method: 'GET', url: '/a1/tests' });
    assert.deepStrictEqual(res.body.testAsGroups, []);
    assert.strictEqual(res.body.testAsGroupsUnknown, true);
});

test('a workspace that could not be resolved does not list every workspace\'s groups', async () => {
    // `resolveUserOrgIds` returning null means SUPER ADMIN one line later. A
    // failed resolve must not arrive there wearing the same shape.
    fx.orgThrows = true;
    fx.groups = { hr: { id: 'hr', name: 'HR', organizationId: 'org2' } };
    const res = await dispatch({ method: 'GET', url: '/a1/tests' });
    assert.deepStrictEqual(res.body.testAsGroups, []);
    assert.strictEqual(res.body.testAsGroupsUnknown, true);
});
