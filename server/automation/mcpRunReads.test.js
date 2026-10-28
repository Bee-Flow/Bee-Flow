// @typecheck
/**
 * Read-only run inspection over MCP: shapes by default, protected values by
 * default, raw values only with the organisation's setting (and then audited),
 * the same ownership scope as the other tools of the surface, file metadata
 * only. Synthetic data throughout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeRunReads, RUN_READ_TOOLS, guideSection, _test } = require('./mcpRunReads');

const OWNER = 'u_owner';
const ORG = 'org_a';
const SECRET_TEXT = 'zz-sample-value-4711';
const OTHER_TEXT = 'ordinary text with several words';

const run = (over = {}) => ({
    id: 'run_1', automationId: 'auto_1', userId: OWNER, version: 3, triggerKind: 'webhook', mode: 'live',
    status: 'success', startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:02.000Z',
    durationMs: 2000, rootRunId: 'run_1', connectionsMode: null, startedByUserId: OWNER, ...over,
});

const step = (over = {}) => ({
    runId: 'run_1', stepId: 's1', parentStepId: null, stepType: 'set', attempts: 1, status: 'success',
    startedAt: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T10:00:01.000Z', error: null, errorClass: null,
    input: { id: 17, label: SECRET_TEXT },
    output: {
        items: [
            { name: SECRET_TEXT, qty: 3, ref: '[person_1]', flag: true },
            { name: OTHER_TEXT, qty: 5, extra: null },
        ],
        total: 8,
    },
    ...over,
});

/** A fake store holding one automation, one run and its steps. */
function world({ automationOwner = OWNER, automationOrg = ORG, runOver = {}, steps = [step()], files = [] } = {}) {
    const calls = { audit: [], config: new Map(), listFilters: null, fileRunIds: null };
    const runs = new Map([['run_1', run(runOver)]]);
    const store = {
        getAutomation: async (id) => (id === 'auto_1' ? { id, userId: automationOwner, organizationId: automationOrg } : null),
        getRun: async (id) => runs.get(id) || null,
        getRunsInChain: async (id) => (runs.has(id) ? [runs.get(id)] : []),
        getRunStepsForChain: async () => steps,
        getRunFullOutput: async () => null,
        listRunsForAutomation: async (id, filters) => {
            calls.listFilters = { id, ...filters };
            return {
                runs: [
                    { ...run(), error: null },
                    { ...run({ id: 'run_2', status: 'error', errorClass: 'tool_error' }), error: 'Request failed with Bearer abcdefgh12345678 in header' },
                ],
                nextCursor: 'cur_2',
            };
        },
        listGeneratedFilesForRuns: async (ids) => { calls.fileRunIds = ids; return files; },
    };
    const reads = makeRunReads({
        store,
        getUser: async (id) => (id === OWNER ? { id, organizationId: ORG } : { id, organizationId: 'org_b' }),
        getConfig: async (key) => calls.config.get(key) ?? null,
        setConfig: async (key, value) => { calls.config.set(key, value); },
        audit: async (...args) => { calls.audit.push(args); },
    });
    return { reads, calls, runs };
}

const allowRaw = (calls) => calls.config.set(_test.rawPolicyKey(ORG), { rawReadsAllowed: true });

// ── tool surface ───────────────────────────────────────────────────────────

test('the four run tools are read-only descriptors with the documented inputs', () => {
    assert.deepEqual(RUN_READ_TOOLS.map((t) => t.name), [
        'automations_list_runs', 'automations_get_run_steps', 'automations_get_step_output', 'automations_list_run_files',
    ]);
    const out = RUN_READ_TOOLS.find((t) => t.name === 'automations_get_step_output');
    assert.deepEqual(out.parameters.required, ['runId', 'stepId']);
    assert.ok(out.parameters.properties.raw && out.parameters.properties.path);
    assert.match(guideSection(), /automations_get_step_output/);
});

// ── automations_list_runs ──────────────────────────────────────────────────

test('list_runs: id, status, timing, version, trigger kind; the error summary is credential-masked; filters are forwarded', async () => {
    const { reads, calls } = world();
    const res = await reads.call('automations_list_runs', { automationId: 'auto_1', limit: 5, status: 'error' }, { userId: OWNER });
    assert.equal(res.runs.length, 2);
    assert.deepEqual(Object.keys(res.runs[0]).sort(), [
        'durationMs', 'errorClass', 'errorSummary', 'finishedAt', 'isTest', 'journeyRunId', 'mode', 'runId', 'startedAt', 'status', 'triggerKind', 'version',
    ]);
    assert.equal(res.runs[0].version, 3);
    assert.equal(res.runs[0].triggerKind, 'webhook');
    assert.ok(!res.runs[1].errorSummary.includes('abcdefgh12345678'));
    assert.match(res.runs[1].errorSummary, /redacted/);
    assert.equal(res.nextCursor, 'cur_2');
    assert.equal(calls.listFilters.id, 'auto_1');
    assert.equal(calls.listFilters.status, 'error');
    assert.equal(calls.listFilters.limit, 5);
});

test('list_runs: the page size is capped by AUTOMATION_MCP_RUN_LIST_MAX, 0 lifts the cap', async () => {
    const prev = process.env.AUTOMATION_MCP_RUN_LIST_MAX;
    try {
        process.env.AUTOMATION_MCP_RUN_LIST_MAX = '10';
        const a = world();
        await a.reads.call('automations_list_runs', { automationId: 'auto_1', limit: 500 }, { userId: OWNER });
        assert.equal(a.calls.listFilters.limit, 10);
        process.env.AUTOMATION_MCP_RUN_LIST_MAX = '0';
        const b = world();
        await b.reads.call('automations_list_runs', { automationId: 'auto_1', limit: 500 }, { userId: OWNER });
        assert.equal(b.calls.listFilters.limit, 500);
    } finally {
        if (prev === undefined) delete process.env.AUTOMATION_MCP_RUN_LIST_MAX; else process.env.AUTOMATION_MCP_RUN_LIST_MAX = prev;
    }
});

// ── automations_get_run_steps: shape only ───────────────────────────────────

test('get_run_steps: the shape and counts of input and output, never a value', async () => {
    const { reads } = world();
    const res = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
    assert.equal(res.stepCount, 1);
    const s = res.steps[0];
    assert.equal(s.stepId, 's1');
    assert.equal(s.type, 'set');
    assert.equal(s.status, 'success');
    assert.equal(s.durationMs, 1000);

    const out = s.output.shape;
    assert.equal(out.type, 'object');
    assert.equal(out.keys.items.type, 'array');
    assert.equal(out.keys.items.length, 2);
    assert.equal(out.keys.items.items.keys.name.type, 'string');
    assert.equal(out.keys.items.items.keys.qty.type, 'number');
    // Optional keys of other list elements are merged in, and a null merges as mixed.
    assert.ok(out.keys.items.items.keys.extra);
    assert.equal(out.keys.total.type, 'number');
    assert.equal(s.output.counts.arrays, 1);
    assert.equal(s.output.counts.strings, 3);

    const wire = JSON.stringify(res);
    assert.ok(!wire.includes(SECRET_TEXT), 'no string value in the answer');
    assert.ok(!wire.includes(OTHER_TEXT));
    assert.ok(!wire.includes('[person_1]'));
});

test('get_run_steps: a truncated output reports its size and whether a full copy is kept, not the head sample', async () => {
    const sentinel = {
        __truncated__: true, originalBytes: 900000, headSample: SECRET_TEXT,
        preview: { rows: [{ id: 1 }] }, previewCut: { '$.rows': 5000 },
        fullOutputRef: { runId: 'run_1', stepId: 's1', attempts: 1 },
    };
    const { reads } = world({ steps: [step({ output: sentinel })] });
    const res = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
    const out = res.steps[0].output;
    assert.equal(out.truncated, true);
    assert.equal(out.originalBytes, 900000);
    assert.equal(out.fullCopyKept, true);
    assert.ok(!JSON.stringify(res).includes(SECRET_TEXT));
});

test('get_run_steps: a failed step carries its masked error; the step list is capped by AUTOMATION_MCP_RUN_STEPS_MAX', async () => {
    const prev = process.env.AUTOMATION_MCP_RUN_STEPS_MAX;
    try {
        const failed = step({ stepId: 's2', status: 'error', errorClass: 'tool_error', error: 'Upstream said no (Bearer abcdefgh12345678)' });
        const { reads } = world({ steps: [step(), failed, step({ stepId: 's3' })] });
        let res = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
        assert.equal(res.steps[1].errorClass, 'tool_error');
        assert.ok(!res.steps[1].error.includes('abcdefgh12345678'));

        process.env.AUTOMATION_MCP_RUN_STEPS_MAX = '2';
        res = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
        assert.equal(res.steps.length, 2);
        assert.equal(res.stepsOmitted, 1);
        process.env.AUTOMATION_MCP_RUN_STEPS_MAX = '0';
        res = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
        assert.equal(res.steps.length, 3);
    } finally {
        if (prev === undefined) delete process.env.AUTOMATION_MCP_RUN_STEPS_MAX; else process.env.AUTOMATION_MCP_RUN_STEPS_MAX = prev;
    }
});

// ── automations_get_step_output: protected by default ───────────────────────

test('get_step_output: structure kept, strings and numbers become typed placeholders, a Shield token stays', async () => {
    const { reads, calls } = world();
    const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1' }, { userId: OWNER });
    assert.equal(res.mode, 'protected');
    assert.deepEqual(res.value, {
        items: [
            { name: `«string:${SECRET_TEXT.length}»`, qty: '«number»', ref: '[person_1]', flag: true },
            { name: `«string:${OTHER_TEXT.length}»`, qty: '«number»', extra: null },
        ],
        total: '«number»',
    });
    assert.ok(!JSON.stringify(res).includes(SECRET_TEXT));
    assert.equal(calls.audit.length, 0, 'a protected read is not a raw read');
});

test('get_step_output: path narrows the answer; a path with nothing there is a described 404', async () => {
    const { reads } = world();
    const ok = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path: 'items[0].name' }, { userId: OWNER });
    assert.equal(ok.value, `«string:${SECRET_TEXT.length}»`);
    assert.equal(ok.path, 'items[0].name');
    const missing = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path: 'nope.nothing' }, { userId: OWNER });
    assert.equal(missing.code, 'path_not_found');
});

test('get_step_output: an unknown step is a described 404', async () => {
    const { reads } = world();
    const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 'ghost' }, { userId: OWNER });
    assert.equal(res.code, 'step_not_found');
});

test('get_step_output: an over-sized answer is cut to a preview with the original size', async () => {
    const prev = process.env.AUTOMATION_MCP_RUN_READ_MAX_BYTES;
    try {
        process.env.AUTOMATION_MCP_RUN_READ_MAX_BYTES = '600';
        const big = { rows: Array.from({ length: 400 }, (_, i) => ({ n: i, label: `label-${i}` })) };
        const { reads } = world({ steps: [step({ output: big })] });
        const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1' }, { userId: OWNER });
        assert.ok(res.truncated.originalBytes > 600);
        assert.ok(Array.isArray(res.value.rows) && res.value.rows.length < 400);
    } finally {
        if (prev === undefined) delete process.env.AUTOMATION_MCP_RUN_READ_MAX_BYTES; else process.env.AUTOMATION_MCP_RUN_READ_MAX_BYTES = prev;
    }
});

// ── raw values: the organisation setting and the ledger ─────────────────────

test('raw: refused while the organisation setting is off (the default), with no data and no ledger row', async () => {
    const { reads, calls } = world();
    const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', raw: true }, { userId: OWNER });
    assert.equal(res.code, 'raw_run_data_disabled');
    assert.ok(!JSON.stringify(res).includes(SECRET_TEXT));
    assert.equal(calls.audit.length, 0);
});

test('raw: a setting that is anything but an explicit true stays off, and an unreadable setting fails closed', async () => {
    for (const stored of [{ rawReadsAllowed: 'yes' }, { rawReadsAllowed: 1 }, {}, 'not json']) {
        const { reads, calls } = world();
        calls.config.set(_test.rawPolicyKey(ORG), stored);
        assert.equal(await reads.rawReadsAllowed(ORG), false, JSON.stringify(stored));
    }
    const failing = makeRunReads({ getConfig: async () => { throw new Error('db down'); } });
    assert.equal(await failing.rawReadsAllowed(ORG), false);
});

test('raw: allowed by the setting returns real values and writes one ledger row without values', async () => {
    const { reads, calls } = world();
    allowRaw(calls);
    const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path: 'items[0]', raw: true }, { userId: OWNER });
    assert.equal(res.mode, 'raw');
    assert.equal(res.value.name, SECRET_TEXT);
    assert.equal(res.value.qty, 3);

    assert.equal(calls.audit.length, 1);
    const [action, targetType, targetId, actor, before, after, orgId] = calls.audit[0];
    assert.equal(action, 'mcp.automation_run_data.read');
    assert.equal(targetType, 'automation_run_step');
    assert.equal(targetId, 'run_1/s1');
    assert.equal(actor, OWNER);
    assert.equal(before, null);
    assert.equal(orgId, ORG);
    assert.equal(after.path, 'items[0]');
    assert.equal(after.automationId, 'auto_1');
    assert.ok(after.bytes > 0);
    assert.ok(!JSON.stringify(calls.audit[0]).includes(SECRET_TEXT), 'the ledger holds what was read, not the values');
});

test('raw: credentials the run log masks stay masked in a raw read', async () => {
    const out = { header: 'Authorization failed for Bearer abcdefgh12345678', password: 'hunter2hunter2' };
    const { reads, calls } = world({ steps: [step({ output: out })] });
    allowRaw(calls);
    const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', raw: true }, { userId: OWNER });
    assert.ok(!JSON.stringify(res).includes('abcdefgh12345678'));
    assert.ok(!JSON.stringify(res).includes('hunter2hunter2'));
});

test('raw: no ledger row, no data', async () => {
    const reads = makeRunReads({
        store: {
            getAutomation: async (id) => ({ id, userId: OWNER, organizationId: ORG }),
            getRun: async () => run(),
            getRunsInChain: async () => [run()],
            getRunStepsForChain: async () => [step()],
            getRunFullOutput: async () => null,
        },
        getUser: async () => ({ id: OWNER, organizationId: ORG }),
        getConfig: async () => ({ rawReadsAllowed: true }),
        audit: async () => { throw new Error('ledger unavailable'); },
    });
    const res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', raw: true }, { userId: OWNER });
    assert.equal(res.code, 'audit_unavailable');
    assert.ok(!JSON.stringify(res).includes(SECRET_TEXT));
});

test('the setting is written under the organisation and audited', async () => {
    const { reads, calls } = world();
    assert.deepEqual(await reads.setRawReadsAllowed(ORG, true, 'u_admin'), { rawReadsAllowed: true });
    assert.deepEqual(calls.config.get(_test.rawPolicyKey(ORG)), { rawReadsAllowed: true });
    assert.equal(await reads.rawReadsAllowed(ORG), true);
    assert.equal(calls.audit[0][0], 'mcp.automation_run_data.policy');
    assert.deepEqual(calls.audit[0][4], { rawReadsAllowed: false });
    assert.deepEqual(calls.audit[0][5], { rawReadsAllowed: true });
});

// ── scope ───────────────────────────────────────────────────────────────────

test('a run of somebody else\'s automation answers 404, exactly like a run that does not exist', async () => {
    const { reads } = world({ automationOwner: 'u_other' });
    const foreign = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
    const missing = await reads.call('automations_get_run_steps', { runId: 'run_999' }, { userId: OWNER });
    assert.equal(foreign.code, 'not_found');
    assert.deepEqual(foreign, missing);
    for (const name of ['automations_get_step_output', 'automations_list_run_files']) {
        const res = await reads.call(name, { runId: 'run_1', stepId: 's1' }, { userId: OWNER });
        assert.equal(res.code, 'not_found', name);
    }
});

test('a cross-organisation run answers 404 even when the user column names the caller', async () => {
    const { reads } = world({ automationOrg: 'org_b' });
    for (const name of ['automations_get_run_steps', 'automations_get_step_output', 'automations_list_run_files']) {
        const res = await reads.call(name, { runId: 'run_1', stepId: 's1' }, { userId: OWNER });
        assert.equal(res.code, 'not_found', name);
    }
    const list = await reads.call('automations_list_runs', { automationId: 'auto_1' }, { userId: OWNER });
    assert.equal(list.code, 'not_found');
});

test('a run id of another user\'s automation cannot be listed through automations_list_runs either', async () => {
    const { reads, calls } = world({ automationOwner: 'u_other' });
    const res = await reads.call('automations_list_runs', { automationId: 'auto_1' }, { userId: OWNER });
    assert.equal(res.code, 'not_found');
    assert.equal(calls.listFilters, null, 'the run list is never queried');
});

test('a run that used its starter\'s own connections hides its data from everybody else', async () => {
    const { reads, calls } = world({ runOver: { connectionsMode: 'caller', startedByUserId: 'u_starter' } });
    allowRaw(calls);
    const steps = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
    assert.equal(steps.steps[0].dataHidden, true);
    assert.equal(steps.steps[0].input, undefined);
    assert.equal(steps.steps[0].output, undefined);
    for (const args of [{ stepId: 's1' }, { stepId: 's1', raw: true }]) {
        const out = await reads.call('automations_get_step_output', { runId: 'run_1', ...args }, { userId: OWNER });
        assert.equal(out.code, 'caller_run_private');
    }
    const files = await reads.call('automations_list_run_files', { runId: 'run_1' }, { userId: OWNER });
    assert.equal(files.code, 'caller_run_private');
    assert.equal(calls.audit.length, 0);
});

test('bad input is a described 400, not a throw', async () => {
    const { reads } = world();
    assert.equal((await reads.call('automations_get_run_steps', {}, { userId: OWNER })).code, 'invalid_run_id');
    assert.equal((await reads.call('automations_get_step_output', { runId: 'run_1' }, { userId: OWNER })).code, 'invalid_step_id');
    assert.equal((await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path: 'x'.repeat(600) }, { userId: OWNER })).code, 'invalid_path');
});

// ── automations_list_run_files ──────────────────────────────────────────────

test('list_run_files: metadata only, from an allow-list of fields, never bytes or the storage key', async () => {
    const file = {
        id: 'f1', runId: 'run_1', automationId: 'auto_1', stepId: 's1', storageKey: 'blob/secret-path/xyz',
        filename: 'report.pdf', mimeType: 'application/pdf', size: 2048, createdAt: '2026-01-01T10:00:01.000Z',
        expiresAt: '2026-01-08T10:00:01.000Z', data: Buffer.from('file bytes'), content: 'file bytes',
    };
    const { reads, calls } = world({ files: [file] });
    const res = await reads.call('automations_list_run_files', { runId: 'run_1' }, { userId: OWNER });
    assert.deepEqual(calls.fileRunIds, ['run_1']);
    assert.deepEqual(res.files, [{
        fileId: 'f1', name: '«name:6».pdf', mime: 'application/pdf', size: 2048, stepId: 's1', runId: 'run_1',
        createdAt: '2026-01-01T10:00:01.000Z', expiresAt: '2026-01-08T10:00:01.000Z',
    }]);
    const wire = JSON.stringify(res);
    assert.ok(!wire.includes('secret-path') && !wire.includes('file bytes') && !wire.includes('storageKey'));
});

test('list_run_files: the list is capped by AUTOMATION_MCP_RUN_FILES_MAX', async () => {
    const prev = process.env.AUTOMATION_MCP_RUN_FILES_MAX;
    try {
        process.env.AUTOMATION_MCP_RUN_FILES_MAX = '1';
        const mk = (id) => ({ id, runId: 'run_1', filename: `${id}.txt`, mimeType: 'text/plain', size: 1 });
        const { reads } = world({ files: [mk('a'), mk('b')] });
        const res = await reads.call('automations_list_run_files', { runId: 'run_1' }, { userId: OWNER });
        assert.equal(res.files.length, 1);
        assert.equal(res.filesOmitted, 1);
    } finally {
        if (prev === undefined) delete process.env.AUTOMATION_MCP_RUN_FILES_MAX; else process.env.AUTOMATION_MCP_RUN_FILES_MAX = prev;
    }
});

test('list_run_files: a name built from run data is not returned unless raw is allowed; the raw read is audited', async () => {
    const file = { id: 'f1', runId: 'run_1', stepId: 's1', filename: 'Sample Person 2026.pdf', mimeType: 'application/pdf', size: 1 };
    const { reads, calls } = world({ files: [file] });
    let res = await reads.call('automations_list_run_files', { runId: 'run_1' }, { userId: OWNER });
    assert.equal(res.files[0].name, '«name:18».pdf');
    assert.ok(!JSON.stringify(res).includes('Sample Person'));
    assert.equal(calls.audit.length, 0);

    res = await reads.call('automations_list_run_files', { runId: 'run_1', raw: true }, { userId: OWNER });
    assert.equal(res.code, 'raw_run_data_disabled');
    assert.ok(!JSON.stringify(res).includes('Sample Person'));

    allowRaw(calls);
    res = await reads.call('automations_list_run_files', { runId: 'run_1', raw: true }, { userId: OWNER });
    assert.equal(res.files[0].name, 'Sample Person 2026.pdf');
    assert.equal(calls.audit.length, 1);
    assert.equal(calls.audit[0][0], 'mcp.automation_run_data.read');
    assert.equal(calls.audit[0][1], 'automation_run_files');
    assert.equal(calls.audit[0][5].fileCount, 1);
    assert.ok(!JSON.stringify(calls.audit[0]).includes('Sample Person'));
});

test('errors: the default answer scrubs run values out of an error text; raw returns it, audited', async () => {
    const failed = step({
        stepId: 's2', status: 'error', errorClass: 'tool_error',
        error: 'No match for "sample.person@example.test" in "Sample Person" at https://host.example.test/a?x=1 (id 123456789, {"k":"v"})',
    });
    const stop = step({ stepId: 's3', status: 'error', errorClass: 'stop_error', error: 'Budget exceeded for Sample Person by 12' });
    const { reads, calls } = world({ steps: [step(), failed, stop] });
    let res = await reads.call('automations_get_run_steps', { runId: 'run_1' }, { userId: OWNER });
    const wire = JSON.stringify(res);
    for (const v of ['sample.person', 'Sample Person', 'host.example.test', '123456789', '"k"']) assert.ok(!wire.includes(v), v);
    assert.match(res.steps[1].error, /^No match for «string:\d+» in «string:13» at «url» \(id «number», «object»\)$/);
    assert.equal(res.steps[1].errorClass, 'tool_error');
    assert.equal(res.steps[2].error, '«message:39»');

    res = await reads.call('automations_get_run_steps', { runId: 'run_1', raw: true }, { userId: OWNER });
    assert.equal(res.code, 'raw_run_data_disabled');
    allowRaw(calls);
    res = await reads.call('automations_get_run_steps', { runId: 'run_1', raw: true }, { userId: OWNER });
    assert.match(res.steps[1].error, /Sample Person/);
    assert.equal(res.steps[2].error, 'Budget exceeded for Sample Person by 12');
    assert.equal(calls.audit.length, 1);
    assert.equal(calls.audit[0][1], 'automation_run_steps');
    assert.ok(!JSON.stringify(calls.audit[0]).includes('Sample Person'));
});

test('errors: list_runs scrubs the error summary by default and returns it raw only when allowed', async () => {
    const { reads, calls } = world();
    let res = await reads.call('automations_list_runs', { automationId: 'auto_1' }, { userId: OWNER });
    assert.match(res.runs[1].errorSummary, /^Request failed with Bearer «redacted:[a-z-]+» in header$/);
    allowRaw(calls);
    res = await reads.call('automations_list_runs', { automationId: 'auto_1', raw: true }, { userId: OWNER });
    assert.equal(res.runs.length, 2);
    assert.equal(calls.audit.length, 1);
    assert.equal(calls.audit[0][1], 'automation_runs');
});

test('valueFreeErrorLine keeps engine wording and apostrophes, and caps the length', () => {
    const f = _test.valueFreeErrorLine;
    assert.equal(f('arrayRef did not resolve to an array (resolved to nothing)', 'x', 200), 'arrayRef did not resolve to an array (resolved to nothing)');
    assert.equal(f("Field doesn't exist", 'x', 200), "Field doesn't exist");
    assert.equal(f('HTTP 404 from the server', 'x', 200), 'HTTP 404 from the server');
    assert.equal(f('a'.repeat(50), 'x', 10), `${'a'.repeat(10)}…`);
    assert.equal(f('', 'x', 10), null);
});

test('path: a match segment is refused in a protected read, allowed in a raw read, and the audit row keeps the path without the value', async () => {
    const { reads, calls } = world();
    const path = `items[name="${SECRET_TEXT}"].qty`;
    let res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path }, { userId: OWNER });
    assert.equal(res.code, 'invalid_path');
    // A probe for a value that is not there answers the same as one that is.
    res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path: 'items[name="nothing here"].qty' }, { userId: OWNER });
    assert.equal(res.code, 'invalid_path');
    // Plain paths are unaffected.
    res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path: 'items[0].qty' }, { userId: OWNER });
    assert.equal(res.value, '«number»');

    allowRaw(calls);
    res = await reads.call('automations_get_step_output', { runId: 'run_1', stepId: 's1', path, raw: true }, { userId: OWNER });
    assert.equal(res.value, 3);
    assert.equal(calls.audit.length, 1);
    assert.equal(calls.audit[0][5].path, 'items[name="«value»"].qty');
    assert.ok(!JSON.stringify(calls.audit[0]).includes(SECRET_TEXT));
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('shapeOf: a key that looks like data is not shown, and a wide object reports what it left out', () => {
    const counts = _test.newCounts();
    const shape = _test.shapeOf({ 'someone@example.test': 1, ok: 'x', a: 1, b: 2 }, { keys: 3, nodes: 0 }, counts);
    assert.equal(shape.keyCount, 4);
    assert.equal(shape.moreKeys, 1);
    assert.ok(shape.keys['«key»']);
    assert.ok(!JSON.stringify(shape).includes('someone@example.test'));
});

test('shapeOf: the node cap stops the walk and says so', () => {
    const counts = _test.newCounts();
    _test.shapeOf({ rows: Array.from({ length: 50 }, () => ({ a: 1, b: 2 })) }, { keys: 0, nodes: 10 }, counts);
    assert.equal(counts.cutOff, true);
});

test('placeholderize does not mutate its input and keeps credential markers', () => {
    const input = { a: 'text', b: ['x', 1], c: '«redacted:key»' };
    const frozen = JSON.stringify(input);
    assert.deepEqual(_test.placeholderize(input), { a: '«string:4»', b: ['«string:1»', '«number»'], c: '«redacted:key»' });
    assert.equal(JSON.stringify(input), frozen);
});

// ── group-only members ─────────────────────────────────────────────────────

function groupWorld(resolveOrgs) {
    return makeRunReads({
        store: {
            getAutomation: async (id) => ({ id, userId: OWNER, organizationId: ORG }),
            getRun: async () => run(),
            getRunsInChain: async () => [run()],
            getRunStepsForChain: async () => [step()],
            getRunFullOutput: async () => null,
            listRunsForAutomation: async () => ({ runs: [run()], nextCursor: null }),
        },
        // No home organisation: the account reaches its tenant through a group only.
        getUser: async () => ({ id: OWNER, organizationId: '', groups: ['g1'] }),
        resolveOrgs,
    });
}

test('a group-only member reads the runs of their own automation in a group org', async () => {
    const reads = groupWorld(async () => ({ primary: ORG, all: [ORG] }));
    const res = await reads.call('automations_list_runs', { automationId: 'auto_1' }, { userId: OWNER });
    assert.equal(res.code, undefined);
    assert.equal(res.runs.length, 1);
});

test('a member whose orgs do not include the automation org gets 404', async () => {
    const reads = groupWorld(async () => ({ primary: 'org_x', all: ['org_x'] }));
    const res = await reads.call('automations_list_runs', { automationId: 'auto_1' }, { userId: OWNER });
    assert.equal(res.code, 'not_found');
});

test('an org resolution that throws denies', async () => {
    const reads = groupWorld(async () => { throw new Error('groups unreadable'); });
    const res = await reads.call('automations_list_runs', { automationId: 'auto_1' }, { userId: OWNER });
    assert.equal(res.code, 'not_found');
});
