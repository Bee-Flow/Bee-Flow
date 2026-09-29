'use strict';

/**
 * routes/skills/test — the Test tab's run (S3).
 *
 * This endpoint runs an agent turn because somebody pressed a button in an
 * editor, and writes a row the overview reads as a verdict. Both of those
 * are pinned here:
 *
 *   THE SANDBOX
 *   - the tool list handed to the turn is exactly `skillSandbox`'s, and the
 *     executor it is given refuses a tool nobody has heard of. A sandbox
 *     built as a filter over the agent's real stack would pass the first
 *     assertion and fail the second;
 *   - the knowledge bases searched are the CALLER'S, not the skill's word,
 *     and the check is the RETRIEVAL one (`usableKbIdsForRequest`) rather
 *     than the management one: an org admin does not get to have a colleague's
 *     draft base read aloud by a test run, and a super admin does not get to
 *     have another tenant's read aloud at all;
 *   - a check that could not RUN refuses the run (503) instead of searching
 *     nothing behind the model's back, and a partial refusal is said out
 *     loud. `quickKBSearch` does no tenant filtering — the id list IS the
 *     boundary — so "nothing" is safe, but it is not honest on its own.
 *
 *   THE AGENT
 *   - `agentId` comes from the client and `getAgent` has no access control.
 *     An agent that is not in `testableAgents` is a 404 (not a 403: that
 *     would confirm the id exists in somebody else's account), and the
 *     system prompt is never built from it;
 *   - a failure to BUILD that list refuses the run. An empty list from an
 *     error would be an open door.
 *
 *   THE VERDICT
 *   - no body, no steps, no answer, no usable grading ⇒ NO row is written.
 *     A stored run is read later as a claim; "it could not be graded" is not
 *     one. A clean run writes exactly one row, and two usage rows.
 *
 * DB-free: every dependency is stubbed through a `Module._resolveFilename`
 * hook keyed on this file. `core/skills/*` stays REAL — the sandbox and the
 * grading clamps are the contract; only the sandbox's own retrieval
 * (`quickKBSearch`) is cut, at SANDBOX_MOCKS.
 *
 * This file terminates ON ITS OWN — no `--test-force-exit`. That is a
 * property under test, not a convenience: see the require hook below and the
 * guard in the last describe.
 *
 * Run: cd server && node --test routes/skills/test.test.js
 */

const test = require('node:test');
const { beforeEach, describe } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures the stubs close over ───────────────────────────────────
const fx = {
    userId: 'owner',
    orgId: 'org1',
    canManage: true,
    skill: null,
    published: [],
    own: [],
    runtimeAgent: null,
    agentsThrow: null,
    answer: 'I read the quote and explained every line.',
    grading: null,
    model: 'claude-fast',
    kbAllowed: [],
    kbThrows: false,
    recorded: [],
    calls: [],
    /** The resolved Privacy Shield the turn reads (BFSF-354). */
    shield: null,
    guardrailRows: [],
    /** What the sandbox's knowledge search hands back. */
    passages: [],
};
const rec = (name, args) => { fx.calls.push({ name, args }); };
const lastCall = (name) => [...fx.calls].reverse().find(c => c.name === name);

const MOCKS = {
    '../../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../../stores/skillStore': {
        getSkill: async (id, orgId, userId, viewer) => { rec('getSkill', { id, orgId, userId, viewer }); return fx.skill; },
        recordTestRun: async (p) => {
            rec('recordTestRun', p);
            fx.recorded.push(p);
            return { id: 'run1', ...p, ranAt: '2026-09-06T10:00:00.000Z' };
        },
    },
    '../../stores/userStore': { getUser: async () => ({ id: fx.userId, organizationId: fx.orgId, groups: ['g1'] }) },
    '../../stores/usageStore': { logUsage: async (entry) => { rec('logUsage', entry); } },
    '../../stores/agentStore': {
        getPublishedAgentsForUser: async (groups, orgId, orgIds) => {
            rec('getPublishedAgentsForUser', { groups, orgId, orgIds });
            if (fx.agentsThrow) throw fx.agentsThrow;
            return fx.published;
        },
        getAgents: async (userId) => { rec('getAgents', { userId }); return fx.own; },
        getForRuntime: async (id) => { rec('getForRuntime', { id }); return fx.runtimeAgent; },
    },
    '../../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../../auth/permissions': { hasPermission: async () => fx.canManage },
    // ONLY the retrieval check. `partitionAccessibleKBIds` is deliberately
    // absent: it is the MANAGEMENT check (org admins reach every base in
    // their org, a super admin every base of every tenant, and the surface
    // question is never asked), and a route that reaches for it here would
    // throw rather than silently widen what a test run may read.
    '../../support/kbAccess': {
        usableKbIdsForRequest: async (req, ids, opts) => {
            rec('usableKbIdsForRequest', { ids, opts });
            if (fx.kbThrows) throw new Error('kb store down');
            return ids.filter(i => fx.kbAllowed.includes(i));
        },
    },
    '../../core/llm/modelResolver': {
        resolveModelForTier: async (raw) => { rec('resolveModelForTier', { raw }); return fx.model; },
        resolveModelWithGlobalFallback: async () => fx.model,
    },
    '../../core/llm/llmClient': {
        runToolLoop: async (modelId, messages, tools, options, executeTool, maxRounds) => {
            rec('runToolLoop', { modelId, messages, tools, options, executeTool, maxRounds });
            return { content: fx.answer, usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
        },
        chatForcedTool: async (modelId, messages, toolDef, options) => {
            rec('chatForcedTool', { modelId, messages, toolDef, options });
            return { structured: fx.grading, usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
        },
    },
};
// The Privacy Shield tool block lists (BFSF-354): the shield the turn reads,
// and the guardrail rows it writes.
MOCKS['../../core/privacy/orgShield'] = { resolveShieldFor: async () => fx.shield };
MOCKS['../../stores/guardrailEventStore'] = { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } };
// The sandbox's own retrieval, cut where core/skills/skillSandbox.js reaches it.
const SANDBOX_MOCKS = {
    '../agentRuntime/knowledgeSearch': {
        quickKBSearch: async (userId, kbIds, query) => { rec('quickKBSearch', { userId, kbIds, query }); return fx.passages; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(SANDBOX_MOCKS)) {
    const mockId = `mock:skill-test-sandbox:${request}`;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:skill-test-route:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
// The parent key covers `test.test.js` as well as `test.js`. It used to match
// only the route, so a `require('../../core/llm/llmClient')` FROM THIS FILE
// fell outside the hook and loaded the real client — which loads
// `core/aiAgent.js`, which loads `stores/configStore.js`, which starts its
// LISTEN/NOTIFY reconnect loop at module load. The pg client of each attempt
// is not unref'd, so the event loop never emptied and this file never
// terminated without `--test-force-exit`. Mutate `MOCKS[...]` instead of
// requiring a module; the regression guard at the bottom of this file fails
// the moment a real one gets pulled back in.
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]skills[\\/]test(\.test)?\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    if (parent && /core[\\/]skills[\\/]skillSandbox\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(SANDBOX_MOCKS, request)) {
        return `mock:skill-test-sandbox:${request}`;
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const route = require('./test');
test.after(() => { Module._resolveFilename = originalResolve; });

// ── Minimal req/res, with just enough SSE ───────────────────────────
function makeReq({ params = {}, body = {}, userId = fx.userId } = {}) {
    return { params, body, session: { user: { id: userId } } };
}
function makeRes() {
    const res = { statusCode: 200, body: undefined, chunks: [], headers: null, writableEnded: false };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; return res; };
    res.write = (chunk) => { res.chunks.push(chunk); return true; };
    res.end = () => { res.writableEnded = true; return res; };
    /** The SSE frames as `[name, payload]`. */
    res.events = () => res.chunks.map((c) => {
        const name = /event: (\S+)/.exec(c)?.[1];
        const data = /data: (.*)\n\n$/s.exec(c)?.[1];
        return [name, data ? JSON.parse(data) : null];
    });
    res.event = (name) => res.events().find(e => e[0] === name)?.[1];
    return res;
}

const SKILL = (over = {}) => ({
    id: 'sk1', orgId: 'org1', userId: 'owner', name: 'Quote helper',
    description: 'Helps', instructions: 'When asked about quotes.',
    workflow: '1. Read the quote\n2. Explain every line',
    steps: [
        { id: 'st1', text: 'Read the quote', refs: [{ kind: 'kb', id: 'kb1' }] },
        { id: 'st2', text: 'Explain every line', refs: [] },
    ],
    rulesV2: [], examplesV2: [], knowledgeBaseIds: ['kb2'], canEdit: true, ...over,
});

const GRADING = {
    steps: [
        { stepId: 'st1', status: 'ok', evidence: 'It quotes the request.' },
        { stepId: 'st2', status: 'warning', evidence: 'Only two lines named.' },
    ],
    advice: 'Say which lines were skipped.',
};

beforeEach(() => {
    fx.calls = [];
    fx.recorded = [];
    fx.shield = null;
    fx.guardrailRows = [];
    fx.passages = [];
    fx.skill = SKILL();
    fx.published = [];
    fx.own = [];
    fx.runtimeAgent = null;
    fx.agentsThrow = null;
    fx.answer = 'I read the quote and explained every line.';
    fx.grading = JSON.parse(JSON.stringify(GRADING));
    fx.model = 'claude-fast';
    fx.kbAllowed = [];
    fx.kbThrows = false;
    fx.canManage = true;
});

async function runWith(body = { question: 'What does line 4 mean?' }) {
    const res = makeRes();
    await route.run(makeReq({ params: { id: 'sk1' }, body }), res);
    return res;
}

describe('a clean run', () => {
    test('streams the answer, grades it, and writes exactly ONE run row', async () => {
        const res = await runWith();
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
        assert.strictEqual(res.headers['X-Accel-Buffering'], 'no');
        assert.strictEqual(res.event('answer').text, fx.answer);
        assert.strictEqual(fx.recorded.length, 1);
        const row = fx.recorded[0];
        assert.strictEqual(row.skillId, 'sk1');
        assert.strictEqual(row.agentId, null);
        assert.strictEqual(row.status, 'warning', 'the worst of the steps');
        assert.deepStrictEqual(row.results.map(r => r.stepId), ['st1', 'st2']);
        assert.deepStrictEqual(row.results.map(r => r.title), ['Read the quote', 'Explain every line']);
        assert.strictEqual(row.advice, 'Say which lines were skipped.');
        assert.strictEqual(res.event('done').run.id, 'run1');
        assert.ok(res.writableEnded);
    });

    test('a skill with more steps than one pass grades is not stored as green', async () => {
        // The grading prompt is capped (MAX_GRADED_STEPS); the stored ROW is
        // not. Passing the capped list into parseGrading dropped the rest of
        // the skill out of the verdict, so a 20-step skill was filed `ok` on
        // twelve graded steps.
        const { MAX_GRADED_STEPS } = require('../../core/skills/skillTest');
        const many = Array.from({ length: MAX_GRADED_STEPS + 6 }, (_, i) => ({ id: `s${i}`, text: `step ${i}`, refs: [] }));
        fx.skill = SKILL({ steps: many });
        fx.grading = {
            steps: many.slice(0, MAX_GRADED_STEPS).map(s => ({ stepId: s.id, status: 'ok', evidence: 'done' })),
            advice: '',
        };
        await runWith();
        const row = fx.recorded[0];
        assert.strictEqual(row.results.length, many.length, 'every step of the skill is in the stored row');
        assert.strictEqual(row.results[MAX_GRADED_STEPS].status, 'warning');
        assert.strictEqual(row.status, 'warning', 'not ok — the steps past the cap were never looked at');
    });

    test('two usage rows — the turn and the grading, each with its own model', async () => {
        await runWith();
        const logged = fx.calls.filter(c => c.name === 'logUsage').map(c => c.args);
        assert.deepStrictEqual(logged.map(l => l.source), ['skill_test', 'skill_test_grade']);
        assert.strictEqual(logged[0].total_tokens, 140);
        assert.strictEqual(logged[1].total_tokens, 40);
        assert.ok(logged.every(l => l.organization_id === 'org1' && l.user_id === 'owner'));
    });

    test('the skill body is in the system prompt, and the read-only rule with it', async () => {
        await runWith();
        const { messages } = lastCall('runToolLoop').args;
        assert.match(messages[0].content, /\[ACTIVE SKILLS\]/);
        assert.match(messages[0].content, /Workflow: 1\. Read the quote/);
        assert.match(messages[0].content, /SKILL TEST — READ ONLY/);
        assert.strictEqual(messages[1].content, 'What does line 4 mean?');
    });
});

describe('the sandbox', () => {
    test('the turn is handed the sandbox tools and nothing else', async () => {
        const { buildSandboxTools } = require('../../core/skills/skillSandbox');
        await runWith();
        const { tools } = lastCall('runToolLoop').args;
        assert.deepStrictEqual(
            tools.map(t => t.function.name),
            buildSandboxTools().map(t => t.function.name),
        );
        assert.ok(!tools.some(t => /compose|send|create|update|delete/.test(t.function.name)));
    });

    test('the executor it is given refuses a tool nobody has heard of', async () => {
        await runWith();
        const { executeTool } = lastCall('runToolLoop').args;
        const out = await executeTool('verzin_iets_dat_verstuurt', { to: 'x@example.com' });
        assert.match(out, /not available while testing a skill/i);
        assert.match(await executeTool('gmail_compose', {}), /not available/i);
    });

    test('the rounds are capped', async () => {
        await runWith();
        const { maxRounds } = lastCall('runToolLoop').args;
        assert.ok(maxRounds > 0 && maxRounds <= 5, `maxRounds was ${maxRounds}`);
    });

    test('only knowledge bases the CALLER may read reach the search', async () => {
        fx.kbAllowed = ['kb2'];
        await runWith();
        assert.deepStrictEqual(lastCall('usableKbIdsForRequest').args.ids.sort(), ['kb1', 'kb2']);
        const { executeTool } = lastCall('runToolLoop').args;
        // The context the executor closed over is the allowed list: with only
        // kb2 permitted, a search does not reach kb1. (The sandbox's search is
        // cut at the hook above, SANDBOX_MOCKS.)
        await executeTool('kb_search', { query: 'price' });
        assert.deepStrictEqual(lastCall('quickKBSearch').args.kbIds, ['kb2']);
    });

    test('the check is the RETRIEVAL one, never the management one', async () => {
        // `partitionAccessibleKBIds` answers "may this person manage it",
        // which is wider on three axes at once: org admins reach every base
        // in their org (drafts and group-restricted ones included), a super
        // admin's null org set reads as "every tenant", and the owner's
        // surface setting is never consulted. What a test run searches turns
        // into passages a person READS, so it takes the narrow check.
        fx.kbAllowed = ['kb2'];
        await runWith();
        assert.ok(lastCall('usableKbIdsForRequest'), 'the retrieval check ran');
        assert.strictEqual(lastCall('partitionAccessibleKBIds'), undefined, 'the management check did not');
        // And it asks the SURFACE question for the surface being rehearsed.
        assert.strictEqual(lastCall('usableKbIdsForRequest').args.opts.surface, 'direct_chat');
    });

    test('a run "as agent X" asks the agent surface, not the chat one', async () => {
        fx.published = [{ id: 'ag1', name: 'A', owner_id: 'other' }];
        fx.runtimeAgent = { id: 'ag1', system_prompt: 'You are A.', model: null };
        await runWith({ question: 'q', agentId: 'ag1' });
        assert.strictEqual(lastCall('usableKbIdsForRequest').args.opts.surface, 'agent');
    });

    test('a KB authorisation failure REFUSES the run — it does not quietly search nothing', async () => {
        // Fail-closed was already right; silent was not. An empty id list
        // reached the model as "this skill has no knowledge base linked",
        // which is a claim about the SKILL. The model then answered from the
        // skill text, the grader found no evidence for the step that says
        // "look it up", and that verdict was STORED against the skill.
        fx.kbThrows = true;
        const res = await runWith();
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.code, 'kb_check_failed');
        assert.strictEqual(res.headers, null, 'refused before the stream opened');
        assert.strictEqual(lastCall('runToolLoop'), undefined, 'no turn was bought');
        assert.strictEqual(fx.recorded.length, 0, 'and no verdict was written');
    });

    test('a skill that links NO knowledge base is not refused', async () => {
        // The refusal is about a check that could not run, not about a skill
        // that simply has no bases.
        fx.skill = SKILL({ knowledgeBaseIds: [], steps: [{ id: 'st1', text: 'Read the quote', refs: [] }, { id: 'st2', text: 'Explain every line', refs: [] }] });
        const res = await runWith();
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(lastCall('usableKbIdsForRequest'), undefined, 'nothing declared, nothing to check');
        const { executeTool } = lastCall('runToolLoop').args;
        assert.match(await executeTool('kb_search', { query: 'price' }), /no knowledge base linked/i);
    });

    test('bases the caller may not read are said out loud, not passed off as "none linked"', async () => {
        fx.kbAllowed = [];              // both declared ids denied
        const res = await runWith();
        assert.strictEqual(res.statusCode, 200);
        const notice = res.event('notice');
        assert.strictEqual(notice.code, 'kb_dropped');
        assert.strictEqual(notice.declared, 2);
        assert.strictEqual(notice.used, 0);
        const { executeTool } = lastCall('runToolLoop').args;
        const out = await executeTool('kb_search', { query: 'price' });
        assert.doesNotMatch(out, /no knowledge base linked/i, 'that would be a claim about the skill');
        assert.match(out, /not available to the person running this test/i);
    });

    test('a PARTIAL refusal is said out loud too', async () => {
        fx.kbAllowed = ['kb2'];         // kb1 declared, denied
        const res = await runWith();
        assert.strictEqual(res.event('notice').used, 1);
        assert.strictEqual(res.event('notice').declared, 2);
        const { executeTool } = lastCall('runToolLoop').args;
        const path = require.resolve('../../core/agentRuntime/knowledgeSearch');
        const saved = require.cache[path];
        require.cache[path] = {
            id: path, filename: path, loaded: true,
            exports: { quickKBSearch: async () => [] },
        };
        try {
            assert.match(await executeTool('kb_search', { query: 'price' }), /1 of the 2 knowledge bases/i);
        } finally {
            if (saved) require.cache[path] = saved; else delete require.cache[path];
        }
    });

    test('a clean run says nothing about knowledge bases', async () => {
        fx.kbAllowed = ['kb1', 'kb2'];
        const res = await runWith();
        assert.strictEqual(res.event('notice'), undefined);
    });
});

describe('the agent the test runs as', () => {
    const AGENT = { id: 'ag1', name: 'Quote assistant', owner_id: 'someone-else', description: '' };

    test('an agent that is not in the caller\'s list is a 404 — and costs nothing', async () => {
        fx.published = [];
        fx.own = [];
        const res = await runWith({ question: 'q', agentId: 'ag-someone-elses' });
        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.code, 'agent_not_found');
        assert.strictEqual(lastCall('getForRuntime'), undefined, 'never loaded, so never a system prompt');
        assert.strictEqual(lastCall('runToolLoop'), undefined);
        assert.strictEqual(fx.recorded.length, 0);
    });

    test('a published agent the caller may see is allowed, and its prompt is used', async () => {
        fx.published = [AGENT];
        fx.runtimeAgent = { id: 'ag1', name: 'Quote assistant', system_prompt: 'You are Ada.', model: 'tier:balanced' };
        const res = await runWith({ question: 'q', agentId: 'ag1' });
        assert.strictEqual(res.statusCode, 200);
        const { messages } = lastCall('runToolLoop').args;
        assert.ok(messages[0].content.startsWith('You are Ada.'));
        assert.strictEqual(fx.recorded[0].agentId, 'ag1');
    });

    test('the caller\'s OWN unpublished agent is allowed', async () => {
        fx.own = [{ id: 'draft1', name: 'My draft', owner_id: 'owner' }];
        fx.runtimeAgent = { id: 'draft1', system_prompt: 'draft prompt', model: null };
        const res = await runWith({ question: 'q', agentId: 'draft1' });
        assert.strictEqual(res.statusCode, 200);
    });

    test('a failure to resolve the list REFUSES the run', async () => {
        fx.agentsThrow = new Error('agents table down');
        const res = await runWith({ question: 'q', agentId: 'ag1' });
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.code, 'agent_check_failed');
        assert.strictEqual(lastCall('runToolLoop'), undefined);
    });

    test('the agent\'s own model is what runs; the grading stays on the fast tier', async () => {
        fx.published = [AGENT];
        fx.runtimeAgent = { id: 'ag1', system_prompt: '', model: 'tier:balanced' };
        await runWith({ question: 'q', agentId: 'ag1' });
        const tiers = fx.calls.filter(c => c.name === 'resolveModelForTier').map(c => c.args.raw);
        assert.deepStrictEqual(tiers, ['tier:balanced', 'tier:fast']);
    });
});

describe('nothing to grade is refused, never graded green', () => {
    test('no question is a 400 before anything is loaded', async () => {
        const res = await runWith({ question: '   ' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.code, 'no_question');
        assert.strictEqual(lastCall('getSkill'), undefined);
    });

    test('a skill the caller cannot see is a 404', async () => {
        fx.skill = null;
        const res = await runWith();
        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(fx.recorded.length, 0);
    });

    test('a skill with a name and nothing else is 400 empty_skill', async () => {
        fx.skill = SKILL({ instructions: '', workflow: '', rules: '', examples: '', steps: [], rulesV2: [], examplesV2: [] });
        const res = await runWith();
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.code, 'empty_skill');
        assert.strictEqual(lastCall('runToolLoop'), undefined);
    });

    test('a skill with a body but no steps is 400 no_steps', async () => {
        fx.skill = SKILL({ steps: [], workflow: '' });
        const res = await runWith();
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.code, 'no_steps');
        assert.strictEqual(fx.recorded.length, 0);
    });

    test('no model configured is 503, not a 500', async () => {
        fx.model = null;
        const res = await runWith();
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.code, 'no_model');
    });

    test('an empty answer is an error event and NO run row', async () => {
        fx.answer = '   ';
        const res = await runWith();
        assert.strictEqual(res.event('error').code, 'no_answer');
        assert.strictEqual(lastCall('chatForcedTool'), undefined, 'nothing to grade, so nothing is spent grading');
        assert.strictEqual(fx.recorded.length, 0);
    });

    test('grading that lands on no real step writes NO row', async () => {
        fx.grading = { steps: [{ stepId: 'from-another-skill', status: 'ok', evidence: 'x' }] };
        const res = await runWith();
        assert.strictEqual(res.event('error').code, 'grading_failed');
        assert.strictEqual(fx.recorded.length, 0);
        assert.strictEqual(res.event('done'), undefined);
    });

    test('a grader that reported on one step of two does not produce a green run', async () => {
        fx.grading = { steps: [{ stepId: 'st1', status: 'ok', evidence: 'yes' }] };
        await runWith();
        const row = fx.recorded[0];
        assert.strictEqual(row.status, 'warning');
        assert.strictEqual(row.results[1].status, 'warning');
        assert.match(row.results[1].evidence, /Not assessed/i);
    });

    test('a failure AFTER the headers travels as an event, not as a dead stream', async () => {
        // Mutate the object the ROUTE is given, not a fresh `require` of the
        // real module: this test used to do the latter and prove nothing —
        // the throw landed on a module nobody called, and the run went red
        // only because the real database it dragged in refused a connection.
        const client = MOCKS['../../core/llm/llmClient'];
        const real = client.chatForcedTool;
        client.chatForcedTool = async () => { throw new Error('provider exploded'); };
        try {
            const res = await runWith();
            assert.strictEqual(res.statusCode, 200, 'the headers were already out');
            assert.strictEqual(res.event('answer').text, fx.answer, 'the turn itself succeeded');
            assert.strictEqual(res.event('error').code, 'test_failed');
            assert.ok(res.writableEnded);
            assert.strictEqual(fx.recorded.length, 0);
        } finally {
            client.chatForcedTool = real;
        }
    });
});

describe('who may spend a run', () => {
    test('a skill this account may see but not edit is 403 not_editable, and costs nothing', async () => {
        // Shared through groups ⇒ visible, not editable. A run bills two model
        // calls to the workspace and writes a `skill_test_runs` row the OWNER
        // reads as a verdict, carrying the stranger's question. `improve`
        // already refuses this; the two write paths answer the same.
        fx.skill = SKILL({ canEdit: false });
        const res = await runWith();
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.body.code, 'not_editable');
        assert.strictEqual(lastCall('runToolLoop'), undefined, 'no turn was bought');
        assert.strictEqual(lastCall('chatForcedTool'), undefined, 'no grading was bought');
        assert.strictEqual(lastCall('recordTestRun'), undefined);
        assert.strictEqual(fx.recorded.length, 0);
        assert.strictEqual(res.headers, null, 'refused before the stream opened');
    });
});

// ── BFSF-354: the Privacy Shield tool block lists ──────────────────
//
// A test turn rehearses the real one, and the real one refuses a tool whose
// arguments carry an "Own server" category and strips those categories out of
// what the model reads. The real gate runs with its detector injected; its
// tool-class rules are faked here because the real ones read the config
// store, which this file must never load (see the last describe). Synthetic
// data.
describe('the Privacy Shield tool block lists (BFSF-354)', () => {
    const toolPiiGate = require('../../core/privacy/toolPiiGate');
    const SYNTH_EMAIL = 'someone@example.test';
    const OWN_SERVER_EMAIL = {
        enabled: true,
        privacyAction: 'redact',
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
    };
    const realDeps = { ...toolPiiGate._deps };
    beforeEach(() => {
        toolPiiGate._deps.detectPii = async (text, categories) => {
            const i = String(text).indexOf(SYNTH_EMAIL);
            if (i < 0 || !categories.includes('Email')) return { hasPii: false, entities: [] };
            return { hasPii: true, entities: [{ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: i, length: SYNTH_EMAIL.length }] };
        };
        toolPiiGate._deps.orgShield = () => ({
            classifyToolClass: () => 'internal',
            isBlockedForTool: (name, cats, policy) => {
                const hits = [...new Set(cats)].filter(c => (policy?.internal?.blockCategories || []).includes(c));
                return { blocked: hits.length > 0, blockedCategories: hits, toolClass: 'internal' };
            },
        });
        fx.kbAllowed = ['kb2'];
    });
    test.after(() => Object.assign(toolPiiGate._deps, realDeps));

    /** The executor the turn handed to the tool loop. */
    async function executorOfATurn() {
        await runWith();
        return lastCall('runToolLoop').args.executeTool;
    }

    test('a knowledge search whose query carries a blocked category is refused, never run', async () => {
        fx.shield = OWN_SERVER_EMAIL;
        const execute = await executorOfATurn();
        const out = await execute('kb_search', { query: `mail from ${SYNTH_EMAIL}` });
        assert.match(out, /was not called: its arguments contained Email Address/);
        assert.strictEqual(lastCall('quickKBSearch'), undefined, 'the search must not run');
        assert.strictEqual(fx.guardrailRows.length, 1);
        assert.strictEqual(fx.guardrailRows[0].action_taken, 'tool_blocked');
        assert.strictEqual(fx.guardrailRows[0].source, 'skill_test');
    });

    test('a passage with a blocked category is stripped before the model reads it', async () => {
        fx.shield = OWN_SERVER_EMAIL;
        fx.passages = [{ title: 'Contacts', content: `billing: ${SYNTH_EMAIL}` }];
        const execute = await executorOfATurn();
        const out = await execute('kb_search', { query: 'billing contact' });
        assert.ok(lastCall('quickKBSearch'), 'the search ran');
        assert.ok(!out.includes(SYNTH_EMAIL), 'the model still reads the blocked value');
        assert.match(out, /\[blocked:email\]/);
    });

    test('no shield: the search runs and the passage is untouched', async () => {
        fx.passages = [{ title: 'Contacts', content: `billing: ${SYNTH_EMAIL}` }];
        const execute = await executorOfATurn();
        const out = await execute('kb_search', { query: `mail from ${SYNTH_EMAIL}` });
        assert.ok(out.includes(SYNTH_EMAIL));
        assert.deepStrictEqual(fx.guardrailRows, []);
    });
});

describe('the require hook covers this file too', () => {
    test('no real llmClient, aiAgent or config store was ever loaded', () => {
        // The regression guard for the hang. A `require` from the test file
        // itself used to miss the parent-keyed hook and pull the real LLM
        // client → aiAgent → configStore, whose LISTEN/NOTIFY reconnect loop
        // holds the event loop open for ever. This goes red the moment one of
        // them is back in the process.
        const forbidden = [
            /core[\\/]llm[\\/]llmClient\.js$/,
            /core[\\/]aiAgent\.js$/,
            /stores[\\/]configStore\.js$/,
        ];
        const loaded = Object.keys(require.cache);
        for (const pattern of forbidden) {
            const hit = loaded.filter(p => pattern.test(p));
            assert.deepStrictEqual(hit, [], `a real module matching ${pattern} was loaded`);
        }
    });
});

describe('GET /api/skills/test-agents', () => {
    test('published + own, deduped, without the internal agents', async () => {
        fx.published = [{ id: 'ag1', name: 'Quote assistant', owner_id: 'other' }];
        fx.own = [
            { id: 'ag1', name: 'Quote assistant', owner_id: 'other' },
            { id: 'draft1', name: 'A draft', owner_id: 'owner' },
            { id: 'sys', name: 'Title generator', owner_id: 'system' },
            { id: 'sw', name: 'Swarm worker', owner_id: 'swarm' },
        ];
        const res = makeRes();
        await route.listAgents(makeReq(), res);
        assert.deepStrictEqual(res.body.agents.map(a => a.id), ['draft1', 'ag1']);
    });

    test('a failed read is a 500, never an empty picker', async () => {
        fx.agentsThrow = new Error('down');
        const res = makeRes();
        await route.listAgents(makeReq(), res);
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.agents, undefined);
    });

    test('the picker list and the authorisation are the same function', async () => {
        fx.published = [{ id: 'ag1', name: 'A', owner_id: 'other' }];
        fx.runtimeAgent = { id: 'ag1', system_prompt: '', model: null };
        const permitted = await route.testableAgents(makeReq());
        assert.deepStrictEqual(permitted.map(a => a.id), ['ag1']);
        const res = await runWith({ question: 'q', agentId: 'ag1' });
        assert.strictEqual(res.statusCode, 200);
    });
});
